// Teste de integracao da API: fluxo completo do organizador + isolamento multi-tenant.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { prepararBanco } from '../db/db.js';
import { montarRotas } from '../routes/api.js';

let servidor;
let base;
let bancoTeste;

function montarApp() {
  const db = prepararBanco(':memory:');
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', montarRotas(db));
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

  // registro cria sessao
  const reg = await alice('POST', '/api/auth/registrar', {
    nome: 'Alice', email: 'alice@teste.com', senha: 'segredo1',
  });
  assert.equal(reg.status, 201);

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
  await c('POST', '/api/auth/registrar', { nome: 'Val', email: 'val@teste.com', senha: 'segredo1' });
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

test('isolamento multi-tenant: conta B nao ve nem altera dados da conta A', async () => {
  const contaA = cliente();
  const contaB = cliente();
  await contaA('POST', '/api/auth/registrar', { nome: 'Ana', email: 'ana@teste.com', senha: 'segredo1' });
  await contaB('POST', '/api/auth/registrar', { nome: 'Beto', email: 'beto@teste.com', senha: 'segredo1' });

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
  await c('POST', '/api/auth/registrar', { nome: 'Ban', email: 'ban@teste.com', senha: 'segredo1' });
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
  await c('POST', '/api/auth/registrar', { nome: 'Mata', email: 'mata@teste.com', senha: 'segredo1' });
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
  await c('POST', '/api/auth/registrar', { nome: 'Gru', email: 'gru@teste.com', senha: 'segredo1' });
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
  await c('POST', '/api/auth/registrar', { nome: 'Lote', email: 'lote@teste.com', senha: 'segredo1' });
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
  await intruso('POST', '/api/auth/registrar', { nome: 'X', email: 'x-lote@teste.com', senha: 'segredo1' });
  assert.equal(
    (await intruso('POST', `/api/times/${timeA.id}/jogadores/lote`, { texto: 'Invasor,1' })).status,
    404,
  );
});

test('resultado por texto: placar automatico, gol contra e validacao de elenco', async () => {
  const c = cliente();
  await c('POST', '/api/auth/registrar', { nome: 'Txt', email: 'txt@teste.com', senha: 'segredo1' });
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
  await c('POST', '/api/auth/registrar', { nome: 'Ord', email: 'ord@teste.com', senha: 'segredo1' });

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
  const contaOrg = await org('POST', '/api/auth/registrar', {
    nome: 'Organizador', email: 'org-master@teste.com', senha: 'segredo1',
  });
  const camp = await org('POST', '/api/campeonatos', {
    nome: 'Camp do Org', formato: 'pontos', times: ['T1', 'T2'],
  });

  // conta master (promovida como faz o script npm run master)
  await master('POST', '/api/auth/registrar', { nome: 'Master', email: 'master@teste.com', senha: 'segredo1' });
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
  const entrou = await master('POST', '/api/master/entrar', { conta_id: contaOrg.corpo.id });
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
  const reg = await m('POST', '/api/auth/registrar', { nome: 'Dono', email: 'dono@teste.com', senha: 'segredo1' });
  bancoTeste.prepare("UPDATE contas SET papel = 'master' WHERE email = 'dono@teste.com'").run();
  await m('POST', '/api/campeonatos', { nome: 'Camp do Dono', formato: 'pontos', times: ['D1', 'D2'] });

  await m('POST', '/api/master/entrar', { conta_id: reg.corpo.id });
  const eu = await m('GET', '/api/auth/eu');
  assert.ok(eu.corpo.tenant, 'tenant definido mesmo sendo a propria conta');
  assert.equal(eu.corpo.tenant.proprio, true);
  const lista = await m('GET', '/api/campeonatos');
  assert.equal(lista.corpo.length, 1);
  assert.equal(lista.corpo[0].nome, 'Camp do Dono');
});

test('master: manutencao de contas (editar, resetar senha, sessoes, excluir)', async () => {
  const m = cliente();
  await m('POST', '/api/auth/registrar', { nome: 'Root', email: 'root@teste.com', senha: 'segredo1' });
  bancoTeste.prepare("UPDATE contas SET papel = 'master' WHERE email = 'root@teste.com'").run();

  const alvoCli = cliente();
  const alvo = await alvoCli('POST', '/api/auth/registrar', { nome: 'Alvo', email: 'alvo@teste.com', senha: 'senhavelha' });
  await alvoCli('POST', '/api/campeonatos', { nome: 'Camp do Alvo', formato: 'pontos', times: ['X', 'Y'] });
  const alvoId = alvo.corpo.id;

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
  const eu = await c('POST', '/api/auth/registrar', { nome: 'Comum', email: 'comum@teste.com', senha: 'segredo1' });
  assert.equal((await c('GET', '/api/master/contas')).status, 403);
  assert.equal((await c('POST', '/api/master/entrar', { conta_id: 1 })).status, 403);

  // mesmo com conta_efetiva_id forjado na sessao, quem nao e master e ignorado
  bancoTeste.prepare('UPDATE sessoes SET conta_efetiva_id = 1 WHERE conta_id = ?').run(eu.corpo.id);
  const eu2 = await c('GET', '/api/auth/eu');
  assert.equal(eu2.corpo.id, eu.corpo.id); // continua sendo ele mesmo
  assert.equal(eu2.corpo.tenant, null);
});

test('validacao do wizard: mata-mata exige potencia de 2', async () => {
  const c = cliente();
  await c('POST', '/api/auth/registrar', { nome: 'W', email: 'w@teste.com', senha: 'segredo1' });
  const r = await c('POST', '/api/campeonatos', { nome: 'Errado', formato: 'mata', times: ['A', 'B', 'C'] });
  assert.equal(r.status, 400);
});
