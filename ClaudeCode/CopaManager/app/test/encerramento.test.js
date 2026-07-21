// Encerramento com podio (EF Perfil do Atleta, fase A): sugestao automatica,
// encerrar/reabrir (dono-only), validacoes do podio e podio na pagina publica.
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

// Encerra todos os jogos pendentes de um campeonato com um placar dado.
async function jogarTudo(c, campId, placar = (j, i) => ({ gols_casa: 3 - (i % 3), gols_fora: i % 3 })) {
  for (;;) {
    const det = await c('GET', `/api/campeonatos/${campId}`);
    const pendentes = det.corpo.jogos.filter(
      (j) => j.status !== 'encerrado' && j.time_casa_id && j.time_fora_id,
    );
    if (!pendentes.length) return det.corpo;
    for (const [i, j] of pendentes.entries()) {
      const r = await c('POST', `/api/jogos/${j.id}/resultado`, placar(j, i));
      assert.equal(r.status, 200, JSON.stringify(r.corpo));
    }
  }
}

test('encerramento: pontos corridos — estado, sugestao top 3 e fluxo completo', async () => {
  const dono = cliente();
  await registrarEntrar(dono, { nome: 'Dono', email: 'dono-enc@teste.com', senha: 'segredo1' });
  const criado = await dono('POST', '/api/campeonatos', {
    nome: 'Copa Pontos', formato: 'pontos', sortear: false,
    times: ['Aguia', 'Bufalo', 'Cobra', 'Dragao'],
  });
  assert.equal(criado.status, 201, JSON.stringify(criado.corpo));
  const camp = criado.corpo;

  // Antes de jogar: fim NAO definido, encerrar barra com a contagem de pendentes.
  const est0 = await dono('GET', `/api/campeonatos/${camp.id}/encerramento`);
  assert.equal(est0.status, 200);
  assert.equal(est0.corpo.encerrado, false);
  assert.equal(est0.corpo.fim_definido, false);
  assert.ok(est0.corpo.jogos_pendentes > 0);
  const cedo = await dono('POST', `/api/campeonatos/${camp.id}/encerrar`, { primeiro: 1 });
  assert.equal(cedo.status, 400);
  assert.match(cedo.corpo.mensagem, /sem resultado/);

  // Aguia vence tudo (casa sempre ganha do jeito que o placar foi montado?
  // nao — usa placar deterministico: casa 2 x 0 fora, entao a classificacao
  // segue mando; basta conferir que a sugestao espelha a classificacao real).
  const det = await jogarTudo(dono, camp.id, () => ({ gols_casa: 2, gols_fora: 0 }));

  const est1 = await dono('GET', `/api/campeonatos/${camp.id}/encerramento`);
  assert.equal(est1.corpo.fim_definido, true);
  assert.equal(est1.corpo.jogos_pendentes, 0);
  const classif = det.classificacao[0].linhas;
  assert.deepEqual(est1.corpo.sugestao, {
    primeiro: classif[0].time_id, segundo: classif[1].time_id, terceiro: classif[2].time_id,
  });

  // Encerra com a sugestao; o campeonato passa a carregar encerrado_em + podio.
  const enc = await dono('POST', `/api/campeonatos/${camp.id}/encerrar`, est1.corpo.sugestao);
  assert.equal(enc.status, 200, JSON.stringify(enc.corpo));
  assert.ok(enc.corpo.encerrado_em);
  assert.deepEqual(JSON.parse(enc.corpo.podio), est1.corpo.sugestao);

  // Encerrar de novo: conflito.
  const deNovo = await dono('POST', `/api/campeonatos/${camp.id}/encerrar`, est1.corpo.sugestao);
  assert.equal(deNovo.status, 409);

  // Pagina publica mostra o podio com nomes resolvidos.
  const pub = await dono('GET', `/api/publico/${camp.slug}`);
  assert.equal(pub.corpo.campeonato.encerrado_em, enc.corpo.encerrado_em);
  assert.equal(pub.corpo.podio.primeiro.nome, classif[0].nome);
  assert.equal(pub.corpo.podio.segundo.nome, classif[1].nome);
  assert.equal(pub.corpo.podio.terceiro.nome, classif[2].nome);

  // Reabrir limpa podio e some da publica (RN-AT-12).
  const reab = await dono('POST', `/api/campeonatos/${camp.id}/reabrir`);
  assert.equal(reab.status, 200);
  assert.equal(reab.corpo.encerrado_em, null);
  assert.equal(reab.corpo.podio, null);
  assert.equal((await dono('GET', `/api/publico/${camp.slug}`)).corpo.podio, null);
  // Reabrir sem estar encerrado: conflito.
  assert.equal((await dono('POST', `/api/campeonatos/${camp.id}/reabrir`)).status, 409);
});

