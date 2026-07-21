// Painel do Atleta (EF Perfil do Atleta, fase C): estatisticas ao vivo por
// copa conectada — jogos/V-E-D do time, gols/pontos do jogador, sets do
// time/dupla, colocacao via podio, quebra por ano e privacidade.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { prepararBanco } from '../db/db.js';
import { montarRotas } from '../routes/api.js';
import { configurarTransporte } from '../src/email.js';
import { anoDoJogo } from '../src/perfil.js';

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
      convite: { max: 1000 }, seguir: { max: 1000 }, conexao: { max: 1000 },
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

// Conecta a conta do atleta ao alvo e aprova pelo dono.
async function conectarAprovar(dono, atleta, camp, alvo) {
  await atleta('POST', `/api/seguir/${camp.slug}`);
  const sol = await atleta('POST', '/api/atleta/conexoes', { slug: camp.slug, ...alvo });
  assert.equal(sol.status, 201, JSON.stringify(sol.corpo));
  const dec = await dono('POST', `/api/campeonatos/${camp.id}/conexoes/${sol.corpo.id}/decidir`, { acao: 'aprovar' });
  assert.equal(dec.status, 200, JSON.stringify(dec.corpo));
}

test('perfil: futebol — jogos do time, gols do jogador (gol contra fora), ano e titulo', async () => {
  const dono = cliente();
  const atleta = cliente();
  await registrarEntrar(dono, { nome: 'Dono', email: 'dono-pf@teste.com', senha: 'segredo1' });
  await registrarEntrar(atleta, { nome: 'Ana', email: 'ana-pf@teste.com', senha: 'segredo1' });

  const criado = await dono('POST', '/api/campeonatos', {
    nome: 'Copa Perfil', temporada: '2026', formato: 'pontos', sortear: false,
    times: ['Leões', 'Tigres'], ida_volta_grupos: true, // 2 jogos entre os 2 times
  });
  const camp = criado.corpo;
  const det = await dono('GET', `/api/campeonatos/${camp.id}`);
  const leoes = det.corpo.times.find((t) => t.nome === 'Leões');
  const tigres = det.corpo.times.find((t) => t.nome === 'Tigres');
  const [ana] = (await dono('POST', `/api/times/${leoes.id}/jogadores/lote`, { texto: 'Ana,10\nBia,7' })).corpo;
  const [ze] = (await dono('POST', `/api/times/${tigres.id}/jogadores/lote`, { texto: 'Ze,9' })).corpo;

  const [jogo1, jogo2] = det.corpo.jogos;
  // Jogo 1 em 2025: Leoes vencem com 2 gols da Ana; Ze faz GOL CONTRA a favor
  // dos Leoes (nao pode contar para a Ana nem por engano para o Ze).
  await dono('PATCH', `/api/jogos/${jogo1.id}/agenda`, { data: '2025-11-10T20:00' });
  const casa1 = jogo1.time_casa_id === leoes.id;
  const r1 = await dono('POST', `/api/jogos/${jogo1.id}/resultado`, {
    gols_casa: casa1 ? 3 : 0, gols_fora: casa1 ? 0 : 3,
    eventos: [
      { tipo: 'gol', time_id: leoes.id, jogador_id: ana.id },
      { tipo: 'gol', time_id: leoes.id, jogador_id: ana.id },
      { tipo: 'gol_contra', time_id: leoes.id, jogador_id: ze.id },
    ],
  });
  assert.equal(r1.status, 200, JSON.stringify(r1.corpo));
  // Jogo 2 em 2026: empate 1x1 com gol da Ana.
  await dono('PATCH', `/api/jogos/${jogo2.id}/agenda`, { data: '2026-03-05T19:30' });
  const r2 = await dono('POST', `/api/jogos/${jogo2.id}/resultado`, {
    gols_casa: 1, gols_fora: 1,
    eventos: [{ tipo: 'gol', time_id: leoes.id, jogador_id: ana.id }],
  });
  assert.equal(r2.status, 200, JSON.stringify(r2.corpo));

  await conectarAprovar(dono, atleta, camp, { jogador_id: ana.id });

  // Perfil ao vivo: 2 jogos do time, 1V 1E, 3 gols da Ana; quebra por ano.
  const perfil = await atleta('GET', '/api/atleta/perfil');
  assert.equal(perfil.status, 200);
  assert.equal(perfil.corpo.length, 1);
  const copa = perfil.corpo[0];
  assert.equal(copa.alvo_nome, 'Ana');
  assert.equal(copa.time_nome, 'Leões');
  assert.equal(copa.producao, 'gols');
  assert.equal(copa.empate_possivel, true);
  assert.deepEqual(
    { jogos: copa.totais.jogos, v: copa.totais.v, e: copa.totais.e, d: copa.totais.d, gols: copa.totais.gols },
    { jogos: 2, v: 1, e: 1, d: 0, gols: 3 },
  );
  assert.equal(copa.anos['2025'].gols, 2);
  assert.equal(copa.anos['2026'].gols, 1);
  assert.equal(copa.anos['2025'].v, 1);
  assert.equal(copa.anos['2026'].e, 1);

  // Sem encerramento nao ha titulo (RN-AT-13)…
  assert.equal(copa.colocacao, null);
  // …encerra com Leoes campeoes: a conexao de JOGADOR herda a colocacao do time.
  const enc = await dono('POST', `/api/campeonatos/${camp.id}/encerrar`, { primeiro: leoes.id, segundo: tigres.id });
  assert.equal(enc.status, 200, JSON.stringify(enc.corpo));
  const copa2 = (await atleta('GET', '/api/atleta/perfil')).corpo[0];
  assert.equal(copa2.colocacao, 1);
  assert.equal(copa2.encerrado, true);
  assert.ok(copa2.ano_titulo >= 2025);
});

