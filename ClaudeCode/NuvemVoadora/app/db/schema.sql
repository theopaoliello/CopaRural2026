-- Schema do HUB Nuvem Voadora (MVP) — ver Plano_Tecnico secao 4.
-- Idempotente: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS loja (
  id          INTEGER PRIMARY KEY,
  nome        TEXT NOT NULL,
  cidade_uf   TEXT,
  janela_dias INTEGER NOT NULL DEFAULT 15,
  ativo       INTEGER NOT NULL DEFAULT 1,
  criado_em   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ordem_servico (
  id              INTEGER PRIMARY KEY,
  codigo          TEXT NOT NULL UNIQUE,
  cliente_nome    TEXT NOT NULL,
  cliente_uf      TEXT,
  cliente_cep     TEXT,
  status          TEXT NOT NULL,
  escaninho       TEXT,
  janela_fecha_em TEXT,
  prazo_cliente   TEXT,
  aberta_em       TEXT NOT NULL,
  liberada_em     TEXT,
  pronta_em       TEXT,
  atualizado_em   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS parte (
  id             INTEGER PRIMARY KEY,
  os_id          INTEGER NOT NULL REFERENCES ordem_servico(id),
  letra          TEXT NOT NULL,
  codigo_barras  TEXT NOT NULL UNIQUE,
  loja_id        INTEGER NOT NULL REFERENCES loja(id),
  status         TEXT NOT NULL,
  prazo_limite   TEXT,
  recebida_em    TEXT,
  recebida_por   TEXT,
  consolidada_em TEXT,
  UNIQUE(os_id, letra)
);

CREATE TABLE IF NOT EXISTS item (
  id         INTEGER PRIMARY KEY,
  parte_id   INTEGER NOT NULL REFERENCES parte(id),
  descricao  TEXT NOT NULL,
  quantidade INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS evento_scan (
  id          INTEGER PRIMARY KEY,
  tipo        TEXT NOT NULL,
  codigo_lido TEXT NOT NULL,
  os_id       INTEGER,
  parte_id    INTEGER,
  operador    TEXT,
  resultado   TEXT NOT NULL,
  mensagem    TEXT,
  criado_em   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contador_os (
  ano    INTEGER PRIMARY KEY,
  ultimo INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_parte_os     ON parte(os_id);
CREATE INDEX IF NOT EXISTS idx_parte_status ON parte(status);
CREATE INDEX IF NOT EXISTS idx_os_status    ON ordem_servico(status);