test('encerramento: validacoes do podio (obrigatorio, repetido, de outro campeonato)', async () => {
  const dono = cliente();
  await registrarEntrar(dono, { nome: 'Val', email: 'val-enc@teste.com', senha: 'segredo1' });
  const criado = await dono('POST', '/api/campeonatos', {
    nome: 'Copa Valida', formato: 'pontos', sortear: false, times: ['A', 'B'],
  });
  const camp = criado.corpo;
  await jogarTudo(dono, camp.id, () => ({ gols_casa: 1, gols_fora: 0 }));
  const times = (await dono('GET', `/api/campeonatos/${camp.id}`)).corpo.times;

  // Sem campeao: barra.
  const semPrimeiro = await dono('POST', `/api/campeonatos/${camp.id}/encerrar`, {});
  assert.equal(semPrimeiro.status, 400);
  assert.match(semPrimeiro.corpo.mensagem, /campe/i);

  // Posicoes repetidas: barra.
  const repetido = await dono('POST', `/api/campeonatos/${camp.id}/encerrar`, {
    primeiro: times[0].id, segundo: times[0].id,
  });
  assert.equal(repetido.status, 400);
  assert.match(repetido.corpo.mensagem, /repetidas/);

  // Time de OUTRO campeonato: barra (anti cross-tenant tambem).
  const outra = await dono('POST', '/api/campeonatos', {
    nome: 'Outra Copa', formato: 'pontos', sortear: false, times: ['X', 'Y'],
  });
  const timeAlheio = (await dono('GET', `/api/campeonatos/${outra.corpo.id}`)).corpo.times[0];
  const alheio = await dono('POST', `/api/campeonatos/${camp.id}/encerrar`, { primeiro: timeAlheio.id });
  assert.equal(alheio.status, 400);
  assert.match(alheio.corpo.mensagem, /deste campeonato/);

  // Com 2 times nao existe 3o: encerrar so com campeao e valido.
  const ok = await dono('POST', `/api/campeonatos/${camp.id}/encerrar`, { primeiro: times[0].id });
  assert.equal(ok.status, 200, JSON.stringify(ok.corpo));
  assert.deepEqual(JSON.parse(ok.corpo.podio), { primeiro: times[0].id, segundo: null, terceiro: null });
});

test('encerramento: mata-mata sugere campeao e vice da final; 3o fica em aberto', async () => {
  const dono = cliente();
  await registrarEntrar(dono, { nome: 'Mata', email: 'mata-enc@teste.com', senha: 'segredo1' });
  const criado = await dono('POST', '/api/campeonatos', {
    nome: 'Copa Mata', formato: 'mata', sortear: false,
    times: ['A', 'B', 'C', 'D'], // chaveamento por lista: A x B, C x D
  });
  const camp = criado.corpo;
  // Semis e final: o mandante sempre vence (A e C avancam; final A x C -> A campeao).
  await jogarTudo(dono, camp.id, () => ({ gols_casa: 1, gols_fora: 0 }));

  const est = await dono('GET', `/api/campeonatos/${camp.id}/encerramento`);
  assert.equal(est.corpo.fim_definido, true);
  const det = await dono('GET', `/api/campeonatos/${camp.id}`);
  const final = det.corpo.jogos.filter((j) => j.fase === 'mata').sort((a, b) => b.rodada - a.rodada)[0];
  assert.equal(est.corpo.sugestao.primeiro, final.gols_casa > final.gols_fora ? final.time_casa_id : final.time_fora_id);
  assert.equal(est.corpo.sugestao.segundo, final.gols_casa > final.gols_fora ? final.time_fora_id : final.time_casa_id);
  // Sem disputa de 3o lugar, o sistema nao chuta o 3o (EF 2.2): gestor decide.
  assert.equal(est.corpo.sugestao.terceiro, null);
});

