// Conexao e migracao do banco SQLite do Copa Manager.
// Usa o modulo nativo node:sqlite (Node 24+), sem compilacao nativa.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, 'schema.sql');
export const CAMINHO_PADRAO = join(__dirname, '..', 'data', 'copamanager.db');

// Abre (ou cria) o banco. Use ':memory:' para testes.
export function abrirBanco(caminho = CAMINHO_PADRAO) {
  if (caminho !== ':memory:') mkdirSync(dirname(caminho), { recursive: true });
  const db = new DatabaseSync(caminho);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

function tabelaExiste(db, tabela) {
  return !!db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tabela);
}

function colunaExiste(db, tabela, coluna) {
  return db.prepare(`PRAGMA table_info(${tabela})`).all().some((c) => c.name === coluna);
}

// Migracoes aditivas: bancos criados antes destas colunas ganham-nas via ALTER.
function migrarColunas(db) {
  const addSeFaltar = (tabela, ddl) => {
    const coluna = ddl.split(' ')[0];
    if (tabelaExiste(db, tabela) && !colunaExiste(db, tabela, coluna)) {
      db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${ddl}`);
    }
  };
  addSeFaltar('contas', "papel TEXT NOT NULL DEFAULT 'organizador'");
  addSeFaltar('sessoes', 'conta_efetiva_id INTEGER REFERENCES contas(id) ON DELETE SET NULL');
  addSeFaltar('campeonatos', 'regras TEXT');
  // Multiesporte (RN-TC-07): campeonatos criados antes viram Futebol,
  // preservando a modalidade antiga como variante — nada muda para eles.
  addSeFaltar('campeonatos', "esporte TEXT NOT NULL DEFAULT 'futebol'");
  // Esportes de sets (fase 2): formato da partida; a tabela `sets` vem do schema.
  addSeFaltar('campeonatos', 'melhor_de INTEGER');
  // Pelada Epica (fase 4): temporada, presenca opcional, premiacao e rebaixamento.
  addSeFaltar('campeonatos', 'jogos_temporada INTEGER');
  addSeFaltar('campeonatos', 'pontos_presenca INTEGER');
  addSeFaltar('campeonatos', 'premiacao TEXT');
  addSeFaltar('campeonatos', 'premia_artilheiro INTEGER NOT NULL DEFAULT 0');
  addSeFaltar('campeonatos', 'rebaixamento_modo TEXT');
  addSeFaltar('campeonatos', 'rebaixamento_qtd INTEGER');
  // Confirmacao de e-mail chegou depois: contas que ja existiam sao
  // consideradas confirmadas (nao da para pedir confirmacao retroativa).
  const tinhaVerificado = colunaExiste(db, 'contas', 'email_verificado');
  addSeFaltar('contas', 'email_verificado INTEGER NOT NULL DEFAULT 0');
  if (tabelaExiste(db, 'contas') && !tinhaVerificado) {
    db.exec('UPDATE contas SET email_verificado = 1');
  }
  addSeFaltar('contas', 'google_id TEXT');
  addSeFaltar('contas', 'consentimento_em TEXT');
  // Gestao de Contas (fase 1): tipo de conta e overrides de limites por conta.
  // Contas existentes viram 'padrao' pelo DEFAULT; NULL nos overrides = herda
  // o padrao do tipo/global (nenhum backfill necessario).
  addSeFaltar('contas', "tipo TEXT NOT NULL DEFAULT 'padrao'");
  addSeFaltar('contas', 'max_campeonatos INTEGER');
  addSeFaltar('contas', 'max_times INTEGER');
  addSeFaltar('contas', 'max_jogadores_time INTEGER');
}

// Bancos criados antes dos tipos 'gol_contra' (2026-07) ou 'pontos'/'valor'
// (fase 3 multiesporte) tem um CHECK antigo em `eventos`. SQLite nao altera
// CHECK: reconstroi a tabela preservando os dados (valor entra com o DEFAULT 1).
function migrarEventos(db) {
  const tabela = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'eventos'")
    .get();
  if (!tabela || (tabela.sql.includes('gol_contra') && tabela.sql.includes("'pontos'"))) return;
  db.exec('DROP INDEX IF EXISTS idx_eventos_jogo;');
  db.exec('ALTER TABLE eventos RENAME TO eventos_antigo;');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8')); // recria `eventos` com o CHECK novo
  db.exec(`INSERT INTO eventos (id, jogo_id, time_id, jogador_id, tipo, minuto)
           SELECT id, jogo_id, time_id, jogador_id, tipo, minuto FROM eventos_antigo;`);
  db.exec('DROP TABLE eventos_antigo;');
}

// Pelada Epica: `jogadores` ganhou vinculo direto ao campeonato e time_id
// deixou de ser NOT NULL — SQLite nao relaxa NOT NULL, entao reconstroi.
// `jogadores` e REFERENCIADA por eventos/escalacoes: o RENAME moderno
// reescreveria os REFERENCES delas para "jogadores_antigo" — por isso o
// rename roda em modo legacy, com FKs desligadas durante a janela.
function migrarJogadores(db) {
  if (!tabelaExiste(db, 'jogadores') || colunaExiste(db, 'jogadores', 'campeonato_id')) return;
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('PRAGMA legacy_alter_table = ON;');
  db.exec('DROP INDEX IF EXISTS idx_jogadores_time;');
  db.exec('ALTER TABLE jogadores RENAME TO jogadores_antigo;');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8')); // recria `jogadores` no formato novo
  db.exec(`INSERT INTO jogadores (id, time_id, nome, numero)
           SELECT id, time_id, nome, numero FROM jogadores_antigo;`);
  db.exec('DROP TABLE jogadores_antigo;');
  db.exec('PRAGMA legacy_alter_table = OFF;');
  db.exec('PRAGMA foreign_keys = ON;');
}

export function prepararBanco(caminho = CAMINHO_PADRAO) {
  const db = abrirBanco(caminho);
  migrarColunas(db);
  // Jogadores primeiro: as duas migracoes executam o schema.sql, e o indice
  // novo de `jogadores` (campeonato_id) exige a tabela ja reconstruida.
  migrarJogadores(db);
  migrarEventos(db);
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}
