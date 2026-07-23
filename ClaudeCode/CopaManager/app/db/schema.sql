-- Esquema do banco Pelada Epica (SQLite).
-- Regra de ouro multi-tenant: todo dado pertence a um campeonato, e todo
-- campeonato pertence a uma conta. O acesso administrativo sempre valida posse.

CREATE TABLE IF NOT EXISTS contas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  -- contas criadas pelo Google nao tem senha: senha_hash = 'google' (sem ':')
  senha_hash TEXT NOT NULL,
  -- master: administra a plataforma e pode gerenciar o conteudo de qualquer conta.
  -- Promova com: npm run master -- email@exemplo.com
  papel TEXT NOT NULL DEFAULT 'organizador' CHECK (papel IN ('organizador', 'master')),
  -- 0 ate o dono clicar no link de confirmacao (ou entrar pelo Google)
  email_verificado INTEGER NOT NULL DEFAULT 0,
  -- `sub` do Google quando a conta esta vinculada ao SSO
  google_id TEXT,
  -- LGPD: quando o titular aceitou a Politica de Privacidade
  consentimento_em TEXT,
  -- Plano da conta (EF Gestao de Contas): define o limite padrao de
  -- campeonatos simultaneos (padrao 3, premium 10, premium_plus 30).
  -- Sem billing: o master atribui. Validacao do valor fica na rota master.
  tipo TEXT NOT NULL DEFAULT 'padrao',
  -- Overrides por conta definidos pelo master; NULL = padrao do tipo/global.
  max_campeonatos INTEGER,
  max_times INTEGER,
  max_jogadores_time INTEGER,
  -- Secao Banners liberada por conta (RN-BA-01/02): contas novas nascem 0;
  -- o master libera. Contas pre-existentes recebem 1 no backfill (grandfather).
  banners_liberados INTEGER NOT NULL DEFAULT 0,
  -- Ultimo login efetivo do titular (gravado ao criar sessao). O master entrar
  -- na conta (modo tenant) NAO cria sessao, entao nao conta aqui. NULL = nunca.
  ultimo_login TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contas_google ON contas(google_id) WHERE google_id IS NOT NULL;

