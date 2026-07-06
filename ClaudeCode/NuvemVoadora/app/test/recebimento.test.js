import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abrirBanco, migrar } from '../db/db.js';
import { criarLoja } from '../src/lojas.js';
import { criarOS } from '../src/os.js';
import { registrarRecebimento } from '../src/recebimento.js';
import { OS } from '../src/estados.js';

function cenario() {
  const db = migrar(abrirBanco(':memory:'));
  const l1 = criarLoja(db, { nome: 'Loja A', janela_dias: 15 });
  const l2 = criarLoja(db, { nome: 'Loja B', janela_dias: 7 });
  const os = criarOS(db, {
    cliente: { nome: 'Cliente Teste' },
    partes: [
      { loja_id: l1.id, itens: [{ descricao: 'Carta X', quantidade: 1 }] },
      { loja_id: l2.id, itens: [{ descricao: 'Carta Y', quantidade: 2 }] },
    ],
  });
  return { db, os };
}

test('recebimento parcial mantem OS PENDENTE', () => {
  const { db, os } = cenario();
  const codA = os.partes[0].codigo_barras;
  const r = registrarRecebimento(db, codA, 'op1');
  assert.equal(r.resultado, 'OK');
  assert.equal(r.liberou, false);
  assert.equal(r.os.status, OS.PENDENTE);
  assert.equal(r.os.recebidas, 1);
  assert.equal(r.os.faltam, 1);
});

test('receber TODAS as partes libera a OS automaticamente (RN-05.1)', () => {
  const { db, os } = cenario();
  registrarRecebimento(db, os.partes[0].codigo_barras, 'op1');
  const r = registrarRecebimento(db, os.partes[1].codigo_barras, 'op1');
  assert.equal(r.resultado, 'OK');
  assert.equal(r.liberou, true);
  assert.equal(r.os.status, OS.LIBERADA_SEPARACAO);
  assert.equal(r.os.recebidas, 2);
});

test('scan repetido da mesma parte retorna DUPLICADO', () => {
  const { db, os } = cenario();
  registrarRecebimento(db, os.partes[0].codigo_barras, 'op1');
  const r = registrarRecebimento(db, os.partes[0].codigo_barras, 'op1');
  assert.equal(r.resultado, 'DUPLICADO');
});

test('codigo invalido / inexistente retorna ERRO', () => {
  const { db } = cenario();
  assert.equal(registrarRecebimento(db, 'XPTO-1').resultado, 'ERRO');
  assert.equal(registrarRecebimento(db, 'NV-9900099-Z').resultado, 'ERRO');
});

test('scan grava evento de auditoria (RNF-02)', () => {
  const { db, os } = cenario();
  registrarRecebimento(db, os.partes[0].codigo_barras, 'joao');
  const ev = db.prepare("SELECT * FROM evento_scan WHERE tipo='ENTRADA' ORDER BY id DESC").get();
  assert.equal(ev.resultado, 'OK');
  assert.equal(ev.operador, 'joao');
  assert.ok(ev.criado_em);
});
