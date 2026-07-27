// Testes do cadastro de jogadores em lote (parser "nome,numero").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsearLoteJogadores } from '../src/jogadores.js';

test('lote: exemplo da especificacao (numero opcional)', () => {
  const lote = parsearLoteJogadores(
    'Theo,10\nLeandro,7\nJunior\nBernardo\nMiguel,11',
  );
  assert.deepEqual(lote, [
    { nome: 'Theo', numero: 10 },
    { nome: 'Leandro', numero: 7 },
    { nome: 'Junior', numero: null },
    { nome: 'Bernardo', numero: null },
    { nome: 'Miguel', numero: 11 },
  ]);
});

test('lote: rejeita nome acima de 25 caracteres', () => {
  assert.throws(
    () => parsearLoteJogadores('Theo,10\nJose Carlos da Silva Sauro,7'),
    /Linha 2: nome muito longo \(limite: 25 caracteres\)/,
  );
});

test('lote: ignora linhas vazias e espacos extras', () => {
  const lote = parsearLoteJogadores('  Theo , 10 \n\n\n  Junior  \n');
  assert.deepEqual(lote, [
    { nome: 'Theo', numero: 10 },
    { nome: 'Junior', numero: null },
  ]);
});

test('lote: virgula sem numero valido vira parte do nome', () => {
  const lote = parsearLoteJogadores('Silva, Joao\nMaia,9a');
  assert.deepEqual(lote, [
    { nome: 'Silva, Joao', numero: null },
    { nome: 'Maia,9a', numero: null },
  ]);
});

test('lote: nome com virgula E numero usa a ultima virgula', () => {
  const lote = parsearLoteJogadores('Silva, Joao,9');
  assert.deepEqual(lote, [{ nome: 'Silva, Joao', numero: 9 }]);
});

test('lote: texto vazio e linha so com virgula/numero dao erro claro', () => {
  assert.throws(() => parsearLoteJogadores(''), /pelo menos um jogador/);
  assert.throws(() => parsearLoteJogadores('   \n  '), /pelo menos um jogador/);
  assert.throws(() => parsearLoteJogadores('Theo,10\n,7'), /Linha 2/);
});
