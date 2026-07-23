// Disputa de 3o lugar (EF Mata-mata Manual Personalizado, fase A2).
// Cobre a unica propagacao do produto que nao e do vencedor: o perdedor da
// semifinal desce para o confronto 1 da ultima rodada. Inclui a regressao das
// chaves SEM disputa — nelas nada pode mudar.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { prepararBanco } from '../db/db.js';
import { montarRotas } from '../routes/api.js';
import { configurarTransporte } from '../src/email.js';

let servidor;
let base;
let bancoTeste;

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

async function registrarEntrar(c, { nome, email, senha }) {
  const reg = await c('POST', '/api/auth/registrar', { nome, email, senha, consentimento: true });
  assert.equal(reg.status, 201, JSON.stringify(reg.corpo));
  const conf = await c('POST', '/api/auth/confirmar-email', { token: tokenDoUltimoEmail(email) });
  assert.equal(conf.status, 200, JSON.stringify(conf.corpo));
}

const jogos = async (c, id) => (await c('GET', `/api/campeonatos/${id}`)).corpo.jogos;
const daFase = (js, rodada, confronto) =>
  js.filter((j) => j.fase === 'mata' && j.rodada === rodada && j.confronto === confronto);

// Encerra um jogo com a casa vencendo por 2 x 0.
async function casaVence(c, jogo) {
  const r = await c('POST', `/api/jogos/${jogo.id}/resultado`, { gols_casa: 2, gols_fora: 0 });
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  return jogo.time_casa_id;
}

test('disputa de 3o: perdedores das semifinais descem e o podio sai completo', async () => {
  const dono = cliente();
  await registrarEntrar(dono, { nome: 'Dono', email: 'dono-d3@teste.com', senha: 'segredo1' });
  const criado = await dono('POST', '/api/campeonatos', {
    nome: 'Copa com 3o', formato: 'mata', sortear: false, disputa_terceiro: true,
    times: ['Aguia', 'Bufalo', 'Cobra', 'Dragao'],
  });
  assert.equal(criado.status, 201, JSON.stringify(criado.corpo));
  const camp = criado.corpo;
  assert.equal(camp.disputa_terceiro, 1);

  // Chave de 4 = 2 semis + final; a disputa entra como confronto 1 da rodada 2.
  const js = await jogos(dono, camp.id);
  assert.equal(js.filter((j) => j.fase === 'mata').length, 4);
  const disputa = daFase(js, 2, 1);
  assert.equal(disputa.length, 1);
  assert.equal(disputa[0].perna, 1);
  assert.equal(disputa[0].time_casa_id, null);
  assert.equal(disputa[0].time_fora_id, null);

  // Semifinais: a casa vence as duas.
  const semi0 = daFase(js, 1, 0)[0];
  const semi1 = daFase(js, 1, 1)[0];
  const perdedor0 = semi0.time_fora_id;
  const perdedor1 = semi1.time_fora_id;
  const finalista0 = await casaVence(dono, semi0);
  const finalista1 = await casaVence(dono, semi1);

  // Vencedores na final; perdedores na disputa, cada um do seu lado
  // (confronto par manda em casa, tanto na final quanto na disputa).
  const js2 = await jogos(dono, camp.id);
  const decisao = daFase(js2, 2, 0)[0];
  assert.equal(decisao.time_casa_id, finalista0);
  assert.equal(decisao.time_fora_id, finalista1);
  const d2 = daFase(js2, 2, 1)[0];
  assert.equal(d2.time_casa_id, perdedor0);
  assert.equal(d2.time_fora_id, perdedor1);

  // A pagina publica continua chamando a ultima rodada de Final e marca a
  // disputa separadamente (RN-MM-15).
  const pub = await dono('GET', `/api/publico/${camp.slug}`);
  const ultima = pub.corpo.chaveamento.at(-1);
  assert.equal(ultima.fase, 'Final');
  assert.equal(ultima.confrontos.length, 2);
  assert.equal(ultima.confrontos.find((cf) => cf.confronto === 0).disputa_terceiro, false);
  assert.equal(ultima.confrontos.find((cf) => cf.confronto === 1).disputa_terceiro, true);

  // Antes de jogar a disputa, o 3o lugar ainda nao existe.
  await casaVence(dono, decisao);
  const parcial = await dono('GET', `/api/campeonatos/${camp.id}/encerramento`);
  assert.equal(parcial.corpo.sugestao.primeiro, finalista0);
  assert.equal(parcial.corpo.sugestao.segundo, finalista1);
  assert.equal(parcial.corpo.sugestao.terceiro, null);
  assert.equal(parcial.corpo.fim_definido, false, 'a disputa pendente segura o fim da copa');

  // Jogada a disputa, o podio vem completo (RN-MM-23).
  const terceiro = await casaVence(dono, d2);
  const est = await dono('GET', `/api/campeonatos/${camp.id}/encerramento`);
  assert.equal(est.corpo.fim_definido, true);
  assert.deepEqual(est.corpo.sugestao, {
    primeiro: finalista0, segundo: finalista1, terceiro,
  });
});

