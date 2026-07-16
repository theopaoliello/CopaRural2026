// Fase 4c multiesporte: Sorteio Premium e matriz de entrosamento (EF secao 7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matrizEntrosamento, sortearTimes } from '../src/sorteio.js';

// Gerador deterministico (LCG) para testes estatisticos estaveis.
function lcg(semente) {
  let s = semente >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const FIXOS = [
  { id: 1, nome: 'Daniel', tipo: 'fixo', goleiro: 1 },
  { id: 2, nome: 'Marley', tipo: 'fixo', goleiro: 0 },
  { id: 3, nome: 'Theo', tipo: 'fixo', goleiro: 0 },
  { id: 4, nome: 'Wecsley', tipo: 'fixo', goleiro: 0 },
];
const TIMES = [{ id: 10, nome: 'Camisa' }, { id: 20, nome: 'Sem Camisa' }];

test('matriz de entrosamento: pares no mesmo time em jogos encerrados, diagonal com total de jogos', () => {
  const jogos = [
    { id: 1, status: 'encerrado' },
    { id: 2, status: 'encerrado' },
    { id: 3, status: 'agendado' }, // nao conta
  ];
  const escalacoes = [
    // jogo 1: Daniel+Theo juntos; Marley do outro lado com um suplente (id 9)
    { jogo_id: 1, jogador_id: 1, time_id: 10 }, { jogo_id: 1, jogador_id: 3, time_id: 10 },
    { jogo_id: 1, jogador_id: 2, time_id: 20 }, { jogo_id: 1, jogador_id: 9, time_id: 20 },
    // jogo 2: Daniel+Theo juntos de novo; Wecsley contra
    { jogo_id: 2, jogador_id: 1, time_id: 20 }, { jogo_id: 2, jogador_id: 3, time_id: 20 },
    { jogo_id: 2, jogador_id: 4, time_id: 10 },
    // jogo 3 (agendado, ja com escalacao do sorteio): nao entra na matriz
    { jogo_id: 3, jogador_id: 1, time_id: 10 }, { jogo_id: 3, jogador_id: 2, time_id: 10 },
  ];
  const m = matrizEntrosamento(FIXOS, jogos, escalacoes);
  // diagonal: jogos de cada um (Daniel 2, Marley 1, Theo 2, Wecsley 1)
  assert.deepEqual([m[0][0], m[1][1], m[2][2], m[3][3]], [2, 1, 2, 1]);
  assert.equal(m[0][2], 2); // Daniel e Theo: 2 jogos juntos (simetrica)
  assert.equal(m[2][0], 2);
  assert.equal(m[0][1], 0); // Daniel e Marley: sempre em times opostos
  assert.equal(m[0][3], 0); // Daniel e Wecsley: opostos no jogo 2
});

test('sorteio: todos alocados uma unica vez, tamanhos equilibrados e goleiros separados', () => {
  const rng = lcg(7);
  const presentes = [
    ...FIXOS,
    { id: 5, nome: 'Vitor', tipo: 'suplente', goleiro: 1 },
    { id: 6, nome: 'Rafael', tipo: 'suplente', goleiro: 0 },
    { id: 7, nome: 'Chico', tipo: 'fixo', goleiro: 0 },
  ];
  for (let i = 0; i < 50; i++) {
    const resultado = sortearTimes({
      times: TIMES, presentes, fixos: FIXOS, matriz: matrizEntrosamento(FIXOS, [], []), rng,
    });
    const todos = resultado.flatMap((t) => t.jogadores.map((j) => j.id)).sort((a, b) => a - b);
    assert.deepEqual(todos, [1, 2, 3, 4, 5, 6, 7]); // ninguem fora, ninguem duplicado
    const tamanhos = resultado.map((t) => t.jogadores.length);
    assert.ok(Math.abs(tamanhos[0] - tamanhos[1]) <= 1, `tamanhos ${tamanhos}`);
    // 2 goleiros presentes (Daniel fixo, Vitor suplente) e 2 times: um em cada
    for (const t of resultado) {
      assert.equal(t.jogadores.filter((j) => j.goleiro).length, 1, 'um goleiro por time');
    }
  }
});

test('sorteio: goleiros excedentes entram como jogadores de linha', () => {
  const rng = lcg(11);
  const presentes = [
    { id: 1, nome: 'G1', tipo: 'fixo', goleiro: 1 },
    { id: 2, nome: 'G2', tipo: 'fixo', goleiro: 1 },
    { id: 3, nome: 'G3', tipo: 'fixo', goleiro: 1 },
    { id: 4, nome: 'Linha', tipo: 'fixo', goleiro: 0 },
  ];
  for (let i = 0; i < 30; i++) {
    const resultado = sortearTimes({ times: TIMES, presentes, fixos: presentes, matriz: matrizEntrosamento(presentes, [], []), rng });
    // todos alocados, 2 por time, e cada time tem pelo menos 1 goleiro
    assert.deepEqual(resultado.map((t) => t.jogadores.length), [2, 2]);
    for (const t of resultado) assert.ok(t.jogadores.some((j) => j.goleiro));
  }
});

test('sorteio premium separa dupla quente; sorteio simples nao (estatistico, rng deterministico)', () => {
  // 8 fixos de linha (times de 4): folga para a ponderacao agir — num grupo
  // minusculo (2x2) a capacidade forca pares juntos independente do peso.
  const oito = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, nome: `J${i + 1}`, tipo: 'fixo', goleiro: 0 }));
  const matriz = matrizEntrosamento(oito, [], []);
  matriz[1][2] = 50; // J2 e J3 jogaram 50 vezes juntos; o resto e frio
  matriz[2][1] = 50;
  const juntos = (premium, semente) => {
    const rng = lcg(semente);
    let n = 0;
    for (let i = 0; i < 300; i++) {
      const resultado = sortearTimes({ times: TIMES, presentes: oito, fixos: oito, matriz, premium, rng });
      const timeDe = new Map(resultado.flatMap((t) => t.jogadores.map((j) => [j.id, t.time_id])));
      if (timeDe.get(2) === timeDe.get(3)) n += 1;
    }
    return n;
  };
  const premium = juntos(true, 42);
  const simples = juntos(false, 42);
  // uniforme (4+4), a dupla cai junta ~3/7 das vezes; no premium ela so cai
  // junta quando a capacidade forca (ela sobra pro time com vaga) — medido
  // ~13-20% contra ~36-50% do simples, em varias sementes.
  assert.ok(premium <= 70, `premium juntou a dupla quente ${premium}/300 vezes`);
  assert.ok(simples >= 90, `simples juntou a dupla so ${simples}/300 vezes`);
  assert.ok(premium < simples / 2, `premium ${premium} vs simples ${simples}`);
});

test('sorteio com matriz zerada: premium equivale ao simples (nao quebra, distribui tudo)', () => {
  const rng = lcg(3);
  const resultado = sortearTimes({
    times: TIMES, presentes: FIXOS, fixos: FIXOS, matriz: matrizEntrosamento(FIXOS, [], []), premium: true, rng,
  });
  assert.equal(resultado.flatMap((t) => t.jogadores).length, 4);
  assert.deepEqual(resultado.map((t) => t.jogadores.length), [2, 2]);
});