test('encerramento: grupos_mata sem mata gerado NAO tem fim definido', async () => {
  const dono = cliente();
  await registrarEntrar(dono, { nome: 'Grupos', email: 'grupos-enc@teste.com', senha: 'segredo1' });
  const criado = await dono('POST', '/api/campeonatos', {
    nome: 'Copa Grupos', formato: 'grupos_mata', sortear: false,
    num_grupos: 2, classificados_por_grupo: 2,
    times: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
  });
  const camp = criado.corpo;
  // Toda a fase de grupos jogada, mas o mata ainda nao foi gerado:
  // a copa termina no mata — fim ainda nao definido (EF 3.5).
  await jogarTudo(dono, camp.id, () => ({ gols_casa: 2, gols_fora: 1 }));
  const est = await dono('GET', `/api/campeonatos/${camp.id}/encerramento`);
  assert.equal(est.corpo.jogos_pendentes, 0);
  assert.equal(est.corpo.fim_definido, false);
  // Gera o mata e joga tudo: agora sim.
  assert.equal((await dono('POST', `/api/campeonatos/${camp.id}/gerar-mata`)).status, 201);
  await jogarTudo(dono, camp.id, () => ({ gols_casa: 1, gols_fora: 0 }));
  const est2 = await dono('GET', `/api/campeonatos/${camp.id}/encerramento`);
  assert.equal(est2.corpo.fim_definido, true);
  assert.ok(est2.corpo.sugestao.primeiro);
});

test('encerramento: Pelada Epica sugere o top 3 do ranking e so aceita jogador fixo', async () => {
  const dono = cliente();
  await registrarEntrar(dono, { nome: 'Pelada', email: 'pelada-enc@teste.com', senha: 'segredo1' });
  const criado = await dono('POST', '/api/campeonatos', {
    nome: 'Pelada de Sabado', esporte: 'pelada_epica', jogos_temporada: 10,
    times: ['Verde', 'Amarelo'],
    jogadores_fixos: ['Ana', 'Bia', 'Caio', 'Duda'],
    jogadores_suplentes: ['Eva'],
  });
  assert.equal(criado.status, 201, JSON.stringify(criado.corpo));
  const camp = criado.corpo;
  const det = await dono('GET', `/api/campeonatos/${camp.id}`);
  const [verde, amarelo] = det.corpo.times;
  const j = (nome) => det.corpo.jogadores.find((x) => x.nome === nome);

  // Um jogo: Ana e Bia (Verde) vencem Caio e Duda (Amarelo). Eva de fora.
  const jogo = await dono('POST', `/api/campeonatos/${camp.id}/jogos`, {
    time_casa_id: verde.id, time_fora_id: amarelo.id,
  });
  assert.equal(jogo.status, 201, JSON.stringify(jogo.corpo));
  const res = await dono('POST', `/api/jogos/${jogo.corpo.id}/resultado`, {
    gols_casa: 2, gols_fora: 0,
    escalacoes: [
      { jogador_id: j('Ana').id, time_id: verde.id }, { jogador_id: j('Bia').id, time_id: verde.id },
      { jogador_id: j('Caio').id, time_id: amarelo.id }, { jogador_id: j('Duda').id, time_id: amarelo.id },
    ],
    eventos: [
      { tipo: 'gol', time_id: verde.id, jogador_id: j('Ana').id },
      { tipo: 'gol', time_id: verde.id, jogador_id: j('Ana').id },
    ],
  });
  assert.equal(res.status, 200, JSON.stringify(res.corpo));

  // Sugestao segue o ranking (Ana lidera com gols de desempate).
  const est = await dono('GET', `/api/campeonatos/${camp.id}/encerramento`);
  assert.equal(est.corpo.fim_definido, true);
  const ranking = (await dono('GET', `/api/campeonatos/${camp.id}`)).corpo.classificacao[0].linhas;
  assert.equal(est.corpo.sugestao.primeiro, ranking[0].jogador_id);
  assert.equal(ranking[0].nome, 'Ana');

  // Suplente (coringa) nao entra no podio (RN-PE-01).
  const suplente = await dono('POST', `/api/campeonatos/${camp.id}/encerrar`, { primeiro: j('Eva').id });
  assert.equal(suplente.status, 400);
  assert.match(suplente.corpo.mensagem, /jogador fixo/);

  // Encerrar com o podio do ranking: ok, e a publica resolve nomes de jogadores.
  const enc = await dono('POST', `/api/campeonatos/${camp.id}/encerrar`, est.corpo.sugestao);
  assert.equal(enc.status, 200, JSON.stringify(enc.corpo));
  const pub = await dono('GET', `/api/publico/${camp.slug}`);
  assert.equal(pub.corpo.podio.primeiro.nome, 'Ana');
});

