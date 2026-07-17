// Testes do motor de Melhores Colocados (vagas extras e corte no mata-mata).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planoDeVagas, sugerirCombinacao, resumoDoPlano, tamanhosPrevistos,
  criteriosDeMedia, mediaDoCriterio, rankearEntreGrupos,
  montarSeeds, confrontosDaPrimeiraFase, ajustarReencontros,
} from '../src/melhores.js';
import { gerarMataMata } from '../src/tabela.js';

const plano = (numGrupos, classificados, totalTimes) =>
  planoDeVagas({ numGrupos, classificados, tamanhos: tamanhosPrevistos(totalTimes, numGrupos) });

// ---------- plano de vagas (RN-MC-02, tabela de exemplos da spec) ----------

test('potencia exata: comportamento atual, sem vagas extras nem corte', () => {
  assert.deepEqual(plano(4, 2, 12), {
    modo: 'exata', vagas: 8, diretosPorGrupo: 2, posicaoDisputa: null, emDisputa: 0,
  });
  assert.equal(plano(2, 2, 6).modo, 'exata');
});

test('repescagem: 3x2 completa para 8 com os 2 melhores 3os', () => {
  assert.deepEqual(plano(3, 2, 12), {
    modo: 'repescagem', vagas: 8, diretosPorGrupo: 2, posicaoDisputa: 3, emDisputa: 2,
  });
});

test('repescagem: 5x3 completa para 16 com o melhor 4o', () => {
  assert.deepEqual(plano(5, 3, 20), {
    modo: 'repescagem', vagas: 16, diretosPorGrupo: 3, posicaoDisputa: 4, emDisputa: 1,
  });
});

test('repescagem: 6x2 (+4 melhores 3os) e 7x2 (+2 melhores 3os) fecham 16', () => {
  assert.deepEqual(plano(6, 2, 18), {
    modo: 'repescagem', vagas: 16, diretosPorGrupo: 2, posicaoDisputa: 3, emDisputa: 4,
  });
  assert.deepEqual(plano(7, 2, 21), {
    modo: 'repescagem', vagas: 16, diretosPorGrupo: 2, posicaoDisputa: 3, emDisputa: 2,
  });
});

test('corte: 5x2 nao completa (precisaria de 6 terceiros) — so os 3 melhores 2os avancam', () => {
  assert.deepEqual(plano(5, 2, 15), {
    modo: 'corte', vagas: 8, diretosPorGrupo: 1, posicaoDisputa: 2, emDisputa: 3,
  });
});

test('corte: 3x3 vira chave de 8 com os 2 melhores 3os; 6x3 vira 16 com os 4 melhores', () => {
  assert.deepEqual(plano(3, 3, 12), {
    modo: 'corte', vagas: 8, diretosPorGrupo: 2, posicaoDisputa: 3, emDisputa: 2,
  });
  assert.deepEqual(plano(6, 3, 24), {
    modo: 'corte', vagas: 16, diretosPorGrupo: 2, posicaoDisputa: 3, emDisputa: 4,
  });
});

test('repescagem que classifica todos: 2x3 com 8 times equivale a 4 por grupo', () => {
  assert.deepEqual(plano(2, 3, 8), {
    modo: 'repescagem', vagas: 8, diretosPorGrupo: 3, posicaoDisputa: 4, emDisputa: 2,
  });
});

test('repescagem exige a posicao seguinte em todos os grupos', () => {
  // 3x3 com 10 times: grupos de 4, 3, 3 — sem 4a posicao no menor grupo,
  // completar (16) tambem pede 7 extras > 3: cai no corte.
  assert.equal(plano(3, 3, 10).modo, 'corte');
  // 3x3 com 8 times: grupos de 3, 3, 2 — nem corte (menor grupo sem 3o).
  assert.equal(plano(3, 3, 8).modo, 'inviavel');
});

test('inviavel: 5x5 nao completa (7 > 5) nem corta (9 > 5)', () => {
  assert.equal(plano(5, 5, 30).modo, 'inviavel');
});

test('sugestao para 5x5: manter os grupos e classificar 3 por grupo', () => {
  const s = sugerirCombinacao({ numGrupos: 5, classificados: 5, totalTimes: 30 });
  assert.equal(s.numGrupos, 5);
  assert.equal(s.classificados, 3);
  assert.equal(s.plano.modo, 'repescagem');
  assert.equal(s.plano.vagas, 16);
});

test('sugestao prefere completar/exata a cortar', () => {
  // 5x4 = 20 seria viavel por corte com mudanca menor, mas a sugestao pula.
  const s = sugerirCombinacao({ numGrupos: 5, classificados: 5, totalTimes: 30 });
  assert.notEqual(s.classificados, 4);
});

test('tamanhos previstos seguem a divisao sequencial (sobra nos primeiros grupos)', () => {
  assert.deepEqual(tamanhosPrevistos(7, 2), [4, 3]);
  assert.deepEqual(tamanhosPrevistos(12, 3), [4, 4, 4]);
});