test('perfil: peteca 2x2 — conexao ao time soma sets e herda titulo do podio de times', async () => {
  const dono = cliente();
  const atleta = cliente();
  await registrarEntrar(dono, { nome: 'Dono2', email: 'dono2-pf@teste.com', senha: 'segredo1' });
  await registrarEntrar(atleta, { nome: 'Theo', email: 'theo-pf@teste.com', senha: 'segredo1' });

  const criado = await dono('POST', '/api/campeonatos', {
    nome: 'Aberto Peteca Perfil', esporte: 'peteca', modalidade: 'Duplas 2x2',
    formato: 'pontos', sortear: false, times: ['Theo e Marcelo', 'Ze e Chico'],
  });
  const camp = criado.corpo;
  const det = await dono('GET', `/api/campeonatos/${camp.id}`);
  const dupla = det.corpo.times.find((t) => t.nome === 'Theo e Marcelo');
  const rival = det.corpo.times.find((t) => t.nome === 'Ze e Chico');
  const [jogo] = det.corpo.jogos;
  // Melhor de 3: dupla vence por 2 sets a 1.
  const casaEhDupla = jogo.time_casa_id === dupla.id;
  const r = await dono('POST', `/api/jogos/${jogo.id}/resultado`, {
    sets: casaEhDupla ? [[12, 10], [8, 12], [12, 7]] : [[10, 12], [12, 8], [7, 12]],
  });
  assert.equal(r.status, 200, JSON.stringify(r.corpo));

  await conectarAprovar(dono, atleta, camp, { time_id: dupla.id });
  await dono('POST', `/api/campeonatos/${camp.id}/encerrar`, { primeiro: dupla.id, segundo: rival.id });

  const copa = (await atleta('GET', '/api/atleta/perfil')).corpo[0];
  assert.equal(copa.alvo_tipo, 'time');
  assert.equal(copa.producao, 'sets');
  assert.equal(copa.empate_possivel, false);
  assert.deepEqual(
    { jogos: copa.totais.jogos, v: copa.totais.v, sv: copa.totais.sets_vencidos, sp: copa.totais.sets_perdidos },
    { jogos: 1, v: 1, sv: 2, sp: 1 },
  );
  assert.equal(copa.totais.gols, 0);
  assert.equal(copa.colocacao, 1); // podio de time casa direto com a conexao ao time
});

