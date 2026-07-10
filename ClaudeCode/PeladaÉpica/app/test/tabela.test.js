// Testes da geracao de confrontos (pontos corridos e mata-mata).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gerarPontosCorridos, gerarMataMata, dividirEmGrupos,
  ordemChaveamento, vencedorConfronto, seedsDeGrupos, nomeFaseMata,
} from '../src/tabela.js';

test('pontos corridos: 4 times, turno unico = 6 jogos em 3 rodadas', () => {
  const jogos = gerarPontosCorridos([1, 2, 3, 4]);
  assert.equal(jogos.length, 6);
  assert.equal(Math.max(...jogos.map((j) => j.rodada)), 3);
  // cada time joga 3 vezes
  for (const id of [1, 2, 3, 4]) {
    const doTime = jogos.filter((j) => j.time_casa_id === id || j.time_fora_id === id);
    assert.equal(doTime.length, 3, `time ${id}`);
  }
  // todos os pares se enfrentam exatamente uma vez
  const pares = new Set(jogos.map((j) => [j.time_casa_id, j.time_fora_id].sort().join('-')));
  assert.equal(pares.size, 6);
});

test('pontos corridos: turno e returno dobra os jogos com mando invertido', () => {
  const jogos = gerarPontosCorridos([1, 2, 3, 4], { idaEVolta: true });
  assert.equal(jogos.length, 12);
  assert.equal(Math.max(...jogos.map((j) => j.rodada)), 6);
  const ida = jogos.filter((j) => j.rodada <= 3);
  const volta = jogos.filter((j) => j.rodada > 3);
  for (const j of ida) {
    assert.ok(
      volta.some((v) => v.time_casa_id === j.time_fora_id && v.time_fora_id === j.time_casa_id),
      'jogo de volta com mando invertido',
    );
  }
});

test('pontos corridos: numero impar de times gera folga (cada rodada tem um de fora)', () => {
  const jogos = gerarPontosCorridos([1, 2, 3, 4, 5]);
  assert.equal(jogos.length, 10); // C(5,2)
  assert.equal(Math.max(...jogos.map((j) => j.rodada)), 5);
  for (let r = 1; r <= 5; r++) {
    assert.equal(jogos.filter((j) => j.rodada === r).length, 2);
  }
});

test('pontos corridos: nenhum time joga duas vezes na mesma rodada', () => {
  const jogos = gerarPontosCorridos([1, 2, 3, 4, 5, 6, 7, 8]);
  for (let r = 1; r <= 7; r++) {
    const daRodada = jogos.filter((j) => j.rodada === r);
    const ids = daRodada.flatMap((j) => [j.time_casa_id, j.time_fora_id]);
    assert.equal(new Set(ids).size, ids.length, `rodada ${r}`);
  }
});

test('dividir em grupos: sequencial na ordem recebida (sem sorteio, o organizador controla)', () => {
  assert.deepEqual(dividirEmGrupos([1, 2, 3, 4, 5, 6, 7, 8], 2), [[1, 2, 3, 4], [5, 6, 7, 8]]);
  assert.deepEqual(dividirEmGrupos([1, 2, 3, 4, 5, 6], 3), [[1, 2], [3, 4], [5, 6]]);
});

test('dividir em grupos: sobra vai para os primeiros grupos', () => {
  assert.deepEqual(dividirEmGrupos([1, 2, 3, 4, 5, 6, 7], 2), [[1, 2, 3, 4], [5, 6, 7]]);
});

test('dividir em grupos: rejeita grupo com menos de 2 times', () => {
  assert.throws(() => dividirEmGrupos([1, 2, 3], 2), /pelo menos 2 times/);
});

test('ordem de chaveamento classica: 1 e 2 so se encontram na final', () => {
  assert.deepEqual(ordemChaveamento(4), [1, 4, 2, 3]);
  assert.deepEqual(ordemChaveamento(8), [1, 8, 4, 5, 2, 7, 3, 6]);
});

test('mata-mata de 8 times: 4+2+1 confrontos, rodadas futuras vazias', () => {
  const seeds = [10, 20, 30, 40, 50, 60, 70, 80];
  const jogos = gerarMataMata(seeds);
  assert.equal(jogos.length, 7);
  const r1 = jogos.filter((j) => j.rodada === 1);
  assert.equal(r1.length, 4);
  // seed 1 (10) enfrenta seed 8 (80) no confronto 0
  assert.deepEqual([r1[0].time_casa_id, r1[0].time_fora_id], [10, 80]);
  // rodadas 2 e 3 sem times definidos
  for (const j of jogos.filter((x) => x.rodada > 1)) {
    assert.equal(j.time_casa_id, null);
    assert.equal(j.time_fora_id, null);
  }
});

