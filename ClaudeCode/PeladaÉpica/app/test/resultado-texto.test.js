// Testes do registro de resultado por texto estruturado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsearResultadoTexto } from '../src/resultado-texto.js';

const times = {
  casa: {
    id: 1, nome: 'Casa FC',
    jogadores: [
      { id: 11, nome: 'Theo' },
      { id: 12, nome: 'Lionel Messi' },
      { id: 13, nome: 'Leo' },
      { id: 14, nome: 'Pedro' },
    ],
  },
  fora: {
    id: 2, nome: 'Fora EC',
    jogadores: [
      { id: 21, nome: 'Cristiano Ronaldo' },
      { id: 22, nome: 'Fred' },
      { id: 23, nome: 'Thiago' },
    ],
  },
};

test('exemplo completo da especificacao: placar 4x3 calculado', () => {
  const r = parsearResultadoTexto(
    `GOLS TIME CASA
Theo,2
Lionel Messi,2
GOLS TIME VISITANTE
Cristiano Ronaldo,2
Fred,1
CARTÕES TIME CASA
A,Leo
V,Pedro
CARTÕES TIME VISITANTE
A,Thiago`,
    times,
  );
  assert.equal(r.gols_casa, 4);
  assert.equal(r.gols_fora, 3);
  assert.equal(r.eventos.filter((e) => e.tipo === 'gol' && e.time_id === 1).length, 4);
  assert.equal(r.eventos.filter((e) => e.tipo === 'gol' && e.jogador_id === 11).length, 2); // Theo
  assert.deepEqual(
    r.eventos.filter((e) => e.tipo !== 'gol').map((e) => [e.tipo, e.jogador_id]),
    [['amarelo', 13], ['vermelho', 14], ['amarelo', 23]],
  );
});

test('nome sem quantidade vale 1 gol; maiusculas e acentos nao importam', () => {
  const r = parsearResultadoTexto('gols time casa\ntheo\nCARTOES TIME VISITANTE\na,THIAGO', times);
  assert.equal(r.gols_casa, 1);
  assert.equal(r.eventos[0].jogador_id, 11);
  assert.equal(r.eventos[1].tipo, 'amarelo');
  assert.equal(r.eventos[1].jogador_id, 23);
});

test('gol contra: GC valida o jogador no time ADVERSARIO e conta para o time da secao', () => {
  const r = parsearResultadoTexto('GOLS TIME CASA\nGC,Fred', times);
  assert.equal(r.gols_casa, 1);
  assert.equal(r.gols_fora, 0);
  assert.deepEqual(r.eventos, [{ tipo: 'gol_contra', time_id: 1, jogador_id: 22 }]);
  // Fred e do time visitante: como gol normal da casa, deve falhar
  assert.throws(() => parsearResultadoTexto('GOLS TIME CASA\nFred', times), /nao encontrado no elenco de Casa FC/);
});

test('SR registra gols sem autor; GC sem nome tambem vale', () => {
  const r = parsearResultadoTexto('GOLS TIME VISITANTE\nSR,3\nGC\nSEM REGISTRO', times);
  assert.equal(r.gols_fora, 5);
  assert.equal(r.eventos.filter((e) => e.jogador_id === null).length, 5);
  assert.equal(r.eventos.filter((e) => e.tipo === 'gol_contra').length, 1);
});

test('erros apontam a linha: jogador desconhecido, secao ausente, marcador invalido', () => {
  assert.throws(
    () => parsearResultadoTexto('GOLS TIME CASA\nPele', times),
    /Linha 2: jogador "Pele" nao encontrado no elenco de Casa FC/,
  );
  assert.throws(() => parsearResultadoTexto('Theo,2', times), /Linha 1: comece com um titulo de secao/);
  assert.throws(
    () => parsearResultadoTexto('CARTOES TIME CASA\nX,Leo', times),
    /Linha 2: use "A" \(amarelo\) ou "V" \(vermelho\)/,
  );
  assert.throws(() => parsearResultadoTexto('CARTOES TIME CASA\nA,', times), /Linha 2: informe o nome/);
});

test('texto vazio ou so cabecalhos = 0 x 0 sem eventos', () => {
  const r = parsearResultadoTexto('GOLS TIME CASA\nGOLS TIME VISITANTE\nCARTÕES TIME CASA', times);
  assert.equal(r.gols_casa, 0);
  assert.equal(r.gols_fora, 0);
  assert.equal(r.eventos.length, 0);
});

test('quantidade zero e rejeitada', () => {
  assert.throws(() => parsearResultadoTexto('GOLS TIME CASA\nTheo,0', times), /quantidade de gols invalida/);
});