test('disputa de 3o: apagar resultado da semifinal e barrado depois dela decidida', async () => {
  const dono = cliente();
  await registrarEntrar(dono, { nome: 'Dono2', email: 'dono-d3b@teste.com', senha: 'segredo1' });
  const camp = (await dono('POST', '/api/campeonatos', {
    nome: 'Copa trava', formato: 'mata', sortear: false, disputa_terceiro: true,
    times: ['A', 'B', 'C', 'D'],
  })).corpo;

  const js = await jogos(dono, camp.id);
  await casaVence(dono, daFase(js, 1, 0)[0]);
  await casaVence(dono, daFase(js, 1, 1)[0]);
  const d = daFase(await jogos(dono, camp.id), 2, 1)[0];
  await casaVence(dono, d);

  // A semifinal alimenta a disputa ja jogada: apagar deixaria um jogo
  // encerrado com uma vaga vazia.
  const semi = daFase(await jogos(dono, camp.id), 1, 0)[0];
  const apagar = await dono('DELETE', `/api/jogos/${semi.id}/resultado`);
  assert.equal(apagar.status, 409, JSON.stringify(apagar.corpo));
  assert.match(apagar.corpo.mensagem, /3o lugar/);

  // Apagada a disputa, a semifinal volta a ser editavel e limpa a vaga.
  assert.equal((await dono('DELETE', `/api/jogos/${d.id}/resultado`)).status, 200);
  assert.equal((await dono('DELETE', `/api/jogos/${semi.id}/resultado`)).status, 200);
  const limpa = daFase(await jogos(dono, camp.id), 2, 1)[0];
  assert.equal(limpa.time_casa_id, null, 'a vaga do perdedor volta a ficar aberta');
});

test('disputa de 3o: liga e desliga pela configuracao (RN-MM-24)', async () => {
  const dono = cliente();
  await registrarEntrar(dono, { nome: 'Dono3', email: 'dono-d3c@teste.com', senha: 'segredo1' });
  const camp = (await dono('POST', '/api/campeonatos', {
    nome: 'Copa toggle', formato: 'mata', sortear: false,
    times: ['A', 'B', 'C', 'D'],
  })).corpo;
  assert.equal(camp.disputa_terceiro, 0);
  assert.equal((await jogos(dono, camp.id)).length, 3);

  // Liga com a chave ja gerada: cria o jogo vazio.
  const liga = await dono('PATCH', `/api/campeonatos/${camp.id}`, { disputa_terceiro: true });
  assert.equal(liga.status, 200, JSON.stringify(liga.corpo));
  assert.equal(liga.corpo.disputa_terceiro, 1);
  assert.equal((await jogos(dono, camp.id)).length, 4);

  // Desliga: o jogo some.
  assert.equal((await dono('PATCH', `/api/campeonatos/${camp.id}`, { disputa_terceiro: false })).status, 200);
  assert.equal((await jogos(dono, camp.id)).length, 3);

  // Semifinais decididas e SO ENTAO a disputa e ligada: as vagas ja vem cheias.
  const js = await jogos(dono, camp.id);
  const perdedor0 = daFase(js, 1, 0)[0].time_fora_id;
  const perdedor1 = daFase(js, 1, 1)[0].time_fora_id;
  await casaVence(dono, daFase(js, 1, 0)[0]);
  await casaVence(dono, daFase(js, 1, 1)[0]);
  assert.equal((await dono('PATCH', `/api/campeonatos/${camp.id}`, { disputa_terceiro: true })).status, 200);
  const d = daFase(await jogos(dono, camp.id), 2, 1)[0];
  assert.equal(d.time_casa_id, perdedor0);
  assert.equal(d.time_fora_id, perdedor1);

  // Com resultado lancado, mudar a opcao e conflito.
  await casaVence(dono, d);
  const trava = await dono('PATCH', `/api/campeonatos/${camp.id}`, { disputa_terceiro: false });
  assert.equal(trava.status, 409, JSON.stringify(trava.corpo));
});