test('encerramento: encerrar, reabrir e ver estado sao dono-only (colaborador leva 403)', async () => {
  const dono = cliente();
  const colab = cliente();
  await registrarEntrar(dono, { nome: 'Dona', email: 'dona-enc@teste.com', senha: 'segredo1' });
  await registrarEntrar(colab, { nome: 'Colab', email: 'colab-enc@teste.com', senha: 'segredo1' });
  const criado = await dono('POST', '/api/campeonatos', {
    nome: 'Copa da Dona', formato: 'pontos', sortear: false, times: ['A', 'B'],
  });
  const camp = criado.corpo;
  await jogarTudo(dono, camp.id, () => ({ gols_casa: 1, gols_fora: 0 }));
  // Colaborador com TODAS as flags: mesmo assim encerrar e dono-only (RN-CO-05).
  const convite = await dono('POST', `/api/campeonatos/${camp.id}/colaboradores`, {
    email: 'colab-enc@teste.com', pode_jogos: true, pode_times: true, pode_regras: true,
  });
  assert.equal(convite.status, 201, JSON.stringify(convite.corpo));

  assert.equal((await colab('GET', `/api/campeonatos/${camp.id}/encerramento`)).status, 403);
  const timeA = (await dono('GET', `/api/campeonatos/${camp.id}`)).corpo.times[0];
  assert.equal((await colab('POST', `/api/campeonatos/${camp.id}/encerrar`, { primeiro: timeA.id })).status, 403);
  assert.equal((await colab('POST', `/api/campeonatos/${camp.id}/reabrir`)).status, 403);

  // Quem nao tem vinculo nenhum: 404 (anti-enumeracao, RN-CO-06).
  const estranho = cliente();
  await registrarEntrar(estranho, { nome: 'Estranho', email: 'estranho-enc@teste.com', senha: 'segredo1' });
  assert.equal((await estranho('GET', `/api/campeonatos/${camp.id}/encerramento`)).status, 404);
});

test('encerramento: excluir campeonato encerrado segue funcionando', async () => {
  const dono = cliente();
  await registrarEntrar(dono, { nome: 'Fim', email: 'fim-enc@teste.com', senha: 'segredo1' });
  const criado = await dono('POST', '/api/campeonatos', {
    nome: 'Copa Que Vai Sumir', formato: 'pontos', sortear: false, times: ['A', 'B'],
  });
  const camp = criado.corpo;
  await jogarTudo(dono, camp.id, () => ({ gols_casa: 1, gols_fora: 0 }));
  const timeA = (await dono('GET', `/api/campeonatos/${camp.id}`)).corpo.times[0];
  assert.equal((await dono('POST', `/api/campeonatos/${camp.id}/encerrar`, { primeiro: timeA.id })).status, 200);
  assert.equal((await dono('DELETE', `/api/campeonatos/${camp.id}`)).status, 200);
  assert.equal((await dono('GET', `/api/campeonatos/${camp.id}`)).status, 404);
});
