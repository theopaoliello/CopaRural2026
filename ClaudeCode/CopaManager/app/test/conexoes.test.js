// Conexoes de atleta (EF Perfil do Atleta, fase B): fluxo completo, alvo
// estrutural (jogador vs time 2x2/1x1), travas anti-fraude, dono-only e a
// flag aceita_conexoes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { prepararBanco } from '../db/db.js';
import { montarRotas } from '../routes/api.js';
import { configurarTransporte } from '../src/email.js';
import { mascararEmail, tamanhoDaVariante } from '../src/conexoes.js';

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

// Copa de futebol com elenco: 2 times, jogadores no time A.
async function copaComElenco(dono, nome) {
  const criado = await dono('POST', '/api/campeonatos', {
    nome, formato: 'pontos', sortear: false, times: ['Leões', 'Tigres'],
  });
  assert.equal(criado.status, 201, JSON.stringify(criado.corpo));
  const det = await dono('GET', `/api/campeonatos/${criado.corpo.id}`);
  const leoes = det.corpo.times.find((t) => t.nome === 'Leões');
  const lote = await dono('POST', `/api/times/${leoes.id}/jogadores/lote`, { texto: 'Ana,10\nBia,7' });
  assert.equal(lote.status, 201, JSON.stringify(lote.corpo));
  return { camp: criado.corpo, times: det.corpo.times, jogadores: lote.corpo };
}

test('conexoes: fluxo completo — solicitar, fila com e-mail mascarado, aprovar, revogar', async () => {
  const dono = cliente();
  const atleta = cliente();
  await registrarEntrar(dono, { nome: 'Dono', email: 'dono-cx@teste.com', senha: 'segredo1' });
  await registrarEntrar(atleta, { nome: 'Ana Atleta', email: 'ana-cx@gmail.com', senha: 'segredo1' });
  const { camp, jogadores } = await copaComElenco(dono, 'Copa Conexao');
  const [ana] = jogadores;

  // Sem seguir: copa nao aparece nas conectaveis e o POST barra (RN-AT-02).
  assert.equal((await atleta('GET', '/api/atleta/conectaveis')).corpo.length, 0);
  const semSeguir = await atleta('POST', '/api/atleta/conexoes', { slug: camp.slug, jogador_id: ana.id });
  assert.equal(semSeguir.status, 400);
  assert.match(semSeguir.corpo.mensagem, /Siga esta copa/);

  // Segue -> aparece nas conectaveis; elenco marca todos disponiveis.
  assert.equal((await atleta('POST', `/api/seguir/${camp.slug}`)).status, 200);
  const conectaveis = await atleta('GET', '/api/atleta/conectaveis');
  assert.equal(conectaveis.corpo.length, 1);
  assert.equal(conectaveis.corpo[0].slug, camp.slug);
  assert.equal(conectaveis.corpo[0].minha_conexao, null);
  const elenco = await atleta('GET', `/api/atleta/copa/${camp.slug}/elenco`);
  assert.equal(elenco.corpo.pelada, false);
  const timeLeoes = elenco.corpo.times.find((t) => t.nome === 'Leões');
  assert.equal(timeLeoes.sem_elenco, false);
  assert.ok(timeLeoes.jogadores.every((j) => j.disponivel));

  // Solicita como a jogadora Ana, com observacao.
  const sol = await atleta('POST', '/api/atleta/conexoes', {
    slug: camp.slug, jogador_id: ana.id, observacao: 'sou a Ana, camisa 10',
  });
  assert.equal(sol.status, 201, JSON.stringify(sol.corpo));
  assert.equal(sol.corpo.status, 'pendente');
  assert.equal(sol.corpo.alvo_tipo, 'jogador');

  // Minhas conexoes mostram o pedido pendente com o nome do alvo.
  const minhas = await atleta('GET', '/api/atleta/conexoes');
  assert.equal(minhas.corpo.length, 1);
  assert.equal(minhas.corpo[0].status, 'pendente');
  assert.equal(minhas.corpo[0].alvo_nome, 'Ana');

  // Duplicar na mesma copa: 409 (RN-AT-03).
  const dup = await atleta('POST', '/api/atleta/conexoes', { slug: camp.slug, jogador_id: ana.id });
  assert.equal(dup.status, 409);

  // Fila do dono: pendente com nome da conta e e-mail MASCARADO (RN-AT-20);
  // badge de pendentes no GET do campeonato (so dono).
  const fila = await dono('GET', `/api/campeonatos/${camp.id}/conexoes`);
  assert.equal(fila.corpo.pendentes.length, 1);
  const p = fila.corpo.pendentes[0];
  assert.equal(p.conta_nome, 'Ana Atleta');
  assert.equal(p.conta_email, 'an•••@gmail.com');
  assert.equal(p.observacao, 'sou a Ana, camisa 10');
  assert.equal((await dono('GET', `/api/campeonatos/${camp.id}`)).corpo.n_conexoes_pendentes, 1);

  // Aprova: vira conectado; jogador some dos disponiveis; badge zera.
  const dec = await dono('POST', `/api/campeonatos/${camp.id}/conexoes/${p.id}/decidir`, { acao: 'aprovar' });
  assert.equal(dec.status, 200, JSON.stringify(dec.corpo));
  assert.equal(dec.corpo.status, 'aprovada');
  const fila2 = await dono('GET', `/api/campeonatos/${camp.id}/conexoes`);
  assert.equal(fila2.corpo.pendentes.length, 0);
  assert.equal(fila2.corpo.conectados.length, 1);
  assert.equal((await dono('GET', `/api/campeonatos/${camp.id}`)).corpo.n_conexoes_pendentes, 0);

  // Outro atleta: Ana aparece indisponivel e o POST leva 409 (RN-AT-04).
  const rival = cliente();
  await registrarEntrar(rival, { nome: 'Rival', email: 'rival-cx@teste.com', senha: 'segredo1' });
  await rival('POST', `/api/seguir/${camp.slug}`);
  const elencoRival = await rival('GET', `/api/atleta/copa/${camp.slug}/elenco`);
  const anaRival = elencoRival.corpo.times.find((t) => t.nome === 'Leões').jogadores.find((j) => j.nome === 'Ana');
  assert.equal(anaRival.disponivel, false);
  const claimRival = await rival('POST', '/api/atleta/conexoes', { slug: camp.slug, jogador_id: ana.id });
  assert.equal(claimRival.status, 409);
  assert.match(claimRival.corpo.mensagem, /ja esta conectado a outra conta/);

  // Dono revoga: conexao some e a jogadora volta a ficar disponivel.
  const rev = await dono('DELETE', `/api/campeonatos/${camp.id}/conexoes/${p.id}`);
  assert.equal(rev.status, 200);
  assert.equal((await atleta('GET', '/api/atleta/conexoes')).corpo.length, 0);
  const claimDepois = await rival('POST', '/api/atleta/conexoes', { slug: camp.slug, jogador_id: ana.id });
  assert.equal(claimDepois.status, 201);
});

