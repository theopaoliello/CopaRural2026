import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarLimitador } from '../src/ratelimit.js';

test('bloqueia a chave apos o maximo dentro da janela', () => {
  const lim = criarLimitador({ max: 3, janelaMs: 1000 });
  assert.equal(lim.tentar('ip1', 0), true);
  assert.equal(lim.tentar('ip1', 10), true);
  assert.equal(lim.tentar('ip1', 20), true);
  assert.equal(lim.tentar('ip1', 30), false); // 4a tentativa na janela
});

test('janela deslizante: libera quando as tentativas antigas expiram', () => {
  const lim = criarLimitador({ max: 2, janelaMs: 1000 });
  lim.tentar('ip1', 0);
  lim.tentar('ip1', 100);
  assert.equal(lim.tentar('ip1', 200), false);
  assert.equal(lim.tentar('ip1', 1101), true); // a de t=0 e t=100 expiraram
});

test('chaves independentes: um IP nao bloqueia o outro', () => {
  const lim = criarLimitador({ max: 1, janelaMs: 1000 });
  assert.equal(lim.tentar('ip1', 0), true);
  assert.equal(lim.tentar('ip1', 1), false);
  assert.equal(lim.tentar('ip2', 2), true);
});

test('middleware devolve erro 429 quando estoura', () => {
  const lim = criarLimitador({ max: 1, janelaMs: 60_000 });
  const req = { ip: '10.0.0.1' };
  let erro = null;
  lim.middleware(req, {}, (e) => { erro = e ?? null; });
  assert.equal(erro, null);
  lim.middleware(req, {}, (e) => { erro = e ?? null; });
  assert.equal(erro.statusCode, 429);
});
