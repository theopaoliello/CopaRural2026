import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abrirBanco, migrar } from '../db/db.js';
import { criarLoja, listarLojas, tokenDaLoja } from '../src/lojas.js';
import { criarOS } from '../src/os.js';
import { registrarRecebimento } from '../src/recebimento.js';
import { autenticarLoja, painelLoja } from '../src/portal.js';

function cenario() {
  const db = migrar(abrirBanco(':memory:'));
  const l1 = criarLoja(db, { nome: 'Loja A', janela_dias: 15 });
  const l2 = criarLoja(db, { nome: 'Loja B', janela_dias: 7 });
  const t1 = tokenDaLoja(db, l1.id);
  const t2 = tokenDaLoja(db, l2.id);
  const os = criarOS(db, {
    cliente: { nome: 'Cliente Teste' },
    partes: [
      { loja_id: l1.id, itens: [{ descricao: 'Carta X', quantidade: 1 }] },
      { loja_id: l2.id, itens: [{ descricao: 'Carta Y', quantidade: 2 }] },
    ],
  });
  return { db, l1, l2, t1, t2, os };
}

test('criarLoja gera token de acesso no formato LJ-', () => {
  const { t1, t2 } = cenario();
  assert.match(t1, /^LJ-[0-9A-F]{10}$/);
  assert.match(t2, /^LJ-[0-9A-F]{10}$/);
  assert.notEqual(t1, t2);
});

test('token NAO aparece em criarLoja nem em listarLojas (so via tokenDaLoja)', () => {
  const { db, l1 } = cenario();
  assert.equal(l1.token, undefined);
  for (const loja of listarLojas(db)) assert.equal(loja.token, undefined);
  assert.match(tokenDaLoja(db, l1.id), /^LJ-/);
  assert.throws(() => tokenDaLoja(db, 9999), (e) => e.statusCode === 404);
});

test('autenticarLoja aceita token valido (case-insensitive) e nao expoe o token', () => {
  const { db, l1, t1 } = cenario();
  const loja = autenticarLoja(db, t1.toLowerCase());
  assert.equal(loja.id, l1.id);
  assert.equal(loja.nome, 'Loja A');
  assert.equal(loja.token, undefined);
});

test('autenticarLoja rejeita token invalido/vazio com 401', () => {
  const { db } = cenario();
  for (const t of ['LJ-0000000000', '', null]) {
    assert.throws(() => autenticarLoja(db, t), (e) => e.statusCode === 401);
  }
});

test('autenticarLoja rejeita loja inativa', () => {
  const { db, l1, t1 } = cenario();
  db.prepare('UPDATE loja SET ativo = 0 WHERE id = ?').run(l1.id);
  assert.throws(() => autenticarLoja(db, t1), (e) => e.statusCode === 401);
});

test('painelLoja lista somente as partes da loja autenticada', () => {
  const { db, l1, os } = cenario();
  const { resumo, partes } = painelLoja(db, l1.id);
  assert.equal(partes.length, 1);
  assert.equal(partes[0].os_codigo, os.codigo);
  assert.equal(partes[0].itens[0].descricao, 'Carta X');
  assert.equal(resumo.total, 1);
  assert.equal(resumo.aguardando, 1);
  assert.equal(resumo.no_hub, 0);
});

test('painelLoja deriva atraso em aberto e conta no resumo', () => {
  const { db, l1 } = cenario();
  db.prepare("UPDATE parte SET prazo_limite = '2020-01-01T00:00:00.000Z' WHERE loja_id = ?").run(l1.id);
  const { resumo, partes } = painelLoja(db, l1.id);
  assert.equal(partes[0].atrasada, true);
  assert.ok(partes[0].dias_atraso > 0);
  assert.equal(resumo.atrasadas, 1);
});

test('painelLoja mantem atraso historico apos o recebimento', () => {
  const { db, l1 } = cenario();
  db.prepare("UPDATE parte SET prazo_limite = '2020-01-01T00:00:00.000Z' WHERE loja_id = ?").run(l1.id);
  const cod = db.prepare('SELECT codigo_barras FROM parte WHERE loja_id = ?').get(l1.id).codigo_barras;
  registrarRecebimento(db, cod, 'op1');
  const { resumo, partes } = painelLoja(db, l1.id);
  assert.equal(partes[0].atrasada, false);
  assert.equal(partes[0].recebida_atrasada, true);
  assert.ok(partes[0].dias_atraso > 0);
  assert.equal(resumo.atrasos_registrados, 1);
  assert.equal(resumo.no_hub, 1);
});

test('migracao: banco antigo sem coluna token ganha a coluna e o backfill', () => {
  const db = abrirBanco(':memory:');
  db.exec(`CREATE TABLE loja (
    id INTEGER PRIMARY KEY, nome TEXT NOT NULL, cidade_uf TEXT,
    janela_dias INTEGER NOT NULL DEFAULT 15, ativo INTEGER NOT NULL DEFAULT 1,
    criado_em TEXT NOT NULL)`);
  db.prepare("INSERT INTO loja (nome, criado_em) VALUES ('Antiga', '2026-01-01T00:00:00.000Z')").run();
  migrar(db);
  const loja = db.prepare("SELECT * FROM loja WHERE nome = 'Antiga'").get();
  assert.match(loja.token, /^LJ-[0-9A-F]{10}$/);
});