-- Tokens de confirmacao de e-mail. Guardamos apenas o hash (sha-256): um
-- vazamento do banco nao permite confirmar contas alheias.
CREATE TABLE IF NOT EXISTS verificacoes_email (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conta_id INTEGER NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expira_em TEXT NOT NULL,
  usado_em TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_verificacoes_conta ON verificacoes_email(conta_id);

-- Tokens de "esqueci minha senha" (EF Gestao de Contas). Espelho estrutural da
-- verificacao de e-mail: guardamos so o hash (sha-256), validade curta (1h) e
-- uso unico. Um vazamento do banco nao permite redefinir senhas alheias.
CREATE TABLE IF NOT EXISTS recuperacoes_senha (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conta_id INTEGER NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expira_em TEXT NOT NULL,
  usado_em TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_recuperacoes_conta ON recuperacoes_senha(conta_id);

CREATE TABLE IF NOT EXISTS sessoes (
  token TEXT PRIMARY KEY,
  conta_id INTEGER NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  -- master atuando "como" outra conta (tenant selecionado apos o login)
  conta_efetiva_id INTEGER REFERENCES contas(id) ON DELETE SET NULL,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  expira_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campeonatos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conta_id INTEGER NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  temporada TEXT,
  -- chave do catalogo de esportes (src/esportes.js); imutavel apos a criacao
  esporte TEXT NOT NULL DEFAULT 'futebol',
  -- variante do esporte (Society, 3x3, Praia...), apenas informativa
  modalidade TEXT NOT NULL DEFAULT 'Futebol',
  descricao TEXT,
  cor_tema TEXT NOT NULL DEFAULT '#0b5c3f',
  logo TEXT,
  slug TEXT NOT NULL UNIQUE,
  -- pontos = pontos corridos | mata = mata-mata puro | grupos_mata = fase de grupos + mata-mata
  formato TEXT NOT NULL CHECK (formato IN ('pontos', 'mata', 'grupos_mata')),
  num_grupos INTEGER NOT NULL DEFAULT 1,
  ida_volta_grupos INTEGER NOT NULL DEFAULT 0,
  ida_volta_mata INTEGER NOT NULL DEFAULT 0,
  classificados_por_grupo INTEGER NOT NULL DEFAULT 2,
  pontos_vitoria INTEGER NOT NULL DEFAULT 3,
  pontos_empate INTEGER NOT NULL DEFAULT 1,
  -- ordem dos criterios de desempate (JSON), aplicados apos pontos
  criterios_desempate TEXT NOT NULL DEFAULT '["vitorias","saldo","gols_pro","confronto","cartoes"]',
  -- esportes de sets (modelo B): quantos sets fecham a partida (1, 3, 5; 0 = placar livre)
  melhor_de INTEGER,
  -- Pelada Epica (ranking individual)
  jogos_temporada INTEGER,
  pontos_presenca INTEGER,
  premiacao TEXT,
  premia_artilheiro INTEGER NOT NULL DEFAULT 0,
  rebaixamento_modo TEXT,
  rebaixamento_qtd INTEGER,
  -- regras especificas do campeonato, texto livre exibido na pagina publica
  regras TEXT,
  publicado INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo', 'arquivado')),
  -- Encerramento explicito (EF Perfil do Atleta, fase A): NULL = em andamento.
  -- So ao encerrar existe podio/titulo (RN-AT-13); reabrir volta ambos a NULL.
  encerrado_em TEXT,
  -- Podio declarado pelo gestor ao encerrar (RN-AT-13): JSON
  -- {"primeiro": id, "segundo": id|null, "terceiro": id|null} com ids de
  -- times (esportes de clubes) ou jogadores (Pelada Epica).
  podio TEXT,
  -- Conexoes de atleta ligadas/desligadas pelo dono (RN-AT-19): com 0 a copa
  -- nao aparece como conectavel e novas solicitacoes sao barradas.
  aceita_conexoes INTEGER NOT NULL DEFAULT 1,
  -- Disputa de 3o lugar (EF Mata-mata Manual, RN-MM-21): jogo extra no
  -- confronto 1 da ultima rodada, entre os perdedores das semifinais.
  disputa_terceiro INTEGER NOT NULL DEFAULT 0,
  -- Modelo do mata-mata (RN-MM-01): 'padrao' (montagem automatica, potencia
  -- de 2) ou 'manual' (chave com folgas, desenho escolhido pelo gestor).
  mata_modelo TEXT NOT NULL DEFAULT 'padrao',
  -- JSON do modelo manual (RN-MM-04): { desenho: '6A', vagas: 6 }. A estrutura
  -- em si e derivavel dos jogos; isto guarda QUAL desenho foi escolhido.
  mata_chave TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_campeonatos_conta ON campeonatos(conta_id);

CREATE TABLE IF NOT EXISTS grupos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campeonato_id INTEGER NOT NULL REFERENCES campeonatos(id) ON DELETE CASCADE,
  nome TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_grupos_campeonato ON grupos(campeonato_id);

CREATE TABLE IF NOT EXISTS times (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campeonato_id INTEGER NOT NULL REFERENCES campeonatos(id) ON DELETE CASCADE,
  grupo_id INTEGER REFERENCES grupos(id) ON DELETE SET NULL,
  nome TEXT NOT NULL,
  escudo TEXT,
  foto TEXT
);

CREATE INDEX IF NOT EXISTS idx_times_campeonato ON times(campeonato_id);

CREATE TABLE IF NOT EXISTS jogadores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- esportes de clubes: o jogador pertence a um time
  time_id INTEGER REFERENCES times(id) ON DELETE CASCADE,
  -- Pelada Epica: o jogador pertence ao campeonato (time_id fica NULL)
  campeonato_id INTEGER REFERENCES campeonatos(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  numero INTEGER,
  -- Pelada Epica: fixo (rankeado) ou suplente (coringa, fora do ranking)
  tipo TEXT NOT NULL DEFAULT 'fixo' CHECK (tipo IN ('fixo', 'suplente')),
  goleiro INTEGER NOT NULL DEFAULT 0,
  -- inativo: saiu da pelada; historico e pontos preservados (RN-PE-10)
  ativo INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_jogadores_time ON jogadores(time_id);
CREATE INDEX IF NOT EXISTS idx_jogadores_campeonato ON jogadores(campeonato_id);

CREATE TABLE IF NOT EXISTS jogos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campeonato_id INTEGER NOT NULL REFERENCES campeonatos(id) ON DELETE CASCADE,
  fase TEXT NOT NULL DEFAULT 'grupos' CHECK (fase IN ('grupos', 'mata')),
  rodada INTEGER NOT NULL DEFAULT 1,
  -- mata-mata: indice do confronto dentro da rodada e perna (1 ou 2)
  confronto INTEGER,
  perna INTEGER NOT NULL DEFAULT 1,
  grupo_id INTEGER REFERENCES grupos(id) ON DELETE SET NULL,
  time_casa_id INTEGER REFERENCES times(id) ON DELETE CASCADE,
  time_fora_id INTEGER REFERENCES times(id) ON DELETE CASCADE,
  gols_casa INTEGER,
  gols_fora INTEGER,
  penaltis_casa INTEGER,
  penaltis_fora INTEGER,
  data TEXT,
  local TEXT,
  sumula TEXT,
  obs TEXT,
  status TEXT NOT NULL DEFAULT 'agendado' CHECK (status IN ('agendado', 'encerrado')),
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jogos_campeonato ON jogos(campeonato_id);

CREATE TABLE IF NOT EXISTS eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jogo_id INTEGER NOT NULL REFERENCES jogos(id) ON DELETE CASCADE,
  time_id INTEGER NOT NULL REFERENCES times(id) ON DELETE CASCADE,
  jogador_id INTEGER REFERENCES jogadores(id) ON DELETE SET NULL,
  -- gol_contra: gol marcado por jogador ADVERSARIO; time_id e o time beneficiado.
  -- pontos: total de pontos do jogador no jogo (basquete/cestinhas), em `valor`.
  tipo TEXT NOT NULL CHECK (tipo IN ('gol', 'gol_contra', 'amarelo', 'vermelho', 'pontos')),
  minuto INTEGER,
  valor INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_eventos_jogo ON eventos(jogo_id);

-- Parciais dos esportes de sets (modelo B): o placar do jogo em sets fica em
-- jogos.gols_casa/gols_fora (unidade dirigida pelo esporte); aqui, cada set.
CREATE TABLE IF NOT EXISTS sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jogo_id INTEGER NOT NULL REFERENCES jogos(id) ON DELETE CASCADE,
  numero INTEGER NOT NULL,
  pontos_casa INTEGER NOT NULL,
  pontos_fora INTEGER NOT NULL,
  UNIQUE (jogo_id, numero)
);

CREATE INDEX IF NOT EXISTS idx_sets_jogo ON sets(jogo_id);

-- Pelada Epica: quem jogou em qual time em cada jogo (RN-PE-03).
-- A matriz de entrosamento do sorteio e derivada daqui — nunca armazenada.
CREATE TABLE IF NOT EXISTS escalacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jogo_id INTEGER NOT NULL REFERENCES jogos(id) ON DELETE CASCADE,
  jogador_id INTEGER NOT NULL REFERENCES jogadores(id) ON DELETE CASCADE,
  time_id INTEGER NOT NULL REFERENCES times(id) ON DELETE CASCADE,
  UNIQUE (jogo_id, jogador_id)
);

CREATE INDEX IF NOT EXISTS idx_escalacoes_jogo ON escalacoes(jogo_id);

CREATE TABLE IF NOT EXISTS banners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campeonato_id INTEGER NOT NULL REFERENCES campeonatos(id) ON DELETE CASCADE,
  imagem TEXT NOT NULL,
  link TEXT,
  ordem INTEGER NOT NULL DEFAULT 0,
  ativo INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_banners_campeonato ON banners(campeonato_id);

-- Banner Especial (RN-BE): banners globais do master, sem vinculo com conta ou
-- campeonato. Aparecem nas paginas publicas de campeonatos de contas Padrao,
-- acima dos banners do proprio campeonato. Maximo 3 (checado na rota).
CREATE TABLE IF NOT EXISTS banners_globais (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  imagem TEXT NOT NULL,
  link TEXT,
  ordem INTEGER NOT NULL DEFAULT 0,
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Colaboradores (RN-CO): o dono compartilha um campeonato com ate 2 pessoas,
-- cada uma com flags por secao. conta_id NULL = convite pendente (o e-mail
-- ainda nao tem conta confirmada); pendente nao da acesso algum. Ativa quando a
-- pessoa criar/confirmar a conta com aquele e-mail (auth.js). UNIQUE por e-mail
-- no campeonato barra convite repetido (RN-CO-10).
CREATE TABLE IF NOT EXISTS colaboradores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campeonato_id INTEGER NOT NULL REFERENCES campeonatos(id) ON DELETE CASCADE,
  conta_id INTEGER REFERENCES contas(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  pode_jogos INTEGER NOT NULL DEFAULT 0,
  pode_times INTEGER NOT NULL DEFAULT 0,
  pode_regras INTEGER NOT NULL DEFAULT 0,
  pode_sorteio INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (campeonato_id, email)
);

CREATE INDEX IF NOT EXISTS idx_colaboradores_campeonato ON colaboradores(campeonato_id);
CREATE INDEX IF NOT EXISTS idx_colaboradores_conta ON colaboradores(conta_id);

-- Seguidores (RN-SG): vinculo PESSOAL conta<->campeonato, somente leitura. Seguir
-- NAO concede acesso administrativo (RN-SG-02) — apenas adiciona a copa a secao
-- "Seguindo" da home do usuario. O UNIQUE garante idempotencia (RN-SG-01/03) e o
-- ON DELETE CASCADE dos dois lados evita orfaos ao excluir a conta ou o campeonato
-- (RN-SG-08). Contagem de seguidores e sempre derivada, nunca armazenada (RN-SG-09).
CREATE TABLE IF NOT EXISTS seguidores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conta_id INTEGER NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  campeonato_id INTEGER NOT NULL REFERENCES campeonatos(id) ON DELETE CASCADE,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (conta_id, campeonato_id)
);

CREATE INDEX IF NOT EXISTS idx_seguidores_conta ON seguidores(conta_id);
CREATE INDEX IF NOT EXISTS idx_seguidores_campeonato ON seguidores(campeonato_id);

-- Conexoes de atleta (EF Perfil do Atleta, fase B): a conta pede para ser
-- reconhecida como um JOGADOR do campeonato ou, nas copas 2x2/1x1 sem elenco,
-- como integrante de um TIME (RN-AT-04/25 — alvo decidido pela ESTRUTURA).
-- Vinculo VIVO: some em cascata com a copa/jogador/time (o historico congelado
-- da fase D mora em outra tabela). UNIQUE(conta, campeonato) = uma conexao por
-- pessoa por copa (RN-AT-03); re-solicitar apos recusa REUSA a linha.
CREATE TABLE IF NOT EXISTS conexoes_atleta (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conta_id INTEGER NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  campeonato_id INTEGER NOT NULL REFERENCES campeonatos(id) ON DELETE CASCADE,
  alvo_tipo TEXT NOT NULL CHECK (alvo_tipo IN ('jogador', 'time')),
  jogador_id INTEGER REFERENCES jogadores(id) ON DELETE CASCADE,
  time_id INTEGER REFERENCES times(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente', 'aprovada', 'recusada')),
  -- "sou o Theo, camisa 10" — ajuda o dono a reconhecer quem pede
  observacao TEXT,
  decidido_por INTEGER REFERENCES contas(id) ON DELETE SET NULL,
  decidido_em TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (conta_id, campeonato_id)
);

-- Trava anti-fraude estrutural (RN-AT-04): um jogador aprovado pertence a UMA
-- conta. Times ficam de fora do indice de proposito — numa dupla 2x2, dois
-- atletas conectam-se ao MESMO time legitimamente.
CREATE UNIQUE INDEX IF NOT EXISTS idx_conexao_jogador
  ON conexoes_atleta(jogador_id) WHERE status = 'aprovada' AND jogador_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conexoes_conta ON conexoes_atleta(conta_id);
CREATE INDEX IF NOT EXISTS idx_conexoes_campeonato ON conexoes_atleta(campeonato_id);

-- Historico congelado do atleta (EF Perfil do Atleta, fase D): snapshot das
-- estatisticas de uma copa, gravado ao ENCERRAR (RN-AT-08) e antes de EXCLUIR
-- (RN-AT-09). Desnormalizada DE PROPOSITO (RN-AT-11): repete nomes e rotulos
-- para continuar legivel depois que a copa (e tudo dela) for apagada — e a
-- unica tabela do sistema que existe para sobreviver a propria origem.
-- campeonato_id e referencia FRACA (SET NULL): a copa some, os numeros ficam.
-- Sem colunas de cartao: decisao de produto (RN-AT-14).
CREATE TABLE IF NOT EXISTS atleta_estatisticas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conta_id INTEGER NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  campeonato_id INTEGER REFERENCES campeonatos(id) ON DELETE SET NULL,
  campeonato_nome TEXT NOT NULL,
  esporte TEXT NOT NULL,
  modalidade TEXT,
  temporada TEXT,
  time_nome TEXT,
  -- NULL nas conexoes de time (2x2/1x1): a exibicao usa time_nome
  jogador_nome TEXT,
  -- ano de referencia da copa para o filtro do painel (titulo > mais jogos)
  ano INTEGER,
  periodo_inicio TEXT,
  periodo_fim TEXT,
  jogos INTEGER NOT NULL DEFAULT 0,
  vitorias INTEGER NOT NULL DEFAULT 0,
  empates INTEGER NOT NULL DEFAULT 0,
  derrotas INTEGER NOT NULL DEFAULT 0,
  gols INTEGER NOT NULL DEFAULT 0,
  pontos INTEGER NOT NULL DEFAULT 0,
  sets_vencidos INTEGER NOT NULL DEFAULT 0,
  sets_perdidos INTEGER NOT NULL DEFAULT 0,
  colocacao INTEGER,
  congelado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Enquanto a copa existe, ha no maximo UM snapshot por conta por copa (o
-- congelamento regrava). Copas ja apagadas (campeonato_id NULL) ficam fora do
-- indice: sao linhas historicas independentes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_congelado_conta_camp
  ON atleta_estatisticas(conta_id, campeonato_id) WHERE campeonato_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_congelado_conta ON atleta_estatisticas(conta_id);