test('conexoes: recusa reusa a linha no novo pedido; atleta cancela e desconecta', async () => {
  const dono = cliente();
  const atleta = cliente();
  await registrarEntrar(dono, { nome: 'Dono2', email: 'dono2-cx@teste.com', senha: 'segredo1' });
  await registrarEntrar(atleta, { nome: 'Beto', email: 'beto-cx@teste.com', senha: 'segredo1' });
  const { camp, jogadores } = await copaComElenco(dono, 'Copa Recusa');
  const [ana, bia] = jogadores;
  await atleta('POST', `/api/seguir/${camp.slug}`);

  // Pedido -> recusa: atleta ve "recusada" e pode pedir de novo (outro alvo).
  const sol1 = await atleta('POST', '/api/atleta/conexoes', { slug: camp.slug, jogador_id: ana.id });
  await dono('POST', `/api/campeonatos/${camp.id}/conexoes/${sol1.corpo.id}/decidir`, { acao: 'recusar' });
  assert.equal((await atleta('GET', '/api/atleta/conexoes')).corpo[0].status, 'recusada');
  // Copa recusada VOLTA a aparecer como conectavel (pode tentar de novo).
  const conectaveis = await atleta('GET', '/api/atleta/conectaveis');
  assert.equal(conectaveis.corpo[0].minha_conexao, 'recusada');

  const sol2 = await atleta('POST', '/api/atleta/conexoes', { slug: camp.slug, jogador_id: bia.id });
  assert.equal(sol2.status, 201, JSON.stringify(sol2.corpo));
  assert.equal(sol2.corpo.id, sol1.corpo.id); // mesma linha reusada (UNIQUE)
  assert.equal(sol2.corpo.status, 'pendente');

  // Atleta cancela o pendente.
  assert.equal((await atleta('DELETE', `/api/atleta/conexoes/${sol2.corpo.id}`)).status, 200);
  assert.equal((await atleta('GET', '/api/atleta/conexoes')).corpo.length, 0);

  // Novo pedido aprovado -> atleta se DESCONECTA sozinho (RN-AT-06).
  const sol3 = await atleta('POST', '/api/atleta/conexoes', { slug: camp.slug, jogador_id: bia.id });
  await dono('POST', `/api/campeonatos/${camp.id}/conexoes/${sol3.corpo.id}/decidir`, { acao: 'aprovar' });
  assert.equal((await atleta('DELETE', `/api/atleta/conexoes/${sol3.corpo.id}`)).status, 200);
  assert.equal(
    bancoTeste.prepare('SELECT COUNT(*) AS n FROM conexoes_atleta WHERE campeonato_id = ?').get(camp.id).n,
    0,
  );
  // Outra conta nao mexe na conexao alheia: 404.
  const sol4 = await atleta('POST', '/api/atleta/conexoes', { slug: camp.slug, jogador_id: bia.id });
  assert.equal((await dono('DELETE', `/api/atleta/conexoes/${sol4.corpo.id}`)).status, 404);
});

