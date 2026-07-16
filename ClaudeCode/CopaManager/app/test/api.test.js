// Teste de integracao da API: fluxo completo do organizador + isolamento multi-tenant.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { prepararBanco } from '../db/db.js';
import { montarRotas } from '../routes/api.js';
import { configurarTransporte } from '../src/email.js';
import { contaViaGoogle, registrarConta } from '../src/auth.js';

let servidor;
let base;
let bancoTeste;

// Captura os e-mails enviados (nenhuma rede nos testes).
const emails = [];
configurarTransporte(async (m) => { emails.push(m); });
const tokenDoUltimoEmail = (para) =>
  [...emails].reverse().find((e) => e.para === para.toLowerCase())?.texto.match(/token=([0-9a-f]+)/)?.[1];

// Registra com consentimento, confirma o e-mail (o que ja abre a sessao) e
// devolve a conta { id, nome, email } — o fluxo real do produto, a cada teste.
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
  // Limites folgados: este arquivo registra/loga dezenas de vezes do mesmo IP.
  app.use('/api', montarRotas(db, {
    limites: {
      login: { max: 1000 }, registro: { max: 1000 },
      confirmacao: { max: 1000 }, reenvio: { max: 1000 },
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

// Cliente HTTP minimo com cookie de sessao.
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

test('fluxo completo: conta, campeonato, resultados, classificacao e pagina publica', async () => {
  const alice = cliente();

  // registro + confirmacao de e-mail abrem a sessao
  await registrarEntrar(alice, { nome: 'Alice', email: 'alice@teste.com', senha: 'segredo1' });

  // cria campeonato de pontos corridos com 4 times, sem sorteio (ordem previsivel)
  const criado = await alice('POST', '/api/campeonatos', {
    nome: 'Copa Teste', temporada: '2026', formato: 'pontos', sortear: false,
    times: ['Aguia', 'Bufalo', 'Cobra', 'Dragao'],
  });
  assert.equal(criado.status, 201);
  const campId = criado.corpo.id;
  assert.ok(criado.corpo.slug.includes('copa-teste'));

  const det = await alice('GET', `/api/campeonatos/${campId}`);
  assert.equal(det.corpo.times.length, 4);
  assert.equal(det.corpo.jogos.length, 6); // 4 times, turno unico

  // adiciona jogadores a um time
  const aguia = det.corpo.times.find((t) => t.nome === 'Aguia');
  const bufalo = det.corpo.times.find((t) => t.nome === 'Bufalo');
  const j1 = await alice('POST', `/api/times/${aguia.id}/jogadores`, { nome: 'Pele', numero: 10 });
  assert.equal(j1.status, 201);

  // lanca resultado com gol do Pele e cartao
  const jogo = det.corpo.jogos.find(
    (j) => (j.time_casa_id === aguia.id && j.time_fora_id === bufalo.id) ||
           (j.time_casa_id === bufalo.id && j.time_fora_id === aguia.id),
  );
  const aguiaEmCasa = jogo.time_casa_id === aguia.id;
  const res = await alice('POST', `/api/jogos/${jogo.id}/resultado`, {
    gols_casa: aguiaEmCasa ? 2 : 0,
    gols_fora: aguiaEmCasa ? 0 : 2,
    eventos: [
      { tipo: 'gol', time_id: aguia.id, jogador_id: j1.corpo.id },
      { tipo: 'amarelo', time_id: bufalo.id },
    ],
  });
  assert.equal(res.status, 200, JSON.stringify(res.corpo));

  // classificacao recalculada: Aguia lider com 3 pts e ultimos = ['V']
  const det2 = await alice('GET', `/api/campeonatos/${campId}`);
  const linhas = det2.corpo.classificacao[0].linhas;
  assert.equal(linhas[0].nome, 'Aguia');
  assert.equal(linhas[0].pts, 3);
  assert.deepEqual(linhas[0].ultimos, ['V']);

  // pagina publica traz artilharia com o Pele
  const pub = await cliente()('GET', `/api/publico/${criado.corpo.slug}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.corpo.artilharia[0].nome, 'Pele');
  assert.equal(pub.corpo.artilharia[0].gols, 1);

  // corrigir resultado: apagar volta o jogo para agendado e zera a tabela
  const del = await alice('DELETE', `/api/jogos/${jogo.id}/resultado`);
  assert.equal(del.status, 200);
  const det3 = await alice('GET', `/api/campeonatos/${campId}`);
  assert.ok(det3.corpo.classificacao[0].linhas.every((l) => l.pts === 0));
});

test('validacao: gols de jogadores nao podem exceder o placar', async () => {
  const c = cliente();
  await registrarEntrar(c, { nome: 'Val', email: 'val@teste.com', senha: 'segredo1' });
  const criado = await c('POST', '/api/campeonatos', {
    nome: 'Valida', formato: 'pontos', sortear: false, times: ['X', 'Y'],
  });
  const det = await c('GET', `/api/campeonatos/${criado.corpo.id}`);
  const jogo = det.corpo.jogos[0];
  const timeX = det.corpo.times.find((t) => t.nome === 'X');
  const resp = await c('POST', `/api/jogos/${jogo.id}/resultado`, {
    gols_casa: 0, gols_fora: 0,
    eventos: [{ tipo: 'gol', time_id: timeX.id }],
  });
  assert.equal(resp.status, 400);
  assert.match(resp.corpo.mensagem, /mais gols/);
});

test('resultado simples: gols SR (sem registro de autor) valem no placar e na sumula', async () => {
  const c = cliente();
  await registrarEntrar(c, { nome: 'Sim', email: 'sim@teste.com', senha: 'segredo1' });
  const criado = await c('POST', '/api/campeonatos', {
    nome: 'Simples', formato: 'pontos', sortear: false, times: ['P', 'Q'],
  });
  const det = await c('GET', `/api/campeonatos/${criado.corpo.id}`);
  const jogo = det.corpo.jogos[0];

  // Placar simples: um evento de gol com jogador_id null (SR) por gol.
  const resp = await c('POST', `/api/jogos/${jogo.id}/resultado`, {
    gols_casa: 2, gols_fora: 1,
    eventos: [
      { tipo: 'gol', time_id: jogo.time_casa_id, jogador_id: null },
      { tipo: 'gol', time_id: jogo.time_casa_id, jogador_id: null },
      { tipo: 'gol', time_id: jogo.time_fora_id, jogador_id: null },
    ],
  });
  assert.equal(resp.status, 200, JSON.stringify(resp.corpo));
  assert.equal(resp.corpo.gols_casa, 2);
  assert.equal(resp.corpo.status, 'encerrado');

  // Pagina publica: os 3 gols aparecem nos eventos sem autor; artilharia vazia.
  const pub = await cliente()('GET', `/api/publico/${criado.corpo.slug}`);
  const golsSR = pub.corpo.eventos.filter((e) => e.jogo_id === jogo.id && e.tipo === 'gol');
  assert.equal(golsSR.length, 3);
  assert.ok(golsSR.every((e) => e.jogador_id == null));
  assert.equal(pub.corpo.artilharia.length, 0);
});

test('regras do campeonato: PATCH salva, pagina publica expoe e da para limpar', async () => {
  const c = cliente();
  await registrarEntrar(c, { nome: 'Reg', email: 'reg@teste.com', senha: 'segredo1' });
  const criado = await c('POST', '/api/campeonatos', {
    nome: 'Com Regras', formato: 'pontos', sortear: false, times: ['R1', 'R2'],
  });
  const texto = '1. Sem carrinho.\n2. Tolerancia de 15 minutos.';
  const patch = await c('PATCH', `/api/campeonatos/${criado.corpo.id}`, { regras: texto });
  assert.equal(patch.status, 200);
  assert.equal(patch.corpo.regras, texto);

  const pub = await cliente()('GET', `/api/publico/${criado.corpo.slug}`);
  assert.equal(pub.corpo.campeonato.regras, texto);

  // limpar (null) e limite de tamanho
  const limpo = await c('PATCH', `/api/campeonatos/${criado.corpo.id}`, { regras: null });
  assert.equal(limpo.corpo.regras, null);
  const grande = await c('PATCH', `/api/campeonatos/${criado.corpo.id}`, { regras: 'x'.repeat(10001) });
  assert.equal(grande.status, 400);
});

test('isolamento multi-tenant: conta B nao ve nem altera dados da conta A', async () => {
  const contaA = cliente();
  const contaB = cliente();
  await registrarEntrar(contaA, { nome: 'Ana', email: 'ana@teste.com', senha: 'segredo1' });
  await registrarEntrar(contaB, { nome: 'Beto', email: 'beto@teste.com', senha: 'segredo1' });

  const deA = await contaA('POST', '/api/campeonatos', {
    nome: 'Camp da Ana', formato: 'pontos', times: ['T1', 'T2'],
  });
  const campA = deA.corpo.id;

  // B nao lista o campeonato de A
  const listaB = await contaB('GET', '/api/campeonatos');
  assert.equal(listaB.corpo.length, 0);

  // B nao acessa o detalhe nem altera (404, sem revelar existencia)
  assert.equal((await contaB('GET', `/api/campeonatos/${campA}`)).status, 404);
  assert.equal((await contaB('PATCH', `/api/campeonatos/${campA}`, { nome: 'Hackeado' })).status, 404);
  assert.equal((await contaB('DELETE', `/api/campeonatos/${campA}`)).status, 404);

  // B nao lanca resultado em jogo de A
  const detA = await contaA('GET', `/api/campeonatos/${campA}`);
  const jogoA = detA.corpo.jogos[0];
  assert.equal(
    (await contaB('POST', `/api/jogos/${jogoA.id}/resultado`, { gols_casa: 1, gols_fora: 0 })).status,
    404,
  );

  // sem login: 401
  const anonimo = cliente();
  assert.equal((await anonimo('GET', '/api/campeonatos')).status, 401);
});

test('banners: limite de 5 por campeonato', async () => {
  const c = cliente();
  await registrarEntrar(c, { nome: 'Ban', email: 'ban@teste.com', senha: 'segredo1' });
  const criado = await c('POST', '/api/campeonatos', {
    nome: 'Banners FC', formato: 'pontos', times: ['A', 'B'],
  });
  // PNG valido de 1x1 pixel
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  for (let i = 0; i < 5; i++) {
    const r = await c('POST', `/api/campeonatos/${criado.corpo.id}/banners`, { imagem: png, link: 'https://x.com' });
    assert.equal(r.status, 201, `banner ${i + 1}`);
  }
  const sexto = await c('POST', `/api/campeonatos/${criado.corpo.id}/banners`, { imagem: png });
  assert.equal(sexto.status, 409);
});

test('mata-mata: progressao automatica do vencedor ate o campeao', async () => {
  const c = cliente();
  await registrarEntrar(c, { nome: 'Mata', email: 'mata@teste.com', senha: 'segredo1' });
  const criado = await c('POST', '/api/campeonatos', {
    nome: 'Mata Cup', formato: 'mata', sortear: false, times: ['S1', 'S2', 'S3', 'S4'],
  });
  const det = await c('GET', `/api/campeonatos/${criado.corpo.id}`);
  assert.equal(det.corpo.jogos.length, 3); // 2 semis + final

  const semis = det.corpo.jogos.filter((j) => j.rodada === 1);
  const final = det.corpo.jogos.find((j) => j.rodada === 2);
  assert.equal(final.time_casa_id, null);

  // semi 1: casa vence
  await c('POST', `/api/jogos/${semis[0].id}/resultado`, { gols_casa: 2, gols_fora: 1 });
  // semi 2: empate decidido nos penaltis
  const semEmpate = await c('POST', `/api/jogos/${semis[1].id}/resultado`, { gols_casa: 1, gols_fora: 1 });
  assert.equal(semEmpate.status, 400); // exige penaltis
  await c('POST', `/api/jogos/${semis[1].id}/resultado`, {
    gols_casa: 1, gols_fora: 1, penaltis_casa: 3, penaltis_fora: 4,
  });

  // final preenchida com os vencedores
  const det2 = await c('GET', `/api/campeonatos/${criado.corpo.id}`);
  const final2 = det2.corpo.jogos.find((j) => j.rodada === 2);
  assert.equal(final2.time_casa_id, semis[0].time_casa_id); // vencedor da semi 1
  assert.equal(final2.time_fora_id, semis[1].time_fora_id); // vencedor nos penaltis

  // nao da para apagar a semi depois que a final tem resultado
  await c('POST', `/api/jogos/${final2.id}/resultado`, { gols_casa: 1, gols_fora: 0 });
  const bloqueado = await c('DELETE', `/api/jogos/${semis[0].id}/resultado`);
  assert.equal(bloqueado.status, 409);

  // apagando a final, a semi libera
  await c('DELETE', `/api/jogos/${final2.id}/resultado`);
  assert.equal((await c('DELETE', `/api/jogos/${semis[0].id}/resultado`)).status, 200);
  // e a vaga na final e limpa
  const det3 = await c('GET', `/api/campeonatos/${criado.corpo.id}`);
  assert.equal(det3.corpo.jogos.find((j) => j.rodada === 2).time_casa_id, null);
});

test('grupos + mata: so gera o mata quando os grupos terminam', async () => {
  const c = cliente();
  await registrarEntrar(c, { nome: 'Gru', email: 'gru@teste.com', senha: 'segredo1' });
  const criado = await c('POST', '/api/campeonatos', {
    nome: 'Grupos Cup', formato: 'grupos_mata', num_grupos: 2, classificados_por_grupo: 2,
    sortear: false, times: ['G1', 'G2', 'G3', 'G4', 'G5', 'G6'],
  });
  assert.equal(criado.status, 201);
  const campId = criado.corpo.id;

  // antes de terminar os grupos: erro
  const cedo = await c('POST', `/api/campeonatos/${campId}/gerar-mata`);
  assert.equal(cedo.status, 400);

  // encerra todos os jogos dos grupos (casa sempre vence por 1x0)
  const det = await c('GET', `/api/campeonatos/${campId}`);
  for (const j of det.corpo.jogos) {
    const r = await c('POST', `/api/jogos/${j.id}/resultado`, { gols_casa: 1, gols_fora: 0 });
    assert.equal(r.status, 200);
  }

  const gerado = await c('POST', `/api/campeonatos/${campId}/gerar-mata`);
  assert.equal(gerado.status, 201);
  assert.equal(gerado.corpo.jogos_criados, 3); // 4 classificados: 2 semis + final

  // gerar de novo: conflito
  assert.equal((await c('POST', `/api/campeonatos/${campId}/gerar-mata`)).status, 409);

  // as semis cruzam grupos (1oA x 2oB, 1oB x 2oA)
  const det2 = await c('GET', `/api/campeonatos/${campId}`);
  const semis = det2.corpo.jogos.filter((j) => j.fase === 'mata' && j.rodada === 1);
  const grupoDe = (timeId) => det2.corpo.times.find((t) => t.id === timeId).grupo_id;
  for (const s of semis) {
    assert.notEqual(grupoDe(s.time_casa_id), grupoDe(s.time_fora_id), 'semi cruza grupos');
  }
});

test('jogadores em lote: cadastra varios de uma vez e respeita a posse', async () => {
  const c = cliente();
  await registrarEntrar(c, { nome: 'Lote', email: 'lote@teste.com', senha: 'segredo1' });
  const criado = await c('POST', '/api/campeonatos', {
    nome: 'Lote FC', formato: 'pontos', sortear: false, times: ['A', 'B'],
  });
  const det = await c('GET', `/api/campeonatos/${criado.corpo.id}`);
  const timeA = det.corpo.times.find((t) => t.nome === 'A');

  const r = await c('POST', `/api/times/${timeA.id}/jogadores/lote`, {
    texto: 'Theo,10\nLeandro Domingues,7\nJunior\nBernardo\nMiguel,11',
  });
  assert.equal(r.status, 201);
  assert.equal(r.corpo.length, 5);
  assert.deepEqual(
    r.corpo.map((j) => [j.nome, j.numero]),
    [['Theo', 10], ['Leandro Domingues', 7], ['Junior', null], ['Bernardo', null], ['Miguel', 11]],
  );

  // linha invalida: nada e criado (400)
  const invalido = await c('POST', `/api/times/${timeA.id}/jogadores/lote`, { texto: 'Ok,9\n,7' });
  assert.equal(invalido.status, 400);

  // outra conta nao cadastra no time alheio
  const intruso = cliente();
  await registrarEntrar(intruso, { nome: 'X', email: 'x-lote@teste.com', senha: 'segredo1' });
  assert.equal(
    (await intruso('POST', `/api/times/${timeA.id}/jogadores/lote`, { texto: 'Invasor,1' })).status,
    404,
  );
});

test('resultado por texto: placar automatico, gol contra e validacao de elenco', async () => {
  const c = cliente();
  await registrarEntrar(c, { nome: 'Txt', email: 'txt@teste.com', senha: 'segredo1' });
  const criado = await c('POST', '/api/campeonatos', {
    nome: 'Texto FC', formato: 'pontos', sortear: false, times: ['Mandante', 'Visitante'],
  });
  const det = await c('GET', `/api/campeonatos/${criado.corpo.id}`);
  const jogo = det.corpo.jogos[0];
  const casaId = jogo.time_casa_id;
  const foraId = jogo.time_fora_id;
  await c('POST', `/api/times/${casaId}/jogadores/lote`, { texto: 'Theo,10\nLeo\nPedro' });
  await c('POST', `/api/times/${foraId}/jogadores/lote`, { texto: 'Fred,9\nThiago' });

  const r = await c('POST', `/api/jogos/${jogo.id}/resultado-texto`, {
    texto: `GOLS TIME CASA
Theo,2
GC,Fred
GOLS TIME VISITANTE
Fred
SR,1
CARTÕES TIME CASA
A,Leo
V,Pedro
CARTÕES TIME VISITANTE
A,Thiago`,
  });
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.equal(r.corpo.gols_casa, 3); // 2 do Theo + gol contra do Fred
  assert.equal(r.corpo.gols_fora, 2); // Fred + sem registro
  assert.equal(r.corpo.status, 'encerrado');

  // artilharia: Theo 2, Fred 1 (gol contra NAO conta para o autor)
  const pub = await cliente()('GET', `/api/publico/${criado.corpo.slug}`);
  const art = Object.fromEntries(pub.corpo.artilharia.map((a) => [a.nome, a.gols]));
  assert.equal(art.Theo, 2);
  assert.equal(art.Fred, 1);

  // nome fora do elenco: 400 apontando a linha, e o resultado anterior fica intacto
  const invalido = await c('POST', `/api/jogos/${jogo.id}/resultado-texto`, {
    texto: 'GOLS TIME CASA\nMaradona',
  });
  assert.equal(invalido.status, 400);
  assert.match(invalido.corpo.mensagem, /Linha 2.*Maradona/);
  const det2 = await c('GET', `/api/campeonatos/${criado.corpo.id}`);
  assert.equal(det2.corpo.jogos[0].gols_casa, 3);
});

test('sem sorteio: grupos seguem a ordem digitada e o mata pareia 1x2, 3x4', async () => {
  const c = cliente();
  await registrarEntrar(c, { nome: 'Ord', email: 'ord@teste.com', senha: 'segredo1' });

  // grupos: primeiros times digitados formam o Grupo A
  const cg = await c('POST', '/api/campeonatos', {
    nome: 'Ordem Grupos', formato: 'grupos_mata', num_grupos: 2, classificados_por_grupo: 2,
    sortear: false, times: ['A1', 'A2', 'A3', 'B1', 'B2', 'B3'],
  });
  const detG = await c('GET', `/api/campeonatos/${cg.corpo.id}`);
  const grupoA = detG.corpo.grupos.find((g) => g.nome === 'Grupo A');
  const nomesA = detG.corpo.times.filter((t) => t.grupo_id === grupoA.id).map((t) => t.nome).sort();
  assert.deepEqual(nomesA, ['A1', 'A2', 'A3']);

  // mata puro: ordem digitada monta o chaveamento
  const cm = await c('POST', '/api/campeonatos', {
    nome: 'Ordem Mata', formato: 'mata', sortear: false, times: ['P1', 'P2', 'P3', 'P4'],
  });
  const detM = await c('GET', `/api/campeonatos/${cm.corpo.id}`);
  const nome = (id) => detM.corpo.times.find((t) => t.id === id).nome;
  const semis = detM.corpo.jogos.filter((j) => j.rodada === 1);
  assert.deepEqual([nome(semis[0].time_casa_id), nome(semis[0].time_fora_id)], ['P1', 'P2']);
  assert.deepEqual([nome(semis[1].time_casa_id), nome(semis[1].time_fora_id)], ['P3', 'P4']);
});

test('master: escolhe um tenant e gerencia todo o conteudo dele', async () => {
  const master = cliente();
  const org = cliente();

  // organizador comum com um campeonato
  const contaOrg = await registrarEntrar(org, {
    nome: 'Organizador', email: 'org-master@teste.com', senha: 'segredo1',
  });
  const camp = await org('POST', '/api/campeonatos', {
    nome: 'Camp do Org', formato: 'pontos', times: ['T1', 'T2'],
  });

  // conta master (promovida como faz o script npm run master)
  await registrarEntrar(master, { nome: 'Master', email: 'master@teste.com', senha: 'segredo1' });
  bancoTeste.prepare("UPDATE contas SET papel = 'master' WHERE email = 'master@teste.com'").run();

  // /auth/eu reflete o papel
  const eu = await master('GET', '/api/auth/eu');
  assert.equal(eu.corpo.master, true);
  assert.equal(eu.corpo.tenant, null);

  // lista todas as contas com contagens
  const contas = await master('GET', '/api/master/contas');
  assert.equal(contas.status, 200);
  const doOrg = contas.corpo.find((c) => c.email === 'org-master@teste.com');
  assert.ok(doOrg);
  assert.equal(doOrg.n_campeonatos, 1);

  // antes de entrar no tenant: nao ve os campeonatos dele
  const antes = await master('GET', '/api/campeonatos');
  assert.equal(antes.corpo.length, 0);

  // entra como o organizador e passa a ver e ALTERAR o conteudo dele
  const entrou = await master('POST', '/api/master/entrar', { conta_id: contaOrg.id });
  assert.equal(entrou.status, 200);
  const eu2 = await master('GET', '/api/auth/eu');
  assert.equal(eu2.corpo.tenant.nome, 'Organizador');

  const lista = await master('GET', '/api/campeonatos');
  assert.equal(lista.corpo.length, 1);
  assert.equal(lista.corpo[0].nome, 'Camp do Org');

  const patch = await master('PATCH', `/api/campeonatos/${camp.corpo.id}`, { nome: 'Ajustado pelo Master' });
  assert.equal(patch.status, 200);

  // o organizador ve a alteracao (conteudo continua sendo dele)
  const visaoOrg = await org('GET', `/api/campeonatos/${camp.corpo.id}`);
  assert.equal(visaoOrg.corpo.campeonato.nome, 'Ajustado pelo Master');

  // volta a ser a propria conta
  await master('POST', '/api/master/voltar');
  const depois = await master('GET', '/api/campeonatos');
  assert.equal(depois.corpo.length, 0);
});

test('master: gerenciar a PROPRIA conta funciona (tenant proprio, sem loop)', async () => {
  const m = cliente();
  const reg = await registrarEntrar(m, { nome: 'Dono', email: 'dono@teste.com', senha: 'segredo1' });
  bancoTeste.prepare("UPDATE contas SET papel = 'master' WHERE email = 'dono@teste.com'").run();
  await m('POST', '/api/campeonatos', { nome: 'Camp do Dono', formato: 'pontos', times: ['D1', 'D2'] });

  await m('POST', '/api/master/entrar', { conta_id: reg.id });
  const eu = await m('GET', '/api/auth/eu');
  assert.ok(eu.corpo.tenant, 'tenant definido mesmo sendo a propria conta');
  assert.equal(eu.corpo.tenant.proprio, true);
  const lista = await m('GET', '/api/campeonatos');
  assert.equal(lista.corpo.length, 1);
  assert.equal(lista.corpo[0].nome, 'Camp do Dono');
});

test('master: manutencao de contas (editar, resetar senha, sessoes, excluir)', async () => {
  const m = cliente();
  await registrarEntrar(m, { nome: 'Root', email: 'root@teste.com', senha: 'segredo1' });
  bancoTeste.prepare("UPDATE contas SET papel = 'master' WHERE email = 'root@teste.com'").run();

  const alvoCli = cliente();
  const alvo = await registrarEntrar(alvoCli, { nome: 'Alvo', email: 'alvo@teste.com', senha: 'senhavelha' });
  await alvoCli('POST', '/api/campeonatos', { nome: 'Camp do Alvo', formato: 'pontos', times: ['X', 'Y'] });
  const alvoId = alvo.id;

  // editar nome e e-mail; conflito de e-mail e barrado
  const ed = await m('PATCH', `/api/master/contas/${alvoId}`, { nome: 'Alvo Editado', email: 'alvo2@teste.com' });
  assert.equal(ed.status, 200);
  assert.equal(ed.corpo.nome, 'Alvo Editado');
  assert.equal((await m('PATCH', `/api/master/contas/${alvoId}`, { email: 'root@teste.com' })).status, 409);

  // rebaixar a si mesmo e proibido
  const eu = await m('GET', '/api/auth/eu');
  assert.equal(
    (await m('PATCH', `/api/master/contas/${eu.corpo.id}`, { papel: 'organizador' })).status, 400,
  );

  // reset de senha: senha velha para de valer, temporaria funciona, sessoes caem
  const reset = await m('POST', `/api/master/contas/${alvoId}/resetar-senha`);
  assert.equal(reset.status, 200);
  assert.ok(reset.corpo.senha_temporaria.length >= 8);
  assert.equal((await alvoCli('GET', '/api/campeonatos')).status, 401); // sessao derrubada
  const novoCli = cliente();
  assert.equal(
    (await novoCli('POST', '/api/auth/login', { email: 'alvo2@teste.com', senha: 'senhavelha' })).status, 401,
  );
  assert.equal(
    (await novoCli('POST', '/api/auth/login', { email: 'alvo2@teste.com', senha: reset.corpo.senha_temporaria })).status, 200,
  );

  // encerrar sessoes forca novo login
  const enc = await m('POST', `/api/master/contas/${alvoId}/encerrar-sessoes`);
  assert.equal(enc.status, 200);
  assert.equal((await novoCli('GET', '/api/campeonatos')).status, 401);

  // excluir master e bloqueado; organizador e excluido com todo o conteudo
  assert.equal((await m('DELETE', `/api/master/contas/${eu.corpo.id}`)).status, 400);
  assert.equal((await m('DELETE', `/api/master/contas/${alvoId}`)).status, 200);
  const contas = await m('GET', '/api/master/contas');
  assert.ok(!contas.corpo.some((c) => c.id === alvoId));
  const orfaos = bancoTeste
    .prepare('SELECT COUNT(*) AS n FROM campeonatos WHERE conta_id = ?')
    .get(alvoId).n;
  assert.equal(orfaos, 0, 'campeonatos da conta excluida sumiram (cascade)');
});

test('seguranca: organizador comum nao acessa rotas master nem forja tenant', async () => {
  const c = cliente();
  const eu = await registrarEntrar(c, { nome: 'Comum', email: 'comum@teste.com', senha: 'segredo1' });
  assert.equal((await c('GET', '/api/master/contas')).status, 403);
  assert.equal((await c('POST', '/api/master/entrar', { conta_id: 1 })).status, 403);

  // mesmo com conta_efetiva_id forjado na sessao, quem nao e master e ignorado
  bancoTeste.prepare('UPDATE sessoes SET conta_efetiva_id = 1 WHERE conta_id = ?').run(eu.id);
  const eu2 = await c('GET', '/api/auth/eu');
  assert.equal(eu2.corpo.id, eu.id); // continua sendo ele mesmo
  assert.equal(eu2.corpo.tenant, null);
});

test('validacao do wizard: mata-mata exige potencia de 2', async () => {
  const c = cliente();
  await registrarEntrar(c, { nome: 'W', email: 'w@teste.com', senha: 'segredo1' });
  const r = await c('POST', '/api/campeonatos', { nome: 'Errado', formato: 'mata', times: ['A', 'B', 'C'] });
  assert.equal(r.status, 400);
});

// ================= VERIFICACAO DE E-MAIL, GOOGLE E LGPD =================

test('verificacao de e-mail: exige consentimento, bloqueia login e token e de uso unico', async () => {
  const c = cliente();

  // sem aceitar a politica de privacidade nao cria conta (LGPD)
  const semConsent = await c('POST', '/api/auth/registrar', {
    nome: 'V', email: 'verif@teste.com', senha: 'segredo1',
  });
  assert.equal(semConsent.status, 400);
  assert.match(semConsent.corpo.mensagem, /Politica de Privacidade/);

  // registro ok: nao abre sessao e avisa que precisa verificar
  const reg = await c('POST', '/api/auth/registrar', {
    nome: 'V', email: 'verif@teste.com', senha: 'segredo1', consentimento: true,
  });
  assert.equal(reg.status, 201);
  assert.equal(reg.corpo.precisaVerificar, true);
  assert.equal((await c('GET', '/api/campeonatos')).status, 401);

  // login bloqueado com erro especifico
  const bloqueado = await c('POST', '/api/auth/login', { email: 'verif@teste.com', senha: 'segredo1' });
  assert.equal(bloqueado.status, 403);
  assert.equal(bloqueado.corpo.erro, 'EmailNaoVerificado');

  // o e-mail enviado carrega o link; confirmar abre a sessao
  const token = tokenDoUltimoEmail('verif@teste.com');
  assert.ok(token, 'token presente no e-mail');
  assert.equal((await c('POST', '/api/auth/confirmar-email', { token })).status, 200);
  assert.equal((await c('GET', '/api/campeonatos')).status, 200);

  // token e de uso unico; token inventado tambem falha
  assert.equal((await c('POST', '/api/auth/confirmar-email', { token })).status, 400);
  assert.equal((await c('POST', '/api/auth/confirmar-email', { token: 'a'.repeat(64) })).status, 400);

  // login por senha passa a funcionar
  assert.equal(
    (await cliente()('POST', '/api/auth/login', { email: 'verif@teste.com', senha: 'segredo1' })).status,
    200,
  );
});

test('reenvio de verificacao: invalida o token anterior e nao revela contas', async () => {
  const c = cliente();
  await c('POST', '/api/auth/registrar', {
    nome: 'R', email: 'reenvio@teste.com', senha: 'segredo1', consentimento: true,
  });
  const token1 = tokenDoUltimoEmail('reenvio@teste.com');

  assert.equal((await c('POST', '/api/auth/reenviar-verificacao', { email: 'reenvio@teste.com' })).status, 200);
  const token2 = tokenDoUltimoEmail('reenvio@teste.com');
  assert.ok(token2 && token2 !== token1, 'novo token gerado');

  assert.equal((await c('POST', '/api/auth/confirmar-email', { token: token1 })).status, 400); // antigo caiu
  assert.equal((await c('POST', '/api/auth/confirmar-email', { token: token2 })).status, 200);

  // e-mail sem cadastro pendente: mesma resposta e nenhum envio (anti-enumeracao)
  const antes = emails.length;
  assert.equal((await c('POST', '/api/auth/reenviar-verificacao', { email: 'fantasma@teste.com' })).status, 200);
  assert.equal(emails.length, antes);
});

test('token de verificacao expirado e recusado', async () => {
  const c = cliente();
  await c('POST', '/api/auth/registrar', {
    nome: 'E', email: 'expira@teste.com', senha: 'segredo1', consentimento: true,
  });
  const token = tokenDoUltimoEmail('expira@teste.com');
  bancoTeste
    .prepare(
      `UPDATE verificacoes_email SET expira_em = '2000-01-01T00:00:00.000Z'
       WHERE conta_id = (SELECT id FROM contas WHERE email = 'expira@teste.com')`,
    )
    .run();
  const r = await c('POST', '/api/auth/confirmar-email', { token });
  assert.equal(r.status, 400);
  assert.match(r.corpo.mensagem, /expirou/);
});

test('login com Google: cria conta, vincula por e-mail e exige e-mail verificado no Google', async () => {
  // dominio direto (o transporte HTTP com o Google e exercitado manualmente)
  const nova = contaViaGoogle(bancoTeste, {
    sub: 'g-123', email: 'gnovo@teste.com', nome: 'G Novo', emailVerificado: true,
  });
  const linha = bancoTeste.prepare('SELECT * FROM contas WHERE id = ?').get(nova.id);
  assert.equal(linha.email_verificado, 1);
  assert.equal(linha.google_id, 'g-123');
  assert.equal(linha.senha_hash, 'google'); // sem senha local
  assert.ok(linha.consentimento_em, 'consentimento registrado no primeiro acesso');

  // mesmo sub retorna a mesma conta
  assert.equal(
    contaViaGoogle(bancoTeste, { sub: 'g-123', email: 'gnovo@teste.com', emailVerificado: true }).id,
    nova.id,
  );

  // conta local existente com o mesmo e-mail e vinculada (e fica verificada)
  const local = registrarConta(bancoTeste, {
    nome: 'Local', email: 'glocal@teste.com', senha: 'segredo1', consentimento: true,
  });
  const vinculada = contaViaGoogle(bancoTeste, { sub: 'g-456', email: 'glocal@teste.com', emailVerificado: true });
  assert.equal(vinculada.id, local.id);
  const depois = bancoTeste.prepare('SELECT * FROM contas WHERE id = ?').get(local.id);
  assert.equal(depois.google_id, 'g-456');
  assert.equal(depois.email_verificado, 1);

  // e-mail nao verificado no Google e recusado (protege contra vinculo indevido)
  assert.throws(
    () => contaViaGoogle(bancoTeste, { sub: 'g-789', email: 'gx@teste.com', emailVerificado: false }),
    /verificado/,
  );

  // conta criada pelo Google nao entra com senha (erro generico, sem vazamento)
  const login = await cliente()('POST', '/api/auth/login', { email: 'gnovo@teste.com', senha: 'google' });
  assert.equal(login.status, 401);
});

test('LGPD: excluir minha conta exige confirmacao e apaga tudo em cascata', async () => {
  const c = cliente();
  await registrarEntrar(c, { nome: 'Sair', email: 'sair@teste.com', senha: 'segredo1' });
  await c('POST', '/api/campeonatos', { nome: 'Camp do Sair', formato: 'pontos', times: ['S1', 'S2'] });

  // confirmacao errada nao apaga
  assert.equal((await c('DELETE', '/api/auth/minha-conta', { confirmacao: 'senhaerrada' })).status, 400);

  const del = await c('DELETE', '/api/auth/minha-conta', { confirmacao: 'segredo1' });
  assert.equal(del.status, 200);
  assert.equal((await c('GET', '/api/campeonatos')).status, 401); // sessao encerrada
  assert.equal(
    bancoTeste.prepare("SELECT COUNT(*) AS n FROM contas WHERE email = 'sair@teste.com'").get().n, 0,
  );
  assert.equal(
    bancoTeste.prepare("SELECT COUNT(*) AS n FROM campeonatos WHERE nome = 'Camp do Sair'").get().n, 0,
    'campeonatos caem em cascata',
  );
  assert.equal(
    (await cliente()('POST', '/api/auth/login', { email: 'sair@teste.com', senha: 'segredo1' })).status, 401,
  );
});

test('multiesporte (fase 1): catalogo, preset e validacao do esporte', async () => {
  const rita = cliente();
  await registrarEntrar(rita, { nome: 'Rita', email: 'rita@teste.com', senha: 'segredo1' });

  // catalogo: 7 esportes na ordem fixa de produto; so o futebol disponivel
  const cat = await rita('GET', '/api/esportes');
  assert.equal(cat.status, 200);
  assert.deepEqual(
    cat.corpo.map((e) => e.chave),
    ['futebol', 'pelada_epica', 'futvolei', 'beach_tennis', 'volei', 'basquete', 'peteca'],
  );
  assert.deepEqual(cat.corpo.filter((e) => e.disponivel).map((e) => e.chave), ['futebol']);

  // esporte ausente = futebol (API pre-multiesporte continua valida)
  const compat = await rita('POST', '/api/campeonatos', {
    nome: 'Copa Compat', formato: 'pontos', times: ['A', 'B'],
  });
  assert.equal(compat.status, 201, JSON.stringify(compat.corpo));
  assert.equal(compat.corpo.esporte, 'futebol');
  assert.equal(compat.corpo.modalidade, 'Campo'); // variante padrao do preset
  assert.equal(compat.corpo.pontos_vitoria, 3);

  // esporte explicito com variante
  const society = await rita('POST', '/api/campeonatos', {
    nome: 'Copa Society', esporte: 'futebol', modalidade: 'Society',
    formato: 'pontos', times: ['A', 'B'],
  });
  assert.equal(society.corpo.esporte, 'futebol');
  assert.equal(society.corpo.modalidade, 'Society');

  // esporte inexistente e esporte "em breve" sao rejeitados
  const invalido = await rita('POST', '/api/campeonatos', {
    nome: 'X', esporte: 'xadrez', formato: 'pontos', times: ['A', 'B'],
  });
  assert.equal(invalido.status, 400);
  const emBreve = await rita('POST', '/api/campeonatos', {
    nome: 'V', esporte: 'volei', formato: 'pontos', times: ['A', 'B'],
  });
  assert.equal(emBreve.status, 400);
  assert.match(emBreve.corpo.mensagem, /disponivel/i);

  // RN-TC-01: o esporte e imutavel — o PATCH ignora tentativas de troca
  const patch = await rita('PATCH', `/api/campeonatos/${compat.corpo.id}`, {
    esporte: 'basquete', nome: 'Copa Compat 2',
  });
  assert.equal(patch.status, 200);
  assert.equal(patch.corpo.esporte, 'futebol');
  assert.equal(patch.corpo.nome, 'Copa Compat 2');

  // pagina publica devolve o esporte e os rotulos do catalogo (RN-TC-10)
  const pub = await rita('GET', `/api/publico/${compat.corpo.slug}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.corpo.esporte.chave, 'futebol');
  assert.equal(pub.corpo.esporte.nome, 'Futebol');
  assert.equal(pub.corpo.esporte.rotulos.participantes, 'Times');
  assert.equal(pub.corpo.campeonato.esporte, 'futebol');
});
