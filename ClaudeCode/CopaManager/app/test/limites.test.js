// Testes dos limites por conta (EF Gestao de Contas, fase 1): tipos de conta,
// overrides do master e enforcement na criacao de campeonatos/times/jogadores.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { prepararBanco } from '../db/db.js';
import { criarCampeonato } from '../src/campeonatos.js';
import {
  TIPOS_CONTA, limitesDaConta,
  conferirLimiteCampeonatos, conferirLimiteTimes,
  conferirLimiteJogadoresTime, conferirLimiteJogadoresPelada,
} from '../src/limites.js';

let db;

before(() => {
  db = prepararBanco(':memory:');
});

const novaConta = (dados = {}) => Number(
  db.prepare(
    `INSERT INTO contas (nome, email, senha_hash, tipo, max_campeonatos, max_times, max_jogadores_time)
     VALUES (?, ?, 'x', ?, ?, ?, ?)`,
  ).run(
    dados.nome ?? 'Conta',
    dados.email ?? `c${Math.random().toString(36).slice(2)}@t.com`,
    dados.tipo ?? 'padrao',
    dados.max_campeonatos ?? null,
    dados.max_times ?? null,
    dados.max_jogadores_time ?? null,
  ).lastInsertRowid,
);

const criar = (contaId, dados = {}) => criarCampeonato(db, contaId, {
  nome: 'Copa', formato: 'pontos', sortear: false, times: ['A', 'B'], ...dados,
});

// ---------- limites efetivos ----------

test('limites da conta: padrao do tipo e limites globais', () => {
  const padrao = limitesDaConta(db, novaConta());
  assert.deepEqual(padrao, { tipo: 'padrao', max_campeonatos: 3, max_times: 48, max_jogadores_time: 30 });
  assert.equal(limitesDaConta(db, novaConta({ tipo: 'premium' })).max_campeonatos, 10);
  assert.equal(limitesDaConta(db, novaConta({ tipo: 'premium_plus' })).max_campeonatos, 30);
});

test('override do master tem precedencia sobre o tipo; NULL volta ao padrao', () => {
  const contaId = novaConta({ tipo: 'premium', max_campeonatos: 1, max_times: 4, max_jogadores_time: 2 });
  assert.deepEqual(limitesDaConta(db, contaId), {
    tipo: 'premium', max_campeonatos: 1, max_times: 4, max_jogadores_time: 2,
  });
  db.prepare('UPDATE contas SET max_campeonatos = NULL WHERE id = ?').run(contaId);
  assert.equal(limitesDaConta(db, contaId).max_campeonatos, 10);
});

test('tipo desconhecido no banco cai no padrao (defensivo)', () => {
  const contaId = novaConta();
  db.prepare("UPDATE contas SET tipo = 'invalido' WHERE id = ?").run(contaId);
  assert.equal(limitesDaConta(db, contaId).tipo, 'padrao');
  assert.equal(limitesDaConta(db, contaId).max_campeonatos, TIPOS_CONTA.padrao);
});

// ---------- limite de campeonatos (RN-GC-02/03) ----------

test('conta padrao cria 3 campeonatos; o 4o e recusado com orientacao', () => {
  const contaId = novaConta();
  for (let i = 1; i <= 3; i++) criar(contaId, { nome: `Copa ${i}` });
  assert.throws(() => criar(contaId, { nome: 'Copa 4' }), /limite de 3 campeonatos.*Exclua um campeonato/s);
  // excluir um libera a vaga (RN-GC-02: "para criar, exclua um")
  db.prepare('DELETE FROM campeonatos WHERE id = (SELECT MIN(id) FROM campeonatos WHERE conta_id = ?)').run(contaId);
  assert.ok(criar(contaId, { nome: 'Copa 4' }).id);
});

test('o limite vale tambem para a Pelada Epica (dispatch proprio)', () => {
  const contaId = novaConta({ max_campeonatos: 1 });
  criar(contaId);
  assert.throws(() => criarCampeonato(db, contaId, {
    nome: 'Pelada', esporte: 'pelada_epica', times: ['Camisa', 'Sem Camisa'],
    jogos_temporada: 10, jogadores_fixos: ['A', 'B'],
  }), /limite de 1 campeonatos/);
});