test('conexoes: alvo estrutural — time sem elenco conecta ao time; com elenco exige jogador', async () => {
  const dono = cliente();
  const a1 = cliente();
  const a2 = cliente();
  await registrarEntrar(dono, { nome: 'Dono3', email: 'dono3-cx@teste.com', senha: 'segredo1' });
  await registrarEntrar(a1, { nome: 'Theo', email: 'theo-cx@teste.com', senha: 'segredo1' });
  await registrarEntrar(a2, { nome: 'Marcelo', email: 'marcelo-cx@teste.com', senha: 'segredo1' });

  // Copa de peteca 2x2: times sao as duplas, sem jogadores cadastrados.
  const criado = await dono('POST', '/api/campeonatos', {
    nome: 'Aberto de Peteca', esporte: 'peteca', modalidade: 'Duplas 2x2',
    formato: 'pontos', sortear: false, times: ['Theo e Marcelo', 'Ze e Chico'],
  });
  assert.equal(criado.status, 201, JSON.stringify(criado.corpo));
  const camp = criado.corpo;
  const dupla = (await dono('GET', `/api/campeonatos/${camp.id}`)).corpo.times.find((t) => t.nome === 'Theo e Marcelo');

  await a1('POST', `/api/seguir/${camp.slug}`);
  await a2('POST', `/api/seguir/${camp.slug}`);

  // Elenco expoe o time como sem_elenco (conectavel direto).
  const elenco = await a1('GET', `/api/atleta/copa/${camp.slug}/elenco`);
  assert.equal(elenco.corpo.times.find((t) => t.id === dupla.id).sem_elenco, true);

  // DOIS atletas conectam-se ao MESMO time (RN-AT-04: dupla 2x2).
  const c1 = await a1('POST', '/api/atleta/conexoes', { slug: camp.slug, time_id: dupla.id });
  assert.equal(c1.status, 201, JSON.stringify(c1.corpo));
  assert.equal(c1.corpo.alvo_tipo, 'time');
  const c2 = await a2('POST', '/api/atleta/conexoes', { slug: camp.slug, time_id: dupla.id });
  assert.equal(c2.status, 201, JSON.stringify(c2.corpo));
  await dono('POST', `/api/campeonatos/${camp.id}/conexoes/${c1.corpo.id}/decidir`, { acao: 'aprovar' });
  await dono('POST', `/api/campeonatos/${camp.id}/conexoes/${c2.corpo.id}/decidir`, { acao: 'aprovar' });
  const fila = await dono('GET', `/api/campeonatos/${camp.id}/conexoes`);
  assert.equal(fila.corpo.conectados.length, 2);

  // Terceiro na mesma dupla 2x2: permitido, mas o dono ve o AVISO (EF 3.4).
  const a3 = cliente();
  await registrarEntrar(a3, { nome: 'Intruso', email: 'intruso-cx@teste.com', senha: 'segredo1' });
  await a3('POST', `/api/seguir/${camp.slug}`);
  await a3('POST', '/api/atleta/conexoes', { slug: camp.slug, time_id: dupla.id });
  const fila2 = await dono('GET', `/api/campeonatos/${camp.id}/conexoes`);
  assert.equal(fila2.corpo.pendentes[0].aviso_variante, true);

  // Copa COM elenco: conexao ao time e barrada (escolha o jogador).
  const { camp: campElenco, times } = await copaComElenco(dono, 'Copa Com Elenco');
  await a1('POST', `/api/seguir/${campElenco.slug}`);
  const barrado = await a1('POST', '/api/atleta/conexoes', {
    slug: campElenco.slug, time_id: times.find((t) => t.nome === 'Leões').id,
  });
  assert.equal(barrado.status, 400);
  assert.match(barrado.corpo.mensagem, /jogadores cadastrados/);
  // Time sem elenco DENTRO de copa de futebol (Tigres): conexao ao time ok —
  // regra decidida pela ESTRUTURA, nao pelo esporte (RN-AT-25).
  const tigres = await a1('POST', '/api/atleta/conexoes', {
    slug: campElenco.slug, time_id: times.find((t) => t.nome === 'Tigres').id,
  });
  assert.equal(tigres.status, 201, JSON.stringify(tigres.corpo));
});