test('mata-mata ida e volta: 2 pernas por confronto com mando invertido', () => {
  const jogos = gerarMataMata([1, 2], { idaEVolta: true });
  assert.equal(jogos.length, 2);
  assert.deepEqual([jogos[0].time_casa_id, jogos[0].time_fora_id], [1, 2]);
  assert.deepEqual([jogos[1].time_casa_id, jogos[1].time_fora_id], [2, 1]);
});

test('mata-mata rejeita quantidade que nao e potencia de 2', () => {
  assert.throws(() => gerarMataMata([1, 2, 3]), /potencia de 2/);
});

test('mata-mata com pareamento "lista": ordem digitada vira o chaveamento (1x2, 3x4)', () => {
  const r1 = gerarMataMata([10, 20, 30, 40], { pareamento: 'lista' }).filter((j) => j.rodada === 1);
  assert.deepEqual([r1[0].time_casa_id, r1[0].time_fora_id], [10, 20]);
  assert.deepEqual([r1[1].time_casa_id, r1[1].time_fora_id], [30, 40]);
});

test('vencedor do confronto: agregado simples', () => {
  const pernas = [
    { time_casa_id: 1, time_fora_id: 2, gols_casa: 2, gols_fora: 0, status: 'encerrado', penaltis_casa: null, penaltis_fora: null },
    { time_casa_id: 2, time_fora_id: 1, gols_casa: 1, gols_fora: 0, status: 'encerrado', penaltis_casa: null, penaltis_fora: null },
  ];
  assert.equal(vencedorConfronto(pernas), 1); // agregado 2x1
});

test('vencedor do confronto: empate agregado decide nos penaltis da ultima perna', () => {
  const pernas = [
    { time_casa_id: 1, time_fora_id: 2, gols_casa: 1, gols_fora: 0, status: 'encerrado', penaltis_casa: null, penaltis_fora: null },
    { time_casa_id: 2, time_fora_id: 1, gols_casa: 1, gols_fora: 0, status: 'encerrado', penaltis_casa: 4, penaltis_fora: 3 },
  ];
  assert.equal(vencedorConfronto(pernas), 2); // casa da perna 2
});

test('vencedor do confronto: indefinido se ha perna pendente ou empate sem penaltis', () => {
  assert.equal(vencedorConfronto([
    { time_casa_id: 1, time_fora_id: 2, gols_casa: 1, gols_fora: 1, status: 'agendado', penaltis_casa: null, penaltis_fora: null },
  ]), null);
  assert.equal(vencedorConfronto([
    { time_casa_id: 1, time_fora_id: 2, gols_casa: 1, gols_fora: 1, status: 'encerrado', penaltis_casa: null, penaltis_fora: null },
  ]), null);
});

test('seeds de grupos cruzam 1os e 2os colocados (1oA x 2oB, 1oB x 2oA)', () => {
  // Grupo A: [11 (1o), 12 (2o)] | Grupo B: [21 (1o), 22 (2o)]
  const seeds = seedsDeGrupos([[11, 12], [21, 22]], 2);
  assert.deepEqual(seeds, [11, 21, 12, 22]);
  const r1 = gerarMataMata(seeds).filter((j) => j.rodada === 1);
  // chaveamento de 4: seed1 x seed4 e seed2 x seed3
  assert.deepEqual([r1[0].time_casa_id, r1[0].time_fora_id], [11, 22]); // 1oA x 2oB
  assert.deepEqual([r1[1].time_casa_id, r1[1].time_fora_id], [21, 12]); // 1oB x 2oA
});

test('seeds de grupos: nenhum reencontro do mesmo grupo na 1a fase (4 grupos x 2)', () => {
  const grupos = [[11, 12], [21, 22], [31, 32], [41, 42]];
  const seeds = seedsDeGrupos(grupos, 2);
  const r1 = gerarMataMata(seeds).filter((j) => j.rodada === 1);
  const grupoDe = (id) => Math.floor(id / 10);
  for (const j of r1) {
    assert.notEqual(grupoDe(j.time_casa_id), grupoDe(j.time_fora_id));
  }
});

test('nomes das fases do mata-mata', () => {
  assert.equal(nomeFaseMata(1), 'Final');
  assert.equal(nomeFaseMata(2), 'Semifinal');
  assert.equal(nomeFaseMata(4), 'Quartas de final');
});
