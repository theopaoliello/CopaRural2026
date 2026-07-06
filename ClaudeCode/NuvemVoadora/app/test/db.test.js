import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abrirBanco, migrar, proximaSeqOS } from '../db/db.js';

function bancoNaMemoria() {
  return migrar(abrirBanco(':memory:'));
}

test('migrar: cria as tabelas esperadas', () => {
  const db = bancoNaMemoria();
  const nomes = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  for (const t of ['loja', 'ordem_servico', 'parte', 'item', 'evento_scan', 'contador_os']) {
    assert.ok(nomes.includes(t), `tabela ausente: ${t}`);
  }
  db.close();
});

test('proximaSeqOS: incrementa por ano e isola anos diferentes', () => {
  const db = bancoNaMemoria();
  assert.equal(proximaSeqOS(db, 2026), 1);
  assert.equal(proximaSeqOS(db, 2026), 2);
  assert.equal(proximaSeqOS(db, 2026), 3);
  assert.equal(proximaSeqOS(db, 2027), 1); // ano novo reinicia
  assert.equal(proximaSeqOS(db, 2026), 4);
  db.close();
});