// ---------- resumo (RN-MC-06) ----------

test('resumo do plano: frases da spec', () => {
  assert.equal(
    resumoDoPlano(plano(4, 2, 12), { numGrupos: 4, classificados: 2 }),
    '✅ Chave de 8: os 2 primeiros de cada grupo se classificam.',
  );
  assert.equal(
    resumoDoPlano(plano(3, 2, 12), { numGrupos: 3, classificados: 2 }),
    '✅ Chave de 8: 6 classificados diretos + os 2 melhores 3ºs colocados.',
  );
  assert.equal(
    resumoDoPlano(plano(5, 3, 20), { numGrupos: 5, classificados: 3 }),
    '✅ Chave de 16: 15 classificados diretos + o melhor 4º colocado.',
  );
  assert.equal(
    resumoDoPlano(plano(5, 2, 15), { numGrupos: 5, classificados: 2 }),
    '✅ Chave de 8: apenas os 3 melhores 2ºs avançam (2 ficam de fora).',
  );
  assert.equal(
    resumoDoPlano(plano(2, 3, 8), { numGrupos: 2, classificados: 3, tamanhos: tamanhosPrevistos(8, 2) }),
    '✅ Chave de 8: os 2 melhores 4ºs completam — equivale a classificar 4 por grupo.',
  );
  assert.equal(
    resumoDoPlano(plano(5, 5, 30), { numGrupos: 5, classificados: 5 }),
    '⚠️ Combinação inviável.',
  );
});

// ---------- ranking entre grupos (RN-MC-03) ----------

const linhaFut = (nome, pts, pj, v, sg, gp) => ({ nome, pts, pj, v, sg, gp });

test('ranking entre grupos compara por media: 4 pts em 3 jogos supera 5 pts em 4', () => {
  const r = rankearEntreGrupos(
    [linhaFut('Grande', 5, 4, 1, 0, 3), linhaFut('Pequeno', 4, 3, 1, 0, 2)],
    ['vitorias', 'saldo', 'gols_pro', 'confronto', 'cartoes'],
  );
  assert.deepEqual(r.map((l) => l.nome), ['Pequeno', 'Grande']);
});

test('criterios de media pulam confronto e cartoes, sempre puxados por pontos', () => {
  assert.deepEqual(
    criteriosDeMedia(['vitorias', 'saldo', 'gols_pro', 'confronto', 'cartoes']),
    ['pts', 'vitorias', 'saldo', 'gols_pro'],
  );
});

test('ranking segue a cadeia de criterios na ordem do esporte', () => {
  // Mesmos pontos e vitorias por jogo; saldo decide.
  const r = rankearEntreGrupos(
    [linhaFut('A3', 3, 3, 1, -1, 2), linhaFut('B3', 3, 3, 1, 2, 2)],
    ['vitorias', 'saldo', 'gols_pro'],
  );
  assert.deepEqual(r.map((l) => l.nome), ['B3', 'A3']);
});

test('empate total no ranking resolve por ordem alfabetica', () => {
  const r = rankearEntreGrupos(
    [linhaFut('Zebra', 3, 3, 1, 0, 2), linhaFut('Aguia', 3, 3, 1, 0, 2)],
    ['vitorias', 'saldo', 'gols_pro'],
  );
  assert.deepEqual(r.map((l) => l.nome), ['Aguia', 'Zebra']);
});

test('sets: dois times sem set perdido (razao MAX) seguem empatados e caem no alfabetico', () => {
  const a = { nome: 'Vespa', pts: 6, pj: 3, v: 3, sv: 6, sp: 0, saldo_sets: 6 };
  const b = { nome: 'Abelha', pts: 6, pj: 3, v: 3, sv: 6, sp: 0, saldo_sets: 6 };
  const r = rankearEntreGrupos([a, b], ['vitorias', 'razao_sets']);
  assert.deepEqual(r.map((l) => l.nome), ['Abelha', 'Vespa']);
  assert.equal(mediaDoCriterio(a, 'razao_sets'), Infinity);
});

test('time sem jogos tem media zero (nao quebra)', () => {
  assert.equal(mediaDoCriterio({ pts: 0, pj: 0 }, 'pts'), 0);
});

// ---------- seeds por potes e anti-reencontro (RN-MC-04) ----------

// Grupos codificados no id: grupo = floor(id / 10); posicao = id % 10.
const grupoDe = (id) => Math.floor(id / 10);
const linhas3Grupos = [
  [{ time_id: 11 }, { time_id: 12 }, { time_id: 13 }],
  [{ time_id: 21 }, { time_id: 22 }, { time_id: 23 }],
  [{ time_id: 31 }, { time_id: 32 }, { time_id: 33 }],
];

