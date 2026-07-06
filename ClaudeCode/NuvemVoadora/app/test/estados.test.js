import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OS,
  PARTE,
  TransicaoInvalida,
  podeTransicionarOS,
  validarTransicaoOS,
  podeTransicionarParte,
  validarTransicaoParte,
  statusPorCompletude,
  parteEstaAtrasada,
} from '../src/estados.js';

test('OS: transicoes validas do fluxo feliz', () => {
  assert.ok(podeTransicionarOS(OS.ABERTA, OS.PENDENTE));
  assert.ok(podeTransicionarOS(OS.PENDENTE, OS.LIBERADA_SEPARACAO));
  assert.ok(podeTransicionarOS(OS.LIBERADA_SEPARACAO, OS.EM_SEPARACAO));
  assert.ok(podeTransicionarOS(OS.EM_SEPARACAO, OS.PRONTA_DESPACHO));
});

test('OS: transicoes invalidas sao rejeitadas', () => {
  assert.equal(podeTransicionarOS(OS.ABERTA, OS.LIBERADA_SEPARACAO), false);
  assert.equal(podeTransicionarOS(OS.PENDENTE, OS.EM_SEPARACAO), false);
  assert.throws(() => validarTransicaoOS(OS.ABERTA, OS.PRONTA_DESPACHO), TransicaoInvalida);
});

test('Parte: recebimento e consolidacao', () => {
  assert.ok(podeTransicionarParte(PARTE.AGUARDANDO, PARTE.RECEBIDA));
  assert.ok(podeTransicionarParte(PARTE.RECEBIDA, PARTE.CONSOLIDADA));
  assert.equal(podeTransicionarParte(PARTE.AGUARDANDO, PARTE.CONSOLIDADA), false);
  assert.throws(() => validarTransicaoParte(PARTE.CONSOLIDADA, PARTE.RECEBIDA), TransicaoInvalida);
});

test('Parte: excecoes (quarentena / recusa / reposicao)', () => {
  assert.ok(podeTransicionarParte(PARTE.AGUARDANDO, PARTE.QUARENTENA));
  assert.ok(podeTransicionarParte(PARTE.QUARENTENA, PARTE.RECEBIDA));
  assert.ok(podeTransicionarParte(PARTE.RECUSADA, PARTE.AGUARDANDO));
});

test('Liberacao automatica: so libera com TODAS as partes recebidas', () => {
  assert.equal(statusPorCompletude([]), OS.PENDENTE);
  assert.equal(statusPorCompletude([PARTE.RECEBIDA, PARTE.AGUARDANDO]), OS.PENDENTE);
  assert.equal(statusPorCompletude([PARTE.RECEBIDA, PARTE.RECUSADA]), OS.PENDENTE);
  assert.equal(
    statusPorCompletude([PARTE.RECEBIDA, PARTE.RECEBIDA, PARTE.RECEBIDA]),
    OS.LIBERADA_SEPARACAO,
  );
});

test('Atraso derivado: apenas parte AGUARDANDO com prazo vencido', () => {
  const agora = new Date('2026-07-06T12:00:00Z');
  const ontem = '2026-07-05T12:00:00Z';
  const amanha = '2026-07-07T12:00:00Z';
  assert.equal(parteEstaAtrasada(PARTE.AGUARDANDO, ontem, agora), true);
  assert.equal(parteEstaAtrasada(PARTE.AGUARDANDO, amanha, agora), false);
  // ja recebida nunca esta atrasada, mesmo com prazo vencido
  assert.equal(parteEstaAtrasada(PARTE.RECEBIDA, ontem, agora), false);
  assert.equal(parteEstaAtrasada(PARTE.AGUARDANDO, null, agora), false);
});
