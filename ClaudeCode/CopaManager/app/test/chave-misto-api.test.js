// Fase C: Fase de grupos + Mata-mata no modelo Manual Personalizado.
// Rotulos de vaga, previa ao vivo, zonas da classificacao e resolucao ao gerar.
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

before(async () => {
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

async function registrarEntrar(c, email) {
  assert.equal((await c('POST', '/api/auth/registrar', { nome: 'G', email, senha: 'segredo1', consentimento: true })).status, 201);
  assert.equal((await c('POST', '/api/auth/confirmar-email', { token: tokenDoUltimoEmail(email) })).status, 200);
}

// 3 grupos de 3 (9 times), chave manual de 7 vagas.
async function copaMista(c, nome, extras = {}) {
  const r = await c('POST', '/api/campeonatos', {
    nome, formato: 'grupos_mata', num_grupos: 3, sortear: false,
    mata_modelo: 'manual', mata_vagas: 7,
    times: ['A1', 'A2', 'A3', 'B1', 'B2', 'B3', 'C1', 'C2', 'C3'],
    ...extras,
  });
  assert.equal(r.status, 201, JSON.stringify(r.corpo));
  return r.corpo;
}

// Encerra a fase de grupos com o mandante sempre vencendo: como os times foram
// cadastrados em ordem, a classificacao fica previsivel (A1 > A2 > A3 etc.).
async function jogarGrupos(c, campId) {
  const det = (await c('GET', `/api/campeonatos/${campId}`)).corpo;
  for (const j of det.jogos.filter((x) => x.fase === 'grupos')) {
    const casa = det.times.find((t) => t.id === j.time_casa_id).nome;
    const fora = det.times.find((t) => t.id === j.time_fora_id).nome;
    // O de nome "menor" (A1 < A2) vence, jogue em casa ou fora.
    const casaVence = casa < fora;
    const r = await c('POST', `/api/jogos/${j.id}/resultado`, {
      gols_casa: casaVence ? 2 : 0, gols_fora: casaVence ? 0 : 2,
    });
    assert.equal(r.status, 200, JSON.stringify(r.corpo));
  }
}

test('misto manual: nasce com rotulos do cruzamento classico e chave de 7', async () => {
  const c = cliente();
  await registrarEntrar(c, 'misto1@teste.com');
  const camp = await copaMista(c, 'Mista 7');
  assert.equal(camp.mata_modelo, 'manual');
  const meta = JSON.parse(camp.mata_chave);
  assert.equal(meta.vagas, 7);
  assert.equal(meta.desenho, '7A');
  assert.equal(camp.classificados_por_grupo, 2, 'derivado dos rotulos: 2 entram direto');

  const chav = (await c('GET', `/api/campeonatos/${camp.id}/chaveamento`)).corpo;
  assert.equal(chav.gerado, false);
  assert.equal(chav.editavel, true);
  assert.equal(chav.slots.length, 7);
  // Potes por posicao, com a troca do anti-reencontro: 1ºC e 2ºC cairiam no
  // mesmo confronto, entao os 2os trocam de lugar entre si.
  assert.deepEqual(chav.slots.map((s) => s.rotulo_texto), [
    '1º do Grupo A', '1º do Grupo B', '1º do Grupo C',
    '2º do Grupo C', '2º do Grupo B', '2º do Grupo A', 'Melhor 3º',
  ]);
  assert.deepEqual(chav.reencontros, [], 'nenhum grupo se reencontra na 1a fase');
  assert.ok(chav.rotulos_disponiveis.some((r) => r.texto === 'Melhor 3º'));
  assert.equal(chav.grupos_pendentes > 0, true);
});

test('misto manual: previa ao vivo e zonas da classificacao pelos rotulos', async () => {
  const c = cliente();
  await registrarEntrar(c, 'misto2@teste.com');
  const camp = await copaMista(c, 'Mista previa');
  await jogarGrupos(c, camp.id);

  const chav = (await c('GET', `/api/campeonatos/${camp.id}/chaveamento`)).corpo;
  assert.equal(chav.grupos_pendentes, 0);
  const previa = Object.fromEntries(chav.slots.map((s) => [s.rotulo_texto, s.previa_nome]));
  assert.equal(previa['1º do Grupo A'], 'A1');
  assert.equal(previa['2º do Grupo C'], 'C2');
  assert.ok(['A3', 'B3', 'C3'].includes(previa['Melhor 3º']), 'o melhor 3o sai do ranking entre grupos');

  // Zonas (RN-MM-12): verde nos 2 diretos, ambar no 3o (posicao em disputa).
  const det = (await c('GET', `/api/campeonatos/${camp.id}`)).corpo;
  const grupoA = det.classificacao.find((g) => g.grupo.nome === 'Grupo A');
  assert.deepEqual(grupoA.linhas.map((l) => l.zona ?? null), ['classifica', 'classifica', 'disputa']);
});

test('misto manual: trocar rotulos pela aba e gerar o mata com eles', async () => {
  const c = cliente();
  await registrarEntrar(c, 'misto3@teste.com');
  const camp = await copaMista(c, 'Mista rotulos');
  const original = (await c('GET', `/api/campeonatos/${camp.id}/chaveamento`)).corpo;

  // Troca a vaga do "Melhor 3º" por "3º do Grupo A" (posicao 7 do desenho).
  const slots = original.slots.map((s) => (s.rotulo.tipo === 'melhor_posicao'
    ? { posicao: s.posicao, rotulo: { tipo: 'grupo_posicao', grupo: 'A', posicao: 3 } }
    : { posicao: s.posicao, rotulo: s.rotulo }));
  const put = await c('PUT', `/api/campeonatos/${camp.id}/chaveamento`, { slots });
  assert.equal(put.status, 200, JSON.stringify(put.corpo));
  assert.ok(put.corpo.slots.some((s) => s.rotulo_texto === '3º do Grupo A'));

  await jogarGrupos(c, camp.id);
  const gerou = await c('POST', `/api/campeonatos/${camp.id}/gerar-mata`);
  assert.equal(gerou.status, 201, JSON.stringify(gerou.corpo));
  assert.equal(gerou.corpo.jogos_criados, 6, 'chave de 7 = 6 jogos');

  // A3 entrou pela vaga declarada, e nao pelo ranking dos melhores 3os.
  const det = (await c('GET', `/api/campeonatos/${camp.id}`)).corpo;
  const nome = (id) => det.times.find((t) => t.id === id)?.nome ?? null;
  const naChave = det.jogos.filter((j) => j.fase === 'mata')
    .flatMap((j) => [nome(j.time_casa_id), nome(j.time_fora_id)]).filter(Boolean);
  assert.ok(naChave.includes('A3'));
  assert.ok(!naChave.includes('B3') && !naChave.includes('C3'));
  assert.equal(new Set(naChave).size, 7, 'sete times distintos ocupam a chave');
});

test('misto manual: validacoes de rotulo', async () => {
  const c = cliente();
  await registrarEntrar(c, 'misto4@teste.com');

  // Vagas demais para o numero de times.
  const grande = await c('POST', '/api/campeonatos', {
    nome: 'Vagas demais', formato: 'grupos_mata', num_grupos: 2, mata_modelo: 'manual', mata_vagas: 11,
    times: ['A1', 'A2', 'A3', 'B1', 'B2', 'B3'],
  });
  assert.equal(grande.status, 400);
  assert.match(grande.corpo.mensagem, /11 vagas/);

  // Potencia de 2 nao entra no manual.
  const cheia = await c('POST', '/api/campeonatos', {
    nome: 'Cheia', formato: 'grupos_mata', num_grupos: 2, mata_modelo: 'manual', mata_vagas: 4,
    times: ['A1', 'A2', 'A3', 'B1', 'B2', 'B3'],
  });
  assert.equal(cheia.status, 400);
  assert.match(cheia.corpo.mensagem, /modelo Padrao/);

  // Rotulo repetido na gravacao.
  const camp = await copaMista(c, 'Mista invalida');
  const chav = (await c('GET', `/api/campeonatos/${camp.id}/chaveamento`)).corpo;
  const repetido = chav.slots.map((s, i) => ({
    posicao: s.posicao,
    rotulo: i === 0 ? { tipo: 'grupo_posicao', grupo: 'B', posicao: 1 } : s.rotulo,
  }));
  const ruim = await c('PUT', `/api/campeonatos/${camp.id}/chaveamento`, { slots: repetido });
  assert.equal(ruim.status, 400);
  assert.match(ruim.corpo.mensagem, /repetida/);

  // Posicao que o grupo nao tem (grupos de 3).
  const alta = chav.slots.map((s, i) => ({
    posicao: s.posicao,
    rotulo: i === 0 ? { tipo: 'grupo_posicao', grupo: 'A', posicao: 5 } : s.rotulo,
  }));
  const ruim2 = await c('PUT', `/api/campeonatos/${camp.id}/chaveamento`, { slots: alta });
  assert.equal(ruim2.status, 400);
  assert.match(ruim2.corpo.mensagem, /5º colocado/);
});

test('misto manual: gerado o mata, a aba passa a reposicionar times', async () => {
  const c = cliente();
  await registrarEntrar(c, 'misto5@teste.com');
  const camp = await copaMista(c, 'Mista gerada');
  await jogarGrupos(c, camp.id);
  assert.equal((await c('POST', `/api/campeonatos/${camp.id}/gerar-mata`)).status, 201);

  const chav = (await c('GET', `/api/campeonatos/${camp.id}/chaveamento`)).corpo;
  assert.equal(chav.gerado, true);
  assert.equal(chav.editavel, true, 'sem resultado no mata, ainda da para reposicionar');
  assert.equal(chav.slots.length, 7);
  assert.ok(chav.slots.every((s) => s.time_id), 'as vagas agora tem times de verdade');
  assert.deepEqual(chav.rodadas.map((r) => r.nome), ['Quartas de final', 'Semifinal', 'Final']);

  // Reposicionar continua valendo (mesma rota, agora com times).
  const [a, b] = chav.slots;
  const trocados = chav.slots.map((s) => {
    if (s === a) return { ...s, time_id: b.time_id };
    if (s === b) return { ...s, time_id: a.time_id };
    return s;
  });
  assert.equal((await c('PUT', `/api/campeonatos/${camp.id}/chaveamento`, { slots: trocados })).status, 200);
});

test('misto manual: o bloco `vagas` descreve os ROTULOS, nao o plano de vagas', async () => {
  const c = cliente();
  await registrarEntrar(c, 'misto-vagas@teste.com');
  // Caso real relatado: 3 grupos de 5, 10 vagas = os 3 primeiros de cada
  // grupo + o melhor 4o. Com o plano de vagas (3 grupos x 3 classificados)
  // o payload dizia "chave de 8, os 2 melhores 3os" — outra competicao.
  const camp = (await c('POST', '/api/campeonatos', {
    nome: 'Mata Mata 10', formato: 'grupos_mata', num_grupos: 3, sortear: false,
    mata_modelo: 'manual', mata_vagas: 10,
    times: Array.from({ length: 15 }, (_, i) => `T${String(i + 1).padStart(2, '0')}`),
  })).corpo;
  assert.equal(camp.classificados_por_grupo, 3, 'derivado: 3 entram direto');

  const det = (await c('GET', `/api/campeonatos/${camp.id}`)).corpo;
  const v = det.vagas;
  assert.equal(v.modo, 'manual');
  assert.equal(v.chave, 10, 'a chave tem 10 vagas, nao 8');
  assert.equal(v.posicao_disputa, 4, 'quem disputa e o 4o colocado, nao o 3o');
  assert.equal(v.em_disputa, 1, 'uma vaga: o melhor 4o');
  assert.equal(v.total_diretos, 9);
  assert.match(v.resumo, /Chave de 10/);
  assert.match(v.resumo, /melhor 4º/);
  assert.doesNotMatch(v.resumo, /3º/);

  // Com a fase de grupos rolando, o ranking compara os 4os — e so eles.
  await jogarGrupos(c, camp.id);
  const comJogos = (await c('GET', `/api/campeonatos/${camp.id}`)).corpo;
  const rank = comJogos.vagas.ranking;
  assert.equal(rank.length, 3, 'um 4o colocado por grupo');
  assert.equal(rank.filter((l) => l.classifica).length, 1);
  const quartos = comJogos.classificacao.map((g) => g.linhas[3].time_id);
  assert.deepEqual([...rank.map((l) => l.time_id)].sort(), [...quartos].sort(),
    'o ranking e dos 4os colocados de cada grupo');

  // A pagina publica ve o mesmo.
  const pub = (await c('GET', `/api/publico/${camp.slug}`)).corpo;
  assert.equal(pub.vagas.posicao_disputa, 4);
  assert.match(pub.vagas.resumo, /Chave de 10/);
});

test('pagina publica: a chave aparece antes de o mata existir, com as vagas', async () => {
  const c = cliente();
  await registrarEntrar(c, 'publico-chave@teste.com');
  const camp = await copaMista(c, 'Mista publica');

  // Antes da fase de grupos terminar: sem jogos de mata, mas com desenho.
  const antes = (await c('GET', `/api/publico/${camp.slug}`)).corpo;
  assert.equal(antes.chaveamento.length, 0);
  assert.equal(antes.chave.gerado, false);
  assert.equal(antes.chave.desenho, '7A');
  assert.equal(antes.chave.slots.length, 7);
  assert.ok(antes.chave.slots.every((s) => s.rotulo), 'toda vaga tem rotulo legivel');
  assert.ok(antes.chave.slots.some((s) => s.rotulo === 'Melhor 3º'));
  assert.ok(antes.chave.rodadas.length, 'estrutura para desenhar');

  // Depois de gerar: as vagas viram times e da para saber quem teve folga.
  await jogarGrupos(c, camp.id);
  assert.equal((await c('POST', `/api/campeonatos/${camp.id}/gerar-mata`)).status, 201);
  const depois = (await c('GET', `/api/publico/${camp.slug}`)).corpo;
  assert.equal(depois.chave.gerado, true);
  assert.ok(depois.chave.slots.every((s) => s.time_id), 'as vagas agora tem times');
  const folgas = depois.chave.slots.filter((s) => s.rodada > 1);
  assert.equal(folgas.length, 1, 'na chave de 7 exatamente um time entra na semifinal');
});

test('pagina publica: chave de mata puro tambem vem desenhada', async () => {
  const c = cliente();
  await registrarEntrar(c, 'publico-puro@teste.com');
  const camp = (await c('POST', '/api/campeonatos', {
    nome: 'Puro publico', formato: 'mata', sortear: false, mata_desenho: '6C',
    times: ['A', 'B', 'C', 'D', 'E', 'F'],
  })).corpo;
  const pub = (await c('GET', `/api/publico/${camp.slug}`)).corpo;
  assert.equal(pub.chave.gerado, true);
  assert.equal(pub.chave.modelo, 'manual');
  assert.equal(pub.chave.slots.length, 6);
  // Escada: quatro entradas tardias (uma por degrau depois do primeiro).
  assert.equal(pub.chave.slots.filter((s) => s.rodada > 1).length, 4);
});

test('misto Padrao: nada muda (Melhores Colocados intocado)', async () => {
  const c = cliente();
  await registrarEntrar(c, 'misto6@teste.com');
  const camp = (await c('POST', '/api/campeonatos', {
    nome: 'Mista padrao', formato: 'grupos_mata', num_grupos: 3, classificados_por_grupo: 2, sortear: false,
    times: ['A1', 'A2', 'A3', 'B1', 'B2', 'B3', 'C1', 'C2', 'C3'],
  })).corpo;
  assert.equal(camp.mata_modelo, 'padrao');
  assert.equal(camp.mata_chave, null);

  const det = (await c('GET', `/api/campeonatos/${camp.id}`)).corpo;
  assert.equal(det.vagas.modo, 'repescagem', '3x2 = 6 diretos + 2 melhores 3os, como antes');
  assert.equal(det.vagas.chave, 8);

  await jogarGrupos(c, camp.id);
  const gerou = await c('POST', `/api/campeonatos/${camp.id}/gerar-mata`);
  assert.equal(gerou.status, 201);
  assert.equal(gerou.corpo.jogos_criados, 7, 'chave de 8 = 7 jogos');
});