test('disputa de 3o: chave de 2 nao comporta', async () => {
  const dono = cliente();
  await registrarEntrar(dono, { nome: 'Dono4', email: 'dono-d3d@teste.com', senha: 'segredo1' });
  const barrado = await dono('POST', '/api/campeonatos', {
    nome: 'Final unica', formato: 'mata', sortear: false, disputa_terceiro: true,
    times: ['A', 'B'],
  });
  assert.equal(barrado.status, 400);
  assert.match(barrado.corpo.mensagem, /3o lugar/);

  // Criada sem a opcao, ligar depois tambem e barrado.
  const camp = (await dono('POST', '/api/campeonatos', {
    nome: 'Final unica 2', formato: 'mata', sortear: false, times: ['A', 'B'],
  })).corpo;
  const liga = await dono('PATCH', `/api/campeonatos/${camp.id}`, { disputa_terceiro: true });
  assert.equal(liga.status, 400, JSON.stringify(liga.corpo));
});

test('disputa de 3o: grupos + mata cria o jogo ao gerar a chave', async () => {
  const dono = cliente();
  await registrarEntrar(dono, { nome: 'Dono5', email: 'dono-d3e@teste.com', senha: 'segredo1' });
  const camp = (await dono('POST', '/api/campeonatos', {
    nome: 'Copa mista', formato: 'grupos_mata', num_grupos: 2, classificados_por_grupo: 2,
    sortear: false, disputa_terceiro: true,
    times: ['A1', 'A2', 'A3', 'B1', 'B2', 'B3'],
  })).corpo;
  assert.equal(camp.disputa_terceiro, 1);

  // Fase de grupos: nenhum jogo de mata ainda, nem disputa.
  let js = await jogos(dono, camp.id);
  assert.equal(js.filter((j) => j.fase === 'mata').length, 0);

  for (const j of js.filter((j) => j.fase === 'grupos')) {
    assert.equal((await dono('POST', `/api/jogos/${j.id}/resultado`, { gols_casa: 2, gols_fora: 0 })).status, 200);
  }
  const gerou = await dono('POST', `/api/campeonatos/${camp.id}/gerar-mata`);
  assert.equal(gerou.status, 201, JSON.stringify(gerou.corpo));
  assert.equal(gerou.corpo.jogos_criados, 4, '2 semis + final + disputa');

  js = await jogos(dono, camp.id);
  const d = daFase(js, 2, 1);
  assert.equal(d.length, 1);
  assert.equal(d[0].time_casa_id, null);
});

test('regressao: sem disputa, o mata-mata segue exatamente como antes', async () => {
  const dono = cliente();
  await registrarEntrar(dono, { nome: 'Dono6', email: 'dono-d3f@teste.com', senha: 'segredo1' });
  const camp = (await dono('POST', '/api/campeonatos', {
    nome: 'Copa classica', formato: 'mata', sortear: false,
    times: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
  })).corpo;
  assert.equal(camp.disputa_terceiro, 0);

  const js = await jogos(dono, camp.id);
  assert.equal(js.length, 7, 'chave de 8 = 7 jogos, sem jogo extra');
  assert.equal(js.filter((j) => j.rodada === 3).length, 1, 'a ultima rodada tem so a final');

  // Nomes das fases inalterados na pagina publica.
  const pub = await dono('GET', `/api/publico/${camp.slug}`);
  assert.deepEqual(pub.corpo.chaveamento.map((r) => r.fase), ['Quartas de final', 'Semifinal', 'Final']);
  assert.ok(pub.corpo.chaveamento.every((r) => r.confrontos.every((cf) => cf.disputa_terceiro === false)));

  // Podio sugerido continua com o 3o em branco (nao ha como deduzi-lo).
  for (const rodada of [1, 2, 3]) {
    for (const j of (await jogos(dono, camp.id)).filter((x) => x.rodada === rodada)) {
      await casaVence(dono, j);
    }
  }
  const est = await dono('GET', `/api/campeonatos/${camp.id}/encerramento`);
  assert.ok(est.corpo.sugestao.primeiro);
  assert.ok(est.corpo.sugestao.segundo);
  assert.equal(est.corpo.sugestao.terceiro, null);
});