test('seeds por potes: 1os, depois 2os, repescados por ultimo na ordem do ranking', () => {
  const p = { modo: 'repescagem', vagas: 8, diretosPorGrupo: 2, posicaoDisputa: 3, emDisputa: 2 };
  const ranking = [{ time_id: 23 }, { time_id: 13 }, { time_id: 33 }];
  const { seeds, poteDoTime, repescados } = montarSeeds(linhas3Grupos, p, ranking);
  assert.deepEqual(seeds, [11, 21, 31, 12, 22, 32, 23, 13]);
  assert.deepEqual(repescados, [23, 13]);
  assert.equal(poteDoTime.get(11), 1);
  assert.equal(poteDoTime.get(32), 2);
  assert.equal(poteDoTime.get(13), 3);
});

test('corte: potes com C-1 diretos por grupo + os melhores C-esimos', () => {
  // 5 grupos x 2 com corte: 5 primeiros + 3 melhores 2os = chave de 8.
  const grupos = [1, 2, 3, 4, 5].map((g) => [{ time_id: g * 10 + 1 }, { time_id: g * 10 + 2 }]);
  const p = { modo: 'corte', vagas: 8, diretosPorGrupo: 1, posicaoDisputa: 2, emDisputa: 3 };
  const ranking = [{ time_id: 42 }, { time_id: 12 }, { time_id: 32 }, { time_id: 22 }, { time_id: 52 }];
  const { seeds } = montarSeeds(grupos, p, ranking);
  assert.deepEqual(seeds, [11, 21, 31, 41, 51, 42, 12, 32]);
});

test('confrontos da 1a fase equivalem ao pareamento por seeds do bracket atual', () => {
  const seeds = [11, 21, 31, 12, 22, 32, 23, 13];
  const pares = confrontosDaPrimeiraFase(seeds);
  const r1 = gerarMataMata(seeds).filter((j) => j.rodada === 1);
  assert.deepEqual(
    pares,
    r1.map((j) => [j.time_casa_id, j.time_fora_id]),
  );
});

test('anti-reencontro: troca com vizinho do mesmo pote resolve', () => {
  const p = { modo: 'repescagem', vagas: 8, diretosPorGrupo: 2, posicaoDisputa: 3, emDisputa: 2 };
  const ranking = [{ time_id: 13 }, { time_id: 23 }, { time_id: 33 }];
  const { seeds, poteDoTime } = montarSeeds(linhas3Grupos, p, ranking);
  const grupoDoTime = new Map(seeds.map((id) => [id, grupoDe(id)]));
  const pares = confrontosDaPrimeiraFase(seeds);
  // Sem ajuste ha reencontro (31 x 32 do grupo 3).
  assert.ok(pares.some(([a, b]) => grupoDoTime.get(a) === grupoDoTime.get(b)));
  const { pares: ajustados, reencontros } = ajustarReencontros(pares, grupoDoTime, poteDoTime);
  assert.deepEqual(reencontros, []);
  for (const [a, b] of ajustados) {
    assert.notEqual(grupoDoTime.get(a), grupoDoTime.get(b));
  }
  // A troca preserva os potes de cada confronto.
  const potes = (ps) => ps.map((par) => par.map((id) => poteDoTime.get(id)).sort().join('x'));
  assert.deepEqual(potes(ajustados), potes(pares));
});

test('anti-reencontro: quando o vizinho nao resolve, busca o confronto mais proximo que resolva', () => {
  // Repescados [33, 23]: o par (31, 32) so se resolve trocando com um
  // confronto a distancia 2 — trocar com o vizinho criaria novo reencontro.
  const p = { modo: 'repescagem', vagas: 8, diretosPorGrupo: 2, posicaoDisputa: 3, emDisputa: 2 };
  const ranking = [{ time_id: 33 }, { time_id: 23 }];
  const { seeds, poteDoTime } = montarSeeds(linhas3Grupos, p, ranking);
  const grupoDoTime = new Map(seeds.map((id) => [id, grupoDe(id)]));
  const { pares: ajustados, reencontros } = ajustarReencontros(
    confrontosDaPrimeiraFase(seeds), grupoDoTime, poteDoTime,
  );
  assert.deepEqual(reencontros, []);
  for (const [a, b] of ajustados) {
    assert.notEqual(grupoDe(a), grupoDe(b));
  }
});

test('anti-reencontro impossivel: confronto permanece e e sinalizado', () => {
  // 1 grupo x 1 classificado + melhor 2o: final entre 1o e 2o do mesmo grupo.
  const pares = [[11, 12]];
  const grupoDoTime = new Map([[11, 1], [12, 1]]);
  const poteDoTime = new Map([[11, 1], [12, 2]]);
  const { pares: ajustados, reencontros } = ajustarReencontros(pares, grupoDoTime, poteDoTime);
  assert.deepEqual(ajustados, [[11, 12]]);
  assert.deepEqual(reencontros, [0]);
});
