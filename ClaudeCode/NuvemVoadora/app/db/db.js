// Conexao, migracao e utilitarios de sequencia do banco SQLite.
// Usa o modulo nativo node:sqlite (Node 24+), sem compilacao nativa.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, 'schema.sql');
export const CAMINHO_PADRAO = join(__dirname, '..', 'data', 'hub.db');

// Abre (ou cria) o banco. Use ':memory:' para testes.
export function abrirBanco(caminho = CAMINHO_PADRAO) {
  if (caminho !== ':memory:') mkdirSync(dirname(caminho), { recursive: true });
  const db = new DatabaseSync(caminho);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

// Cria as tabelas (idempotente).
export function migrar(db) {
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}

// Incrementa e devolve a sequencia da OS do ano. NAO gerencia transacao:
// deve ser chamada dentro de uma transacao ja aberta (ex.: criarOS).
export function incrementarSeqOS(db, ano) {
  const linha = db.prepare('SELECT ultimo FROM contador_os WHERE ano = ?').get(ano);
  let prox;
  if (!linha) {
    prox = 1;
    db.prepare('INSERT INTO contador_os (ano, ultimo) VALUES (?, ?)').run(ano, prox);
  } else {
    prox = linha.ultimo + 1;
    db.prepare('UPDATE contador_os SET ultimo = ? WHERE ano = ?').run(prox, ano);
  }
  return prox;
}

// Versao atomica autonoma (abre a propria transacao).
export function proximaSeqOS(db, ano) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const prox = incrementarSeqOS(db, ano);
    db.exec('COMMIT');
    return prox;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Prepara um banco pronto para uso (abre + migra).
export function prepararBanco(caminho = CAMINHO_PADRAO) {
  return migrar(abrirBanco(caminho));
}
