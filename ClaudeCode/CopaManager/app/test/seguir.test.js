// Seguir Campeonatos (RN-SG): fluxo HTTP (seguir/deixar de seguir, secao
// "Seguindo", estado do botao, contagem so para o dono) + limite de 40 seguidos.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { prepararBanco } from '../db/db.js';
import { montarRotas } from '../routes/api.js';
import { configurarTransporte } from '../src/email.js';
import { seguir, LIMITE_SEGUIDOS } from '../src/seguidores.js';

let servidor;
let base;
let bancoTeste;

const emails = [];
configurarTransporte(async (m) => { emails.push(m); });
const tokenDoUltimoEmail = (para) =>
  [...emails].reverse().find((e) => e.para === para.toLowerCase())?.texto.match(/token=([0-9a-f]+)/)?.[1];

async function registrarEntrar(c, { nome, email, senha }) {
  const reg = await c('POST', '/api/auth/registrar', { nome, email, senha, consentimento: true });
  assert.equal(reg.status, 201, JSON.stringify(reg.corpo));
  const conf = await c('POST', '/api/auth/confirmar-email', { token: tokenDoUltimoEmail(email) });
  assert.equal(conf.status, 200, JSON.stringify(conf.corpo));
  return bancoTeste.prepare('SELECT id, nome, email FROM contas WHERE email = ?').get(email.toLowerCase());
}

function montarApp() {
  const db = prepararBanco(':memory:');
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', montarRotas(db, {
    limites: {
      login: { max: 1000 }, registro: { max: 1000 },
      confirmacao: { max: 1000 }, reenvio: { max: 1000 },
      recuperacao: { max: 1000 }, redefinicao: { max: 1000 },
      convite: { max: 1000 }, seguir: { max: 1000 },
    },
  }));
  app.use((err, req, res, _next) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ erro: err.name ?? 'Erro', mensagem: err.message });
  });
  return { app, db };
}

before(async () => {
  const { app, db } = montarApp();
  bancoTeste = db;
  servidor = app.listen(0);
  await new Promise((r) => servidor.on('listening', r));
  base = `http://localhost:${servidor.address().port}`;
});

after(() => servidor.close());

function cliente() {
  let cookie = '';
  return async (metodo, caminho, corpo) => {
    const resp = await fetch(base + caminho, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    const setCookie = resp.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: resp.status, corpo: await resp.json().catch(() => ({})) };
  };
}

test('seguir: fluxo completo (seguir, listar, estado, deixar de seguir)', async () => {
  const alice = cliente();
  const bob = cliente();
  await registrarEntrar(alice, { nome: 'Alice', email: 'alice-sg@teste.com', senha: 'segredo1' });
  await registrarEntrar(bob, { nome: 'Bob', email: 'bob-sg@teste.com', senha: 'segredo1' });

  const criado = await alice('POST', '/api/campeonatos', {
    nome: 'Copa do Bairro', temporada: '2026', formato: 'pontos', sortear: false,
    times: ['Aguia', 'Bufalo'],
  });
  assert.equal(criado.status, 201, JSON.stringify(criado.corpo));
  const slug = criado.corpo.slug;

  // Anonimo: nao esta logado nem seguindo.
  const anon = cliente();
  const estAnon = await anon('GET', `/api/seguir/${slug}/estado`);
  assert.equal(estAnon.status, 200);
  assert.deepEqual(estAnon.corpo, { logado: false, seguindo: false });

  // Seguir exige login (RN-SG-05): anonimo tomando POST leva 401.
  const semLogin = await anon('POST', `/api/seguir/${slug}`);
  assert.equal(semLogin.status, 401);

  // Bob segue a copa da Alice.
  const seg = await bob('POST', `/api/seguir/${slug}`);
  assert.equal(seg.status, 200);
  assert.deepEqual(seg.corpo, { seguindo: true });

  // Estado do Bob reflete que ele segue (RN-SG-06).
  const estBob = await bob('GET', `/api/seguir/${slug}/estado`);
  assert.deepEqual(estBob.corpo, { logado: true, seguindo: true });

  // Aparece na secao "Seguindo" do Bob, com contagens e nome do dono.
  const seguindo = await bob('GET', '/api/seguindo');
  assert.equal(seguindo.corpo.length, 1);
  assert.equal(seguindo.corpo[0].slug, slug);
  assert.equal(seguindo.corpo[0].dono_nome, 'Alice');
  assert.equal(seguindo.corpo[0].n_times, 2);

  // Seguir NAO cria posse (RN-SG-02): a copa nao vira "propria" do Bob nem lhe
  // da o painel administrativo.
  const camposBob = await bob('GET', '/api/campeonatos');
  assert.equal(camposBob.corpo.length, 0);
  const painelBob = await bob('GET', `/api/campeonatos/${criado.corpo.id}`);
  assert.equal(painelBob.status, 404);

  // Idempotencia (RN-SG-03): seguir de novo nao duplica.
  const de2 = await bob('POST', `/api/seguir/${slug}`);
  assert.deepEqual(de2.corpo, { seguindo: true });
  assert.equal((await bob('GET', '/api/seguindo')).corpo.length, 1);

  // So o DONO ve a contagem de seguidores (RN-SG, secao 7).
  const camposAlice = await alice('GET', '/api/campeonatos');
  const propria = camposAlice.corpo.find((c) => c.slug === slug);
  assert.equal(propria.n_seguidores, 1);

  // Deixar de seguir remove o vinculo; idempotente.
  const del = await bob('DELETE', `/api/seguir/${slug}`);
  assert.deepEqual(del.corpo, { seguindo: false });
  assert.equal((await bob('GET', '/api/seguindo')).corpo.length, 0);
  assert.deepEqual((await bob('GET', `/api/seguir/${slug}/estado`)).corpo, { logado: true, seguindo: false });
  const delDeNovo = await bob('DELETE', `/api/seguir/${slug}`);
  assert.deepEqual(delDeNovo.corpo, { seguindo: false });
});

