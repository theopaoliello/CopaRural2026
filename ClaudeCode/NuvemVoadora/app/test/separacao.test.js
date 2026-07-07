import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abrirBanco, migrar } from '../db/db.js';
import { criarLoja } from '../src/lojas.js';
import { criarOS } from '../src/os.js';
import { registrarRecebimento } from '../src/recebimento.js';
import { filaSeparacao, iniciarSeparacao, scanConsolidacao, finalizarSeparacao } from '../src/separacao.js';
import { OS, PARTE } from '../src/estados.js';

// Cria uma OS e recebe todas as partes, deixando-a LIBERADA_SEPARACAO.
function osLiberada(db, nPartes = 3) {
  const lojas = [];
  for (let i = 0; i < nPartes; i++) lojas.push(criarLoja(db, { nome: 'Loja ' + i }));
  const os = criarOS(db, {
    cliente: { nome: 'Cliente' },
    partes: lojas.map((l) => ({ loja_id: l.id, itens: [{ descricao: 'x' }] })),
  });
  for (const p of os.partes) registrarRecebimento(db, p.codigo_barras, 'op');
  return os;
}

test('fila mostra apenas OS liberadas', () => {
  const db = migrar(abrirBanco(':memory:'));
  osLiberada(db, 2);
  const fila = filaSeparacao(db);
  assert.equal(fila.length, 1);
  assert.equal(fila[0].total_partes, 2);
});

test('OS EM_SEPARACAO continua na fila até ser fechada (retomável)', () => {
  const db = migrar(abrirBanco(':memory:'));
  const os = osLiberada(db, 2);
  iniciarSeparacao(db, os.codigo);
  // ainda visivel na fila, agora com status EM_SEPARACAO e progresso
  const fila = filaSeparacao(db);
  assert.equal(fila.length, 1);
  assert.equal(fila[0].status, OS.EM_SEPARACAO);
  assert.equal(fila[0].consolidadas, 0);
  // apos fechar, sai da fila
  scanConsolidacao(db, os.codigo, os.partes[0].codigo_barras, 'op');
  scanConsolidacao(db, os.codigo, os.partes[1].codigo_barras, 'op');
  finalizarSeparacao(db, os.codigo);
  assert.equal(filaSeparacao(db).length, 0);
});

test('iniciarSeparacao move para EM_SEPARACAO e trava segundo inicio', () => {
  const db = migrar(abrirBanco(':memory:'));
  const os = osLiberada(db, 2);
  const r = iniciarSeparacao(db, os.codigo);
  assert.equal(r.status, OS.EM_SEPARACAO);
  // segundo inicio deve falhar (ja nao esta LIBERADA)
  assert.throws(() => iniciarSeparacao(db, os.codigo), /EM_SEPARACAO/);
});

test('scan de conferencia consolida cada parte e detecta completude', () => {
  const db = migrar(abrirBanco(':memory:'));
  const os = osLiberada(db, 2);
  iniciarSeparacao(db, os.codigo);
  const r1 = scanConsolidacao(db, os.codigo, os.partes[0].codigo_barras, 'op');
  assert.equal(r1.resultado, 'OK');
  assert.equal(r1.completo, false);
  const r2 = scanConsolidacao(db, os.codigo, os.partes[1].codigo_barras, 'op');
  assert.equal(r2.resultado, 'OK');
  assert.equal(r2.completo, true);
});

test('scan de parte de OUTRA OS gera ALERTA (RF-08.2)', () => {
  const db = migrar(abrirBanco(':memory:'));
  const osA = osLiberada(db, 2);
  const osB = osLiberada(db, 2);
  iniciarSeparacao(db, osA.codigo);
  const r = scanConsolidacao(db, osA.codigo, osB.partes[0].codigo_barras, 'op');
  assert.equal(r.resultado, 'ALERTA');
});

test('scan repetido da mesma parte na caixa = DUPLICADO', () => {
  const db = migrar(abrirBanco(':memory:'));
  const os = osLiberada(db, 2);
  iniciarSeparacao(db, os.codigo);
  scanConsolidacao(db, os.codigo, os.partes[0].codigo_barras, 'op');
  const r = scanConsolidacao(db, os.codigo, os.partes[0].codigo_barras, 'op');
  assert.equal(r.resultado, 'DUPLICADO');
});

test('finalizar bloqueia com caixa incompleta e conclui com N de N (RF-08.3/4)', () => {
  const db = migrar(abrirBanco(':memory:'));
  const os = osLiberada(db, 2);
  iniciarSeparacao(db, os.codigo);
  scanConsolidacao(db, os.codigo, os.partes[0].codigo_barras, 'op');
  // faltando 1 parte -> bloqueia
  assert.throws(() => finalizarSeparacao(db, os.codigo), /Faltam/);
  scanConsolidacao(db, os.codigo, os.partes[1].codigo_barras, 'op');
  const fim = finalizarSeparacao(db, os.codigo);
  assert.equal(fim.status, OS.PRONTA_DESPACHO);
  assert.ok(fim.pronta_em);
  assert.ok(fim.partes.every((p) => p.status === PARTE.CONSOLIDADA));
});
