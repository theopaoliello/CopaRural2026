import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  codigoOS,
  indiceParaLetra,
  gerarLetras,
  codigoParte,
  parseCodigo,
} from '../src/codigos.js';

test('codigoOS: formato NV-AA + seq de 5 digitos', () => {
  assert.equal(codigoOS(2026, 42), 'NV-2600042');
  assert.equal(codigoOS(2026, 1), 'NV-2600001');
  assert.equal(codigoOS(2030, 99999), 'NV-3099999');
  assert.throws(() => codigoOS(2026, 0), RangeError);
  assert.throws(() => codigoOS(2026, 100000), RangeError);
});

test('indiceParaLetra: base-26 bijetiva', () => {
  assert.equal(indiceParaLetra(0), 'A');
  assert.equal(indiceParaLetra(25), 'Z');
  assert.equal(indiceParaLetra(26), 'AA');
  assert.equal(indiceParaLetra(27), 'AB');
});

test('gerarLetras: sequencia das partes', () => {
  assert.deepEqual(gerarLetras(3), ['A', 'B', 'C']);
  assert.throws(() => gerarLetras(0), RangeError);
});

test('codigoParte: OS + letra', () => {
  assert.equal(codigoParte('NV-2600042', 'B'), 'NV-2600042-B');
});

test('parseCodigo: le OS e parte', () => {
  assert.deepEqual(parseCodigo('NV-2600042'), {
    codigoOS: 'NV-2600042',
    letra: null,
    ano: 2026,
    seq: 42,
    ehParte: false,
  });
  assert.deepEqual(parseCodigo('NV-2600042-A'), {
    codigoOS: 'NV-2600042',
    letra: 'A',
    ano: 2026,
    seq: 42,
    ehParte: true,
  });
});

test('parseCodigo: normaliza espacos/caixa e rejeita invalidos', () => {
  assert.equal(parseCodigo('  nv-2600042-a ').letra, 'A');
  assert.equal(parseCodigo('XPTO-1'), null);
  assert.equal(parseCodigo('NV-123'), null);
  assert.equal(parseCodigo(null), null);
});

test('round-trip: gera e le de volta', () => {
  const cod = codigoOS(2026, 7);
  const parte = codigoParte(cod, gerarLetras(2)[1]); // letra B
  const lido = parseCodigo(parte);
  assert.equal(lido.codigoOS, cod);
  assert.equal(lido.letra, 'B');
});