test('perfil: basquete soma pontos do jogador; pelada conta so os jogos escalados', async () => {
  const dono = cliente();
  const atleta = cliente();
  await registrarEntrar(dono, { nome: 'Dono3', email: 'dono3-pf@teste.com', senha: 'segredo1' });
  await registrarEntrar(atleta, { nome: 'Caio', email: 'caio-pf@teste.com', senha: 'segredo1' });

  // Basquete: cestinha com 21 pontos em 1 jogo.
  const basq = (await dono('POST', '/api/campeonatos', {
    nome: 'Basquete Perfil', esporte: 'basquete', formato: 'pontos', sortear: false,
    times: ['Falcões', 'Corujas'],
  })).corpo;
  const detB = await dono('GET', `/api/campeonatos/${basq.id}`);
  const falcoes = detB.corpo.times.find((t) => t.nome === 'Falcões');
  const [caioB] = (await dono('POST', `/api/times/${falcoes.id}/jogadores/lote`, { texto: 'Caio,23' })).corpo;
  const [jogoB] = detB.corpo.jogos;
  const casaEhFalcoes = jogoB.time_casa_id === falcoes.id;
  const rB = await dono('POST', `/api/jogos/${jogoB.id}/resultado`, {
    pontos_casa: casaEhFalcoes ? 60 : 55, pontos_fora: casaEhFalcoes ? 55 : 60,
    eventos: [{ tipo: 'pontos', time_id: falcoes.id, jogador_id: caioB.id, valor: 21 }],
  });
  assert.equal(rB.status, 200, JSON.stringify(rB.corpo));
  await conectarAprovar(dono, atleta, basq, { jogador_id: caioB.id });

  // Pelada: 2 jogos realizados, Caio escalado so no primeiro (1 jogo, 1 gol).
  const pel = (await dono('POST', '/api/campeonatos', {
    nome: 'Pelada Perfil', esporte: 'pelada_epica', jogos_temporada: 10,
    times: ['Verde', 'Amarelo'], jogadores_fixos: ['Ana', 'Bia', 'Caio', 'Duda'],
  })).corpo;
  const detP = await dono('GET', `/api/campeonatos/${pel.id}`);
  const [verde, amarelo] = detP.corpo.times;
  const jp = (nome) => detP.corpo.jogadores.find((x) => x.nome === nome);
  const j1 = (await dono('POST', `/api/campeonatos/${pel.id}/jogos`, { time_casa_id: verde.id, time_fora_id: amarelo.id })).corpo;
  const rP1 = await dono('POST', `/api/jogos/${j1.id}/resultado`, {
    gols_casa: 1, gols_fora: 0,
    escalacoes: [
      { jogador_id: jp('Caio').id, time_id: verde.id }, { jogador_id: jp('Ana').id, time_id: verde.id },
      { jogador_id: jp('Bia').id, time_id: amarelo.id }, { jogador_id: jp('Duda').id, time_id: amarelo.id },
    ],
    eventos: [{ tipo: 'gol', time_id: verde.id, jogador_id: jp('Caio').id }],
  });
  assert.equal(rP1.status, 200, JSON.stringify(rP1.corpo));
  const j2 = (await dono('POST', `/api/campeonatos/${pel.id}/jogos`, { time_casa_id: verde.id, time_fora_id: amarelo.id })).corpo;
  const rP2 = await dono('POST', `/api/jogos/${j2.id}/resultado`, {
    gols_casa: 0, gols_fora: 2,
    escalacoes: [
      { jogador_id: jp('Ana').id, time_id: verde.id }, { jogador_id: jp('Bia').id, time_id: verde.id },
      { jogador_id: jp('Duda').id, time_id: amarelo.id },
    ],
  });
  assert.equal(rP2.status, 200, JSON.stringify(rP2.corpo));
  await conectarAprovar(dono, atleta, pel, { jogador_id: jp('Caio').id });

  const perfil = (await atleta('GET', '/api/atleta/perfil')).corpo;
  assert.equal(perfil.length, 2);
  const copaB = perfil.find((c) => c.esporte === 'basquete');
  assert.equal(copaB.producao, 'pontos');
  assert.equal(copaB.totais.pontos, 21);
  assert.equal(copaB.totais.jogos, 1);
  assert.equal(copaB.totais.v, 1);
  const copaP = perfil.find((c) => c.esporte === 'pelada_epica');
  // Pelada: so os jogos ESCALADOS contam (1 de 2), com o resultado do seu time.
  assert.deepEqual(
    { jogos: copaP.totais.jogos, v: copaP.totais.v, d: copaP.totais.d, gols: copaP.totais.gols },
    { jogos: 1, v: 1, d: 0, gols: 1 },
  );
});