test('seguir: dono pode seguir o proprio campeonato (RN-SG-07, decisao secao 7)', async () => {
  const alice = cliente();
  await registrarEntrar(alice, { nome: 'Alice2', email: 'alice2-sg@teste.com', senha: 'segredo1' });
  const criado = await alice('POST', '/api/campeonatos', {
    nome: 'Copa Propria', formato: 'pontos', sortear: false, times: ['A', 'B'],
  });
  const seg = await alice('POST', `/api/seguir/${criado.corpo.slug}`);
  assert.deepEqual(seg.corpo, { seguindo: true });
  const seguindo = await alice('GET', '/api/seguindo');
  assert.equal(seguindo.corpo.some((c) => c.slug === criado.corpo.slug), true);
});

test('seguir: campeonato inexistente ou despublicado responde 404', async () => {
  const bob = cliente();
  await registrarEntrar(bob, { nome: 'Bob2', email: 'bob2-sg@teste.com', senha: 'segredo1' });
  assert.equal((await bob('POST', '/api/seguir/nao-existe-xyz')).status, 404);
  assert.equal((await bob('GET', '/api/seguir/nao-existe-xyz/estado')).status, 404);
});

test('seguir: limite de 40 campeonatos seguidos por conta (RN-SG-10)', () => {
  const db = prepararBanco(':memory:');
  const { lastInsertRowid: contaId } = db
    .prepare("INSERT INTO contas (nome, email, senha_hash, email_verificado) VALUES ('U', 'u@x.com', 'x', 1)")
    .run();
  // 41 campeonatos publicados (insercao direta, sem passar pelo limite de plano).
  for (let i = 1; i <= LIMITE_SEGUIDOS + 1; i++) {
    db.prepare("INSERT INTO campeonatos (conta_id, nome, slug, formato, publicado) VALUES (?, ?, ?, 'pontos', 1)")
      .run(contaId, `C${i}`, `c${i}`);
  }
  for (let i = 1; i <= LIMITE_SEGUIDOS; i++) {
    assert.deepEqual(seguir(db, contaId, `c${i}`), { seguindo: true });
  }
  assert.throws(() => seguir(db, contaId, `c${LIMITE_SEGUIDOS + 1}`), /limite de 40/);
  // Reseguir um ja seguido continua ok (idempotente, nao esbarra no limite).
  assert.deepEqual(seguir(db, contaId, 'c1'), { seguindo: true });
});
