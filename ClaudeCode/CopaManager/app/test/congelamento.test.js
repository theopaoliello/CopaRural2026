// Congelamento (EF Perfil do Atleta, fase D): o historico do atleta sobrevive
// a exclusao da copa — snapshot ao encerrar, congelamento em TODOS os caminhos
// de exclusao (dono, LGPD, master, jogador removido) e remocao na revogacao.
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

// Copa de futebol 2 times com a jogadora Ana (2 gols em 1 jogo) + atleta conectado.
async function montarCopaConectada(dono, atleta, nome) {
  const criado = await dono('POST', '/api/campeonatos', {
    nome, temporada: '2026', formato: 'pontos', sortear: false, times: ['Leões', 'Tigres'],
  });
  assert.equal(criado.status, 201, JSON.stringify(criado.corpo));
  const camp = criado.corpo;
  const det = await dono('GET', `/api/campeonatos/${camp.id}`);
  const leoes = det.corpo.times.find((t) => t.nome === 'Leões');
  const tigres = det.corpo.times.find((t) => t.nome === 'Tigres');
  const [ana] = (await dono('POST', `/api/times/${leoes.id}/jogadores/lote`, { texto: 'Ana,10' })).corpo;
  const [jogo] = det.corpo.jogos;
  const casaEhLeoes = jogo.time_casa_id === leoes.id;
  const r = await dono('POST', `/api/jogos/${jogo.id}/resultado`, {
    gols_casa: casaEhLeoes ? 2 : 0, gols_fora: casaEhLeoes ? 0 : 2,
    eventos: [
      { tipo: 'gol', time_id: leoes.id, jogador_id: ana.id },
      { tipo: 'gol', time_id: leoes.id, jogador_id: ana.id },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  await atleta('POST', `/api/seguir/${camp.slug}`);
  const sol = await atleta('POST', '/api/atleta/conexoes', { slug: camp.slug, jogador_id: ana.id });
  assert.equal(sol.status, 201, JSON.stringify(sol.corpo));
  const dec = await dono('POST', `/api/campeonatos/${camp.id}/conexoes/${sol.corpo.id}/decidir`, { acao: 'aprovar' });
  assert.equal(dec.status, 200, JSON.stringify(dec.corpo));
  return { camp, leoes, tigres, ana, jogo, conexaoId: sol.corpo.id };
}

const snapshots = (campId) =>
  bancoTeste.prepare('SELECT * FROM atleta_estatisticas WHERE campeonato_id = ?').all(campId);

test('congelamento: encerrar grava o snapshot oficial; reabrir descarta e volta ao vivo', async () => {
  const dono = cliente();
  const atleta = cliente();
  await registrarEntrar(dono, { nome: 'Dono', email: 'dono-cg@teste.com', senha: 'segredo1' });
  await registrarEntrar(atleta, { nome: 'Ana', email: 'ana-cg@teste.com', senha: 'segredo1' });
  const { camp, leoes, jogo } = await montarCopaConectada(dono, atleta, 'Copa Congela');

  // Encerra: snapshot nasce com a colocacao (podio gravado ANTES de congelar).
  assert.equal((await dono('POST', `/api/campeonatos/${camp.id}/encerrar`, { primeiro: leoes.id })).status, 200);
  const [snap] = snapshots(camp.id);
  assert.ok(snap, 'snapshot gravado no encerramento');
  assert.equal(snap.colocacao, 1);
  assert.equal(snap.jogos, 1);
  assert.equal(snap.gols, 2);
  assert.equal(snap.jogador_nome, 'Ana');
  assert.equal(snap.campeonato_nome, 'Copa Congela');

  // Copa encerrada le do SNAPSHOT: apagar o resultado nao mexe no perfil…
  await dono('DELETE', `/api/jogos/${jogo.id}/resultado`);
  let copa = (await atleta('GET', '/api/atleta/perfil')).corpo[0];
  assert.equal(copa.congelado, true);
  assert.equal(copa.totais.jogos, 1);
  assert.equal(copa.totais.gols, 2);
  assert.equal(copa.colocacao, 1);

  // …e reabrir descarta o snapshot (RN-AT-12): o perfil volta ao vivo (0 jogos).
  assert.equal((await dono('POST', `/api/campeonatos/${camp.id}/reabrir`)).status, 200);
  assert.equal(snapshots(camp.id).length, 0);
  copa = (await atleta('GET', '/api/atleta/perfil')).corpo[0];
  assert.equal(copa.congelado, undefined);
  assert.equal(copa.totais.jogos, 0);
});

test('congelamento: excluir a copa preserva o historico do atleta (requisito central)', async () => {
  const dono = cliente();
  const atleta = cliente();
  await registrarEntrar(dono, { nome: 'Dono2', email: 'dono2-cg@teste.com', senha: 'segredo1' });
  await registrarEntrar(atleta, { nome: 'Beto', email: 'beto-cg@teste.com', senha: 'segredo1' });

  // Caso 1: copa excluida SEM encerrar — congela sem titulo, historico fica.
  const a = await montarCopaConectada(dono, atleta, 'Copa Some Sem Titulo');
  assert.equal((await dono('DELETE', `/api/campeonatos/${a.camp.id}`)).status, 200);
  let perfil = (await atleta('GET', '/api/atleta/perfil')).corpo;
  assert.equal(perfil.length, 1);
  assert.equal(perfil[0].nome, 'Copa Some Sem Titulo');
  assert.equal(perfil[0].removido, true);
  assert.equal(perfil[0].colocacao, null);
  assert.deepEqual(
    { jogos: perfil[0].totais.jogos, v: perfil[0].totais.v, gols: perfil[0].totais.gols },
    { jogos: 1, v: 1, gols: 2 },
  );

  // Caso 2: copa ENCERRADA e depois excluida — titulo preservado.
  const b = await montarCopaConectada(dono, atleta, 'Copa Some Com Titulo');
  await dono('POST', `/api/campeonatos/${b.camp.id}/encerrar`, { primeiro: b.leoes.id });
  assert.equal((await dono('DELETE', `/api/campeonatos/${b.camp.id}`)).status, 200);
  perfil = (await atleta('GET', '/api/atleta/perfil')).corpo;
  const comTitulo = perfil.find((c) => c.nome === 'Copa Some Com Titulo');
  assert.equal(comTitulo.removido, true);
  assert.equal(comTitulo.colocacao, 1);
  assert.ok(comTitulo.ano_titulo >= 2026);
  // O snapshot orfao segue no banco com campeonato_id NULL (SET NULL).
  const orfaos = bancoTeste
    .prepare('SELECT COUNT(*) AS n FROM atleta_estatisticas WHERE campeonato_id IS NULL')
    .get().n;
  assert.equal(orfaos, 2);
});

test('congelamento: revogar e desconectar apagam o historico congelado (RN-AT-06)', async () => {
  const dono = cliente();
  const atleta = cliente();
  await registrarEntrar(dono, { nome: 'Dono3', email: 'dono3-cg@teste.com', senha: 'segredo1' });
  await registrarEntrar(atleta, { nome: 'Caio', email: 'caio-cg@teste.com', senha: 'segredo1' });

  // Revogacao do dono em copa encerrada: snapshot some junto.
  const a = await montarCopaConectada(dono, atleta, 'Copa Revoga');
  await dono('POST', `/api/campeonatos/${a.camp.id}/encerrar`, { primeiro: a.leoes.id });
  assert.equal(snapshots(a.camp.id).length, 1);
  const fila = await dono('GET', `/api/campeonatos/${a.camp.id}/conexoes`);
  await dono('DELETE', `/api/campeonatos/${a.camp.id}/conexoes/${fila.corpo.conectados[0].id}`);
  assert.equal(snapshots(a.camp.id).length, 0);
  assert.equal((await atleta('GET', '/api/atleta/perfil')).corpo.length, 0);

  // Desconexao voluntaria do atleta: apaga tambem (decisao fechada: apagar).
  const b = await montarCopaConectada(dono, atleta, 'Copa Desconecta');
  await dono('POST', `/api/campeonatos/${b.camp.id}/encerrar`, { primeiro: b.leoes.id });
  assert.equal(snapshots(b.camp.id).length, 1);
  assert.equal((await atleta('DELETE', `/api/atleta/conexoes/${b.conexaoId}`)).status, 200);
  assert.equal(snapshots(b.camp.id).length, 0);
  assert.equal((await atleta('GET', '/api/atleta/perfil')).corpo.length, 0);
});

test('congelamento: aprovar conexao em copa ja encerrada congela na hora', async () => {
  const dono = cliente();
  const atleta = cliente();
  await registrarEntrar(dono, { nome: 'Dono4', email: 'dono4-cg@teste.com', senha: 'segredo1' });
  await registrarEntrar(atleta, { nome: 'Duda', email: 'duda-cg@teste.com', senha: 'segredo1' });

  const criado = await dono('POST', '/api/campeonatos', {
    nome: 'Copa Ja Encerrada', formato: 'pontos', sortear: false, times: ['A', 'B'],
  });
  const camp = criado.corpo;
  const det = await dono('GET', `/api/campeonatos/${camp.id}`);
  const timeA = det.corpo.times[0];
  const [gol] = (await dono('POST', `/api/times/${timeA.id}/jogadores/lote`, { texto: 'Duda' })).corpo;
  await dono('POST', `/api/jogos/${det.corpo.jogos[0].id}/resultado`, { gols_casa: 1, gols_fora: 0 });
  await dono('POST', `/api/campeonatos/${camp.id}/encerrar`, { primeiro: timeA.id });
  assert.equal(snapshots(camp.id).length, 0); // ninguem conectado ao encerrar

  await atleta('POST', `/api/seguir/${camp.slug}`);
  const sol = await atleta('POST', '/api/atleta/conexoes', { slug: camp.slug, jogador_id: gol.id });
  await dono('POST', `/api/campeonatos/${camp.id}/conexoes/${sol.corpo.id}/decidir`, { acao: 'aprovar' });
  assert.equal(snapshots(camp.id).length, 1, 'aprovacao pos-encerramento congela na hora');
  const copa = (await atleta('GET', '/api/atleta/perfil')).corpo[0];
  assert.equal(copa.congelado, true);
});

test('congelamento: exclusao de conta (LGPD e master) preserva o historico dos atletas', async () => {
  const atleta = cliente();
  await registrarEntrar(atleta, { nome: 'Eva', email: 'eva-cg@teste.com', senha: 'segredo1' });

  // LGPD: o ORGANIZADOR exclui a propria conta — as copas dele somem, mas o
  // historico da atleta conectada fica congelado.
  const donoLgpd = cliente();
  await registrarEntrar(donoLgpd, { nome: 'DonoLgpd', email: 'dono-lgpd-cg@teste.com', senha: 'segredo1' });
  await montarCopaConectada(donoLgpd, atleta, 'Copa Do Dono LGPD');
  assert.equal((await donoLgpd('DELETE', '/api/auth/minha-conta', { confirmacao: 'segredo1' })).status, 200);
  let perfil = (await atleta('GET', '/api/atleta/perfil')).corpo;
  assert.equal(perfil.filter((c) => c.nome === 'Copa Do Dono LGPD' && c.removido).length, 1);

  // Master exclui a conta de outro organizador: mesma protecao.
  const donoAlvo = cliente();
  const donoAlvoConta = await registrarEntrar(donoAlvo, { nome: 'DonoAlvo', email: 'dono-alvo-cg@teste.com', senha: 'segredo1' });
  await montarCopaConectada(donoAlvo, atleta, 'Copa Do Dono Alvo');
  const master = cliente();
  await registrarEntrar(master, { nome: 'Master', email: 'master-cg@teste.com', senha: 'segredo1' });
  bancoTeste.prepare("UPDATE contas SET papel = 'master' WHERE email = 'master-cg@teste.com'").run();
  assert.equal((await master('DELETE', `/api/master/contas/${donoAlvoConta.id}`)).status, 200);
  perfil = (await atleta('GET', '/api/atleta/perfil')).corpo;
  assert.equal(perfil.filter((c) => c.nome === 'Copa Do Dono Alvo' && c.removido).length, 1);

  // E a exclusao da conta do PROPRIO atleta leva os snapshots junto (LGPD).
  assert.equal((await atleta('DELETE', '/api/auth/minha-conta', { confirmacao: 'segredo1' })).status, 200);
  assert.equal(bancoTeste.prepare('SELECT COUNT(*) AS n FROM atleta_estatisticas').get().n >= 0, true);
  const daEva = bancoTeste
    .prepare("SELECT COUNT(*) AS n FROM atleta_estatisticas WHERE campeonato_nome LIKE 'Copa Do Dono%'")
    .get().n;
  assert.equal(daEva, 0);
});

test('congelamento: excluir o jogador do elenco congela o historico antes da cascata', async () => {
  const dono = cliente();
  const atleta = cliente();
  await registrarEntrar(dono, { nome: 'Dono5', email: 'dono5-cg@teste.com', senha: 'segredo1' });
  await registrarEntrar(atleta, { nome: 'Gil', email: 'gil-cg@teste.com', senha: 'segredo1' });
  const { camp, ana } = await montarCopaConectada(dono, atleta, 'Copa Jogador Some');

  assert.equal((await dono('DELETE', `/api/jogadores/${ana.id}`)).status, 200);
  // A conexao caiu em cascata, mas o snapshot ficou (copa VIVA, sem titulo).
  assert.equal((await atleta('GET', '/api/atleta/conexoes')).corpo.length, 0);
  const copa = (await atleta('GET', '/api/atleta/perfil')).corpo[0];
  assert.equal(copa.congelado, true);
  assert.equal(copa.removido, false);
  assert.equal(copa.totais.gols, 2);
  assert.equal(copa.nome, 'Copa Jogador Some');
});

test('congelamento: copa encerrada sem snapshot cai no calculo ao vivo (robustez)', async () => {
  const dono = cliente();
  const atleta = cliente();
  await registrarEntrar(dono, { nome: 'Dono6', email: 'dono6-cg@teste.com', senha: 'segredo1' });
  await registrarEntrar(atleta, { nome: 'Helo', email: 'helo-cg@teste.com', senha: 'segredo1' });
  const { camp, leoes } = await montarCopaConectada(dono, atleta, 'Copa Sem Snapshot');
  await dono('POST', `/api/campeonatos/${camp.id}/encerrar`, { primeiro: leoes.id });
  // Simula um estado anterior a fase D: snapshot apagado por fora.
  bancoTeste.prepare('DELETE FROM atleta_estatisticas WHERE campeonato_id = ?').run(camp.id);
  const copa = (await atleta('GET', '/api/atleta/perfil')).corpo[0];
  assert.equal(copa.congelado, undefined); // caiu no vivo
  assert.equal(copa.totais.jogos, 1);
  assert.equal(copa.colocacao, 1); // podio segue vindo do campeonato vivo
});