test('conferirLimiteCampeonatos devolve o consumo atual quando ha vaga', () => {
  const contaId = novaConta();
  assert.equal(conferirLimiteCampeonatos(db, contaId), 0);
  criar(contaId);
  assert.equal(conferirLimiteCampeonatos(db, contaId), 1);
});

// ---------- limites de estrutura (RN-GC-05/06/07) ----------

test('wizard recusa mais times que o limite da conta', () => {
  const contaId = novaConta({ max_times: 3 });
  assert.throws(
    () => criar(contaId, { times: ['A', 'B', 'C', 'D'] }),
    /Limite de 3 times por campeonato/,
  );
  assert.ok(criar(contaId, { times: ['A', 'B', 'C'] }).id);
});

test('limite global de 48 times vale sem override', () => {
  const contaId = novaConta();
  const muitos = Array.from({ length: 49 }, (_, i) => `T${i + 1}`);
  assert.throws(() => criar(contaId, { times: muitos }), /Limite de 48 times/);
});

test('conferirLimiteTimes/JogadoresTime validam o total resultante', () => {
  const contaId = novaConta({ max_times: 4, max_jogadores_time: 2 });
  conferirLimiteTimes(db, contaId, 4); // no teto, ok
  assert.throws(() => conferirLimiteTimes(db, contaId, 5), /Limite de 4 times/);
  conferirLimiteJogadoresTime(db, contaId, 2);
  assert.throws(() => conferirLimiteJogadoresTime(db, contaId, 3), /Limite de 2 jogadores por time/);
});

test('pelada: teto de jogadores por campeonato = limite por time x divisoes (RN-GC-07)', () => {
  const contaId = novaConta({ max_jogadores_time: 2 });
  // 2 divisoes x 2 = 4 jogadores no maximo
  assert.throws(() => criarCampeonato(db, contaId, {
    nome: 'Pelada Cheia', esporte: 'pelada_epica', times: ['Camisa', 'Sem Camisa'],
    jogos_temporada: 10,
    jogadores_fixos: ['A', 'B', 'C', 'D'], jogadores_suplentes: ['E'],
  }), /Limite de 4 jogadores neste campeonato/);
  assert.ok(criarCampeonato(db, contaId, {
    nome: 'Pelada Ok', esporte: 'pelada_epica', times: ['Camisa', 'Sem Camisa'],
    jogos_temporada: 10, jogadores_fixos: ['A', 'B', 'C', 'D'],
  }).id);
  assert.throws(() => conferirLimiteJogadoresPelada(db, contaId, 5, 2), /Limite de 4 jogadores/);
});

// ---------- migracao (grandfather) ----------

test('migracao: banco antigo ganha as colunas e contas existentes viram padrao', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-mig-limites-'));
  const caminho = join(dir, 'antigo.db');
  const antigo = new DatabaseSync(caminho);
  antigo.exec(`
    CREATE TABLE contas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      senha_hash TEXT NOT NULL,
      criado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO contas (nome, email, senha_hash) VALUES ('Antiga', 'antiga@t.com', 'x');
  `);
  antigo.close();

  const migrado = prepararBanco(caminho);
  const conta = migrado.prepare('SELECT * FROM contas WHERE email = ?').get('antiga@t.com');
  assert.equal(conta.tipo, 'padrao');
  assert.equal(conta.max_campeonatos, null);
  assert.equal(conta.max_times, null);
  assert.equal(conta.max_jogadores_time, null);
  assert.deepEqual(limitesDaConta(migrado, conta.id), {
    tipo: 'padrao', max_campeonatos: 3, max_times: 48, max_jogadores_time: 30,
  });
  // rodar a migracao de novo nao pode quebrar (idempotente)
  migrado.close();
  const denovo = prepararBanco(caminho);
  assert.equal(denovo.prepare('SELECT tipo FROM contas WHERE email = ?').get('antiga@t.com').tipo, 'padrao');
  denovo.close();
  rmSync(dir, { recursive: true, force: true });
});
