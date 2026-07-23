// Fase B do Mata-mata Manual Personalizado: criacao pela API com desenho do
// catalogo, aba Chaveamento (GET/PUT) e trava de congelamento (RN-MM-05/06).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { prepararBanco } from '../db/db.js';
import { montarRotas } from '../routes/api.js';
import { configurarTransporte } from '../src/email.js';

let servidor;
let base;

const emails = [];
configurarTransporte(async (m) => { emails.push(m); });
const tokenDoUltimoEmail = (para) =>
  [...emails].reverse().find((e) => e.para === para.toLowerCase())?.texto.match(/token=([0-9a-f]+)/)?.[1];

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
  return app;
}

before(async () => {
  servidor = montarApp().listen(0);
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

async function registrarEntrar(c, email) {
  const reg = await c('POST', '/api/auth/registrar', { nome: 'Gestor', email, senha: 'segredo1', consentimento: true });
  assert.equal(reg.status, 201, JSON.stringify(reg.corpo));
  const conf = await c('POST', '/api/auth/confirmar-email', { token: tokenDoUltimoEmail(email) });
  assert.equal(conf.status, 200, JSON.stringify(conf.corpo));
}

const jogosDe = async (c, id) => (await c('GET', `/api/campeonatos/${id}`)).corpo.jogos;

test('catalogo: rota exige login, valida a faixa e barra potencia de 2', async () => {
  const anonimo = cliente();
  assert.equal((await anonimo('GET', '/api/chaveamentos?vagas=6')).status, 401);

  const c = cliente();
  await registrarEntrar(c, 'cat-b@teste.com');
  const seis = await c('GET', '/api/chaveamentos?vagas=6');
  assert.equal(seis.status, 200);
  assert.deepEqual(seis.corpo.map((d) => d.id), ['6A', '6B', '6C']);
  assert.equal(seis.corpo[0].recomendado, true);
  assert.equal((await c('GET', '/api/chaveamentos?vagas=8')).status, 400);
  assert.equal((await c('GET', '/api/chaveamentos?vagas=40')).status, 400);
});

test('criacao manual: 6 times sem sorteio ocupam P1..P6 do desenho 6A', async () => {
  const c = cliente();
  await registrarEntrar(c, 'seis@teste.com');
  const criado = await c('POST', '/api/campeonatos', {
    nome: 'Copa de 6', formato: 'mata', sortear: false,
    times: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'],
  });
  assert.equal(criado.status, 201, JSON.stringify(criado.corpo));
  assert.equal(criado.corpo.mata_modelo, 'manual');
  assert.deepEqual(JSON.parse(criado.corpo.mata_chave), { desenho: '6A', vagas: 6 });

  const det = (await c('GET', `/api/campeonatos/${criado.corpo.id}`)).corpo;
  const id = (nome) => det.times.find((t) => t.nome === nome).id;
  const mata = det.jogos.filter((j) => j.fase === 'mata');
  assert.equal(mata.length, 5, '6 participantes = 5 jogos');
  // Quartas: P4xP5 e P3xP6; semifinais: P1 e P2 ja sentados (folga).
  const par = (r, cf) => {
    const j = mata.find((x) => x.rodada === r && x.confronto === cf);
    return [j?.time_casa_id ?? null, j?.time_fora_id ?? null];
  };
  assert.deepEqual(par(1, 1), [id('T4'), id('T5')]);
  assert.deepEqual(par(1, 3), [id('T3'), id('T6')]);
  assert.deepEqual(par(2, 0), [id('T1'), null]);
  assert.deepEqual(par(2, 1), [id('T2'), null]);
});

test('criacao manual: desenho escolhido (escada 6C) e disputa de 3o barrada nele', async () => {
  const c = cliente();
  await registrarEntrar(c, 'escada@teste.com');
  // A escada nao tem duas semifinais: pedir 3o lugar e erro de validacao.
  const barrado = await c('POST', '/api/campeonatos', {
    nome: 'Escada com 3o', formato: 'mata', mata_desenho: '6C', disputa_terceiro: true,
    times: ['A', 'B', 'C', 'D', 'E', 'F'],
  });
  assert.equal(barrado.status, 400);
  assert.match(barrado.corpo.mensagem, /nao comporta/);

  const ok = await c('POST', '/api/campeonatos', {
    nome: 'Escada de 6', formato: 'mata', mata_desenho: '6C', sortear: false,
    times: ['A', 'B', 'C', 'D', 'E', 'F'],
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.corpo));
  const mata = (await jogosDe(c, ok.corpo.id)).filter((j) => j.fase === 'mata');
  assert.equal(mata.length, 5);
  assert.equal(Math.max(...mata.map((j) => j.rodada)), 5, 'escada de 6 tem 5 rodadas');
  assert.equal((await c('GET', `/api/publico/${ok.corpo.slug}`)).corpo.chaveamento.at(-1).fase, 'Final');
});

test('modelo manual com potencia de 2 e desenho inexistente sao recusados', async () => {
  const c = cliente();
  await registrarEntrar(c, 'ruim@teste.com');
  const cheia = await c('POST', '/api/campeonatos', {
    nome: 'Cheia', formato: 'mata', mata_modelo: 'manual', times: ['A', 'B', 'C', 'D'],
  });
  assert.equal(cheia.status, 400);
  assert.match(cheia.corpo.mensagem, /chave e cheia/);

  const semDesenho = await c('POST', '/api/campeonatos', {
    nome: 'Sem desenho', formato: 'mata', mata_desenho: '9Z', times: ['A', 'B', 'C', 'D', 'E'],
  });
  assert.equal(semDesenho.status, 400);
  assert.match(semDesenho.corpo.mensagem, /nao existe/);
});

test('aba Chaveamento: GET expoe slots e PUT reposiciona nos dois modelos', async () => {
  const c = cliente();
  await registrarEntrar(c, 'chav@teste.com');
  const camp = (await c('POST', '/api/campeonatos', {
    nome: 'Reposicionar', formato: 'mata', sortear: false, times: ['A', 'B', 'C', 'D', 'E'],
  })).corpo;

  const chav = await c('GET', `/api/campeonatos/${camp.id}/chaveamento`);
  assert.equal(chav.status, 200);
  assert.equal(chav.corpo.modelo, 'manual');
  assert.equal(chav.corpo.desenho, '5A');
  assert.equal(chav.corpo.editavel, true);
  assert.equal(chav.corpo.slots.length, 5, 'todas as 5 vagas de entrada');
  assert.deepEqual(chav.corpo.rodadas.map((r) => r.nome), ['Fase preliminar', 'Semifinal', 'Final']);

  // Troca A (folga na semifinal) com E (preliminar): permutacao valida.
  const det = (await c('GET', `/api/campeonatos/${camp.id}`)).corpo;
  const id = (nome) => det.times.find((t) => t.nome === nome).id;
  const slots = chav.corpo.slots.map((s) => {
    if (s.time_id === id('A')) return { ...s, time_id: id('E') };
    if (s.time_id === id('E')) return { ...s, time_id: id('A') };
    return s;
  });
  const put = await c('PUT', `/api/campeonatos/${camp.id}/chaveamento`, { slots });
  assert.equal(put.status, 200, JSON.stringify(put.corpo));
  const preliminar = put.corpo.rodadas[0].confrontos[0];
  assert.equal(preliminar.time_fora_id, id('A'), 'A desceu para a preliminar');

  // Repetir time e recusado.
  const duplicado = chav.corpo.slots.map((s) => ({ ...s, time_id: id('B') }));
  const ruim = await c('PUT', `/api/campeonatos/${camp.id}/chaveamento`, { slots: duplicado });
  assert.equal(ruim.status, 400);

  // Primeiro resultado congela (RN-MM-06).
  const mata = await jogosDe(c, camp.id);
  const jogo = mata.find((j) => j.rodada === 1 && j.time_casa_id && j.time_fora_id);
  assert.equal((await c('POST', `/api/jogos/${jogo.id}/resultado`, { gols_casa: 2, gols_fora: 0 })).status, 200);
  const congelada = await c('PUT', `/api/campeonatos/${camp.id}/chaveamento`, { slots });
  assert.equal(congelada.status, 409);

  // As vagas de entrada sao ESTRUTURAIS: depois da propagacao encher a
  // semifinal, elas continuam sendo as mesmas 5 (e nao os lados preenchidos).
  const depois = (await c('GET', `/api/campeonatos/${camp.id}/chaveamento`)).corpo;
  assert.equal(depois.editavel, false);
  assert.equal(depois.slots.length, 5, 'a chave congelada mantem as vagas de entrada');
  assert.deepEqual(
    depois.slots.map((s) => `${s.rodada}/${s.confronto}/${s.lado}`).sort(),
    put.corpo.slots.map((s) => `${s.rodada}/${s.confronto}/${s.lado}`).sort(),
  );
});

test('aba Chaveamento no Padrao: chave cheia tambem reposiciona (v1.2)', async () => {
  const c = cliente();
  await registrarEntrar(c, 'padrao@teste.com');
  const camp = (await c('POST', '/api/campeonatos', {
    nome: 'Cheia de 4', formato: 'mata', sortear: false, times: ['A', 'B', 'C', 'D'],
  })).corpo;
  assert.equal(camp.mata_modelo, 'padrao');

  const chav = (await c('GET', `/api/campeonatos/${camp.id}/chaveamento`)).corpo;
  assert.equal(chav.editavel, true);
  assert.equal(chav.slots.length, 4);

  // Inverter o mando da 1a partida = trocar casa e fora do confronto 0.
  const det = (await c('GET', `/api/campeonatos/${camp.id}`)).corpo;
  const id = (nome) => det.times.find((t) => t.nome === nome).id;
  const slots = chav.slots.map((s) => {
    if (s.confronto === 0 && s.lado === 'casa') return { ...s, time_id: id('B') };
    if (s.confronto === 0 && s.lado === 'fora') return { ...s, time_id: id('A') };
    return s;
  });
  const put = await c('PUT', `/api/campeonatos/${camp.id}/chaveamento`, { slots });
  assert.equal(put.status, 200, JSON.stringify(put.corpo));
  assert.equal(put.corpo.rodadas[0].confrontos[0].time_casa_id, id('B'));
});

test('colaborador nao reposiciona a chave (dono-only)', async () => {
  const dono = cliente();
  await registrarEntrar(dono, 'dono-chave@teste.com');
  const camp = (await dono('POST', '/api/campeonatos', {
    nome: 'So dono', formato: 'mata', sortear: false, times: ['A', 'B', 'C', 'D', 'E'],
  })).corpo;
  await dono('POST', `/api/campeonatos/${camp.id}/colaboradores`, { email: 'colab-chave@teste.com', pode_jogos: true });

  const colab = cliente();
  await registrarEntrar(colab, 'colab-chave@teste.com');
  const ve = await colab('GET', `/api/campeonatos/${camp.id}/chaveamento`);
  assert.equal(ve.status, 200, 'colaborador ve a chave');
  const tenta = await colab('PUT', `/api/campeonatos/${camp.id}/chaveamento`, { slots: ve.corpo.slots });
  assert.equal(tenta.status, 403);
});