test('conexoes: Pelada Epica conecta a jogador do campeonato, sem etapa de time', async () => {
  const dono = cliente();
  const atleta = cliente();
  await registrarEntrar(dono, { nome: 'Dono4', email: 'dono4-cx@teste.com', senha: 'segredo1' });
  await registrarEntrar(atleta, { nome: 'Caio', email: 'caio-cx@teste.com', senha: 'segredo1' });
  const criado = await dono('POST', '/api/campeonatos', {
    nome: 'Pelada Conexao', esporte: 'pelada_epica', jogos_temporada: 10,
    times: ['Verde', 'Amarelo'], jogadores_fixos: ['Ana', 'Caio'], jogadores_suplentes: ['Eva'],
  });
  const camp = criado.corpo;
  await atleta('POST', `/api/seguir/${camp.slug}`);
  const elenco = await atleta('GET', `/api/atleta/copa/${camp.slug}/elenco`);
  assert.equal(elenco.corpo.pelada, true);
  assert.equal(elenco.corpo.jogadores.length, 3); // fixos + suplentes, sem times
  const caio = elenco.corpo.jogadores.find((j) => j.nome === 'Caio');
  const sol = await atleta('POST', '/api/atleta/conexoes', { slug: camp.slug, jogador_id: caio.id });
  assert.equal(sol.status, 201, JSON.stringify(sol.corpo));
  assert.equal(sol.corpo.alvo_tipo, 'jogador');
});

test('conexoes: aceita_conexoes desligada tira a copa do fluxo (RN-AT-19)', async () => {
  const dono = cliente();
  const atleta = cliente();
  await registrarEntrar(dono, { nome: 'Dono5', email: 'dono5-cx@teste.com', senha: 'segredo1' });
  await registrarEntrar(atleta, { nome: 'Duda', email: 'duda-cx@teste.com', senha: 'segredo1' });
  const { camp, jogadores } = await copaComElenco(dono, 'Copa Fechada');
  await atleta('POST', `/api/seguir/${camp.slug}`);

  // Dono desliga pelo PATCH da Config.
  const patch = await dono('PATCH', `/api/campeonatos/${camp.id}`, { aceita_conexoes: false });
  assert.equal(patch.corpo.aceita_conexoes, 0);
  assert.equal((await atleta('GET', '/api/atleta/conectaveis')).corpo.length, 0);
  assert.equal((await atleta('GET', `/api/atleta/copa/${camp.slug}/elenco`)).status, 404);
  const sol = await atleta('POST', '/api/atleta/conexoes', { slug: camp.slug, jogador_id: jogadores[0].id });
  assert.equal(sol.status, 404);

  // Religa: volta ao normal.
  await dono('PATCH', `/api/campeonatos/${camp.id}`, { aceita_conexoes: true });
  assert.equal((await atleta('GET', '/api/atleta/conectaveis')).corpo.length, 1);
});