test('perfil: ano cai para criado_em quando o jogo nao tem data', async () => {
  assert.equal(anoDoJogo({ data: '2025-11-10T20:00', criado_em: '2026-01-01 10:00:00' }), 2025);
  assert.equal(anoDoJogo({ data: 'Sábado 15h', criado_em: '2026-01-01 10:00:00' }), 2026);
  assert.equal(anoDoJogo({ data: null, criado_em: '2026-07-21 03:00:00' }), 2026);
  // Numero de 4 digitos implausivel como ano nao engana a quebra.
  assert.equal(anoDoJogo({ data: 'Quadra 9999', criado_em: '2026-07-21 03:00:00' }), 2026);
});

test('perfil: privacidade — pendente/recusada fora, cada conta ve so o seu, anonimo 401', async () => {
  const dono = cliente();
  const atleta = cliente();
  const outra = cliente();
  await registrarEntrar(dono, { nome: 'Dono4', email: 'dono4-pf@teste.com', senha: 'segredo1' });
  await registrarEntrar(atleta, { nome: 'Gil', email: 'gil-pf@teste.com', senha: 'segredo1' });
  await registrarEntrar(outra, { nome: 'Outra', email: 'outra-pf@teste.com', senha: 'segredo1' });

  const criado = await dono('POST', '/api/campeonatos', {
    nome: 'Copa Privada Perfil', formato: 'pontos', sortear: false, times: ['A', 'B'],
  });
  const camp = criado.corpo;
  const timeA = (await dono('GET', `/api/campeonatos/${camp.id}`)).corpo.times[0];
  const [gil] = (await dono('POST', `/api/times/${timeA.id}/jogadores/lote`, { texto: 'Gil' })).corpo;

  // Solicitacao PENDENTE nao gera estatistica nenhuma (RN-AT-05/07).
  await atleta('POST', `/api/seguir/${camp.slug}`);
  const sol = await atleta('POST', '/api/atleta/conexoes', { slug: camp.slug, jogador_id: gil.id });
  assert.equal((await atleta('GET', '/api/atleta/perfil')).corpo.length, 0);

  // Aprovada aparece — mas so para a PROPRIA conta (RN-AT-18).
  await dono('POST', `/api/campeonatos/${camp.id}/conexoes/${sol.corpo.id}/decidir`, { acao: 'aprovar' });
  assert.equal((await atleta('GET', '/api/atleta/perfil')).corpo.length, 1);
  assert.equal((await outra('GET', '/api/atleta/perfil')).corpo.length, 0);
  assert.equal((await cliente()('GET', '/api/atleta/perfil')).status, 401);

  // Revogada some do perfil na hora (RN-AT-06; ao vivo, sem snapshot na fase C).
  const fila = await dono('GET', `/api/campeonatos/${camp.id}/conexoes`);
  await dono('DELETE', `/api/campeonatos/${camp.id}/conexoes/${fila.corpo.conectados[0].id}`);
  assert.equal((await atleta('GET', '/api/atleta/perfil')).corpo.length, 0);
});