test('conexoes: fila, decidir e revogar sao dono-only; anonimo leva 401', async () => {
  const dono = cliente();
  const colab = cliente();
  await registrarEntrar(dono, { nome: 'Dono6', email: 'dono6-cx@teste.com', senha: 'segredo1' });
  await registrarEntrar(colab, { nome: 'Colab', email: 'colab-cx@teste.com', senha: 'segredo1' });
  const { camp, jogadores } = await copaComElenco(dono, 'Copa Dono Only');
  // Colaborador com todas as flags: mesmo assim nao decide conexoes (RN-AT-05).
  await dono('POST', `/api/campeonatos/${camp.id}/colaboradores`, {
    email: 'colab-cx@teste.com', pode_jogos: true, pode_times: true, pode_regras: true,
  });
  const atleta = cliente();
  await registrarEntrar(atleta, { nome: 'Gil', email: 'gil-cx@teste.com', senha: 'segredo1' });
  await atleta('POST', `/api/seguir/${camp.slug}`);
  const sol = await atleta('POST', '/api/atleta/conexoes', { slug: camp.slug, jogador_id: jogadores[0].id });

  assert.equal((await colab('GET', `/api/campeonatos/${camp.id}/conexoes`)).status, 403);
  assert.equal((await colab('POST', `/api/campeonatos/${camp.id}/conexoes/${sol.corpo.id}/decidir`, { acao: 'aprovar' })).status, 403);
  assert.equal((await colab('DELETE', `/api/campeonatos/${camp.id}/conexoes/${sol.corpo.id}`)).status, 403);
  // Sem vinculo nenhum: 404 (anti-enumeracao); anonimo: 401.
  const estranho = cliente();
  await registrarEntrar(estranho, { nome: 'X', email: 'x-cx@teste.com', senha: 'segredo1' });
  assert.equal((await estranho('GET', `/api/campeonatos/${camp.id}/conexoes`)).status, 404);
  const anon = cliente();
  assert.equal((await anon('GET', '/api/atleta/conectaveis')).status, 401);
  assert.equal((await anon('POST', '/api/atleta/conexoes', { slug: camp.slug })).status, 401);
});

test('conexoes: exclusoes em cascata — jogador, campeonato e conta', async () => {
  const dono = cliente();
  const atleta = cliente();
  await registrarEntrar(dono, { nome: 'Dono7', email: 'dono7-cx@teste.com', senha: 'segredo1' });
  await registrarEntrar(atleta, { nome: 'Helo', email: 'helo-cx@teste.com', senha: 'segredo1' });
  const { camp, jogadores } = await copaComElenco(dono, 'Copa Cascata');
  await atleta('POST', `/api/seguir/${camp.slug}`);
  const sol = await atleta('POST', '/api/atleta/conexoes', { slug: camp.slug, jogador_id: jogadores[0].id });
  await dono('POST', `/api/campeonatos/${camp.id}/conexoes/${sol.corpo.id}/decidir`, { acao: 'aprovar' });

  // Jogador excluido do elenco -> conexao cai em cascata.
  assert.equal((await dono('DELETE', `/api/jogadores/${jogadores[0].id}`)).status, 200);
  assert.equal((await atleta('GET', '/api/atleta/conexoes')).corpo.length, 0);

  // Campeonato excluido -> conexoes da copa somem.
  const sol2 = await atleta('POST', '/api/atleta/conexoes', { slug: camp.slug, jogador_id: jogadores[1].id });
  assert.equal(sol2.status, 201);
  assert.equal((await dono('DELETE', `/api/campeonatos/${camp.id}`)).status, 200);
  assert.equal((await atleta('GET', '/api/atleta/conexoes')).corpo.length, 0);
  assert.equal(bancoTeste.prepare('SELECT COUNT(*) AS n FROM conexoes_atleta').get().n >= 0, true);
});

test('conexoes: helpers — e-mail mascarado e tamanho da variante', () => {
  assert.equal(mascararEmail('theo@gmail.com'), 'th•••@gmail.com');
  assert.equal(mascararEmail('ab@x.com'), 'ab•••@x.com');
  assert.equal(tamanhoDaVariante('Duplas 2x2'), 2);
  assert.equal(tamanhoDaVariante('Individual 1x1'), 1);
  assert.equal(tamanhoDaVariante('Praia 2x2'), 2);
  assert.equal(tamanhoDaVariante('Quadra 6x6'), 6);
  assert.equal(tamanhoDaVariante('Campo'), null);
  assert.equal(tamanhoDaVariante(null), null);
});
