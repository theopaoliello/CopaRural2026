# Plano Técnico — Nuvem Voadora Software (MVP)
### Arquitetura de implementação do sistema do HUB

- **Versão:** 0.1
- **Data:** 2026-07-06
- **Base:** `EF_Nuvem_Voadora_Software.md` v0.1 (requisitos M1–M8). Este documento define
  **como** construir aqueles requisitos.
- **Decisões travadas:** web app **local** (Node + SQLite) rodando numa máquina do HUB;
  duas estações (recebimento e separação) + acesso do Gestor pela rede local.

---

## 1. Princípios de projeto

1. **Scan-first:** as telas de balcão são operadas quase só pelo leitor de código de
   barras (que se comporta como teclado). Foco sempre no campo de scan; feedback imediato.
2. **Estado derivado, não digitado:** liberação para separação e condição de atraso são
   **calculadas** a partir das partes, nunca marcadas à mão (EF: RN-05.1, RN-07.1).
3. **Arquivo único de verdade:** todo o estado vive num banco SQLite (`hub.db`). Backup =
   copiar um arquivo.
4. **Zero build, poucas dependências:** sem bundler, sem TypeScript, sem framework de UI.
   JavaScript puro (ESM) + HTML/CSS servidos estáticos. Facilita manter e rodar offline.
5. **Auditável:** todo scan (entrada e saída) grava um evento com operador, hora e
   resultado (EF: RNF-02).

---

## 2. Stack

| Camada | Escolha | Porquê |
|--------|---------|--------|
| Runtime | **Node.js 24** | Já instalado; traz SQLite nativo (`node:sqlite`), sem compilar. |
| Banco | **SQLite** via `node:sqlite` | Um arquivo, multiprocesso local, transacional. Fallback: `better-sqlite3`. |
| HTTP | **Express** (1 dependência) | Rotas simples e conhecidas; sobe em minutos. |
| UI | HTML + CSS + **JS vanilla** (fetch) | Sem bundler; roda em qualquer navegador da rede. |
| Código de barras | **JsBarcode** (vendorizado local) | Gera Code128 na etiqueta; funciona offline. |
| Testes | **`node:test`** nativo | Testar a máquina de estados sem dependência extra. |

> **Nota SQLite:** `node:sqlite` é a via sem compilação nativa (importante no Windows).
> Se a API embutida trouxer atrito, troca-se por `better-sqlite3` (mesma semântica
> síncrona) sem mudar a modelagem.

---

## 3. Topologia

```
 [Estação Recebimento] ─┐
 [Estação Separação]  ──┼──(HTTP na rede local :3000)──> [PC-servidor do HUB]
 [Gestor: PC/celular] ──┘                                 Node + Express + hub.db
```
- Um processo Node serve API + páginas. As estações são navegadores apontando para
  `http://<ip-do-hub>:3000`.
- Sem internet obrigatória. Sem custo mensal.

---

## 4. Modelo de dados (SQLite)

Enumerações como texto (legível no banco). Timestamps em ISO-8601 UTC; exibição em
`America/Sao_Paulo`.

```sql
-- Loja parceira
CREATE TABLE loja (
  id          INTEGER PRIMARY KEY,
  nome        TEXT NOT NULL,
  cidade_uf   TEXT,
  janela_dias INTEGER NOT NULL DEFAULT 15,   -- 7 ou 15 (EF: janela por loja)
  ativo       INTEGER NOT NULL DEFAULT 1,
  criado_em   TEXT NOT NULL
);

-- Ordem de Serviço (pedido consolidável do cliente)
CREATE TABLE ordem_servico (
  id             INTEGER PRIMARY KEY,        -- sequência interna
  codigo         TEXT NOT NULL UNIQUE,       -- "NV-2600042" (seção 6)
  cliente_nome   TEXT NOT NULL,
  cliente_uf     TEXT,
  cliente_cep    TEXT,
  status         TEXT NOT NULL,              -- ver estados da OS (seção 5)
  escaninho      TEXT,                       -- posição física atribuída
  janela_fecha_em TEXT,                      -- fechamento da janela (base do prazo, EF RF-02.3)
  prazo_cliente  TEXT,                       -- prazo estimado ao cliente
  aberta_em      TEXT NOT NULL,
  liberada_em    TEXT,
  pronta_em      TEXT,
  atualizado_em  TEXT NOT NULL
);

-- Parte: trecho da OS sob responsabilidade de UMA loja
CREATE TABLE parte (
  id            INTEGER PRIMARY KEY,
  os_id         INTEGER NOT NULL REFERENCES ordem_servico(id),
  letra         TEXT NOT NULL,               -- A, B, C...
  codigo_barras TEXT NOT NULL UNIQUE,        -- "NV-2600042-A"
  loja_id       INTEGER NOT NULL REFERENCES loja(id),
  status        TEXT NOT NULL,               -- AGUARDANDO|RECEBIDA|CONSOLIDADA|RECUSADA|QUARENTENA
  prazo_limite  TEXT,                        -- derivado da janela da loja
  recebida_em   TEXT,
  recebida_por  TEXT,
  consolidada_em TEXT,
  UNIQUE(os_id, letra)
);

-- Itens de cada parte (conteúdo esperado; conferência de contagem)
CREATE TABLE item (
  id         INTEGER PRIMARY KEY,
  parte_id   INTEGER NOT NULL REFERENCES parte(id),
  descricao  TEXT NOT NULL,
  quantidade INTEGER NOT NULL DEFAULT 1
);

-- Trilha de auditoria de TODOS os scans (EF: RNF-02)
CREATE TABLE evento_scan (
  id         INTEGER PRIMARY KEY,
  tipo       TEXT NOT NULL,                  -- ENTRADA | SAIDA
  codigo_lido TEXT NOT NULL,
  os_id      INTEGER,
  parte_id   INTEGER,
  operador   TEXT,
  resultado  TEXT NOT NULL,                  -- OK|ERRO|ALERTA|DUPLICADO|QUARENTENA
  mensagem   TEXT,
  criado_em  TEXT NOT NULL
);

-- Sequência do código da OS por ano
CREATE TABLE contador_os (
  ano     INTEGER PRIMARY KEY,
  ultimo  INTEGER NOT NULL
);
```

**Notas de modelagem**
- `atraso` **não é coluna** — é derivado em consulta (parte `AGUARDANDO` com
  `prazo_limite < agora`). Assim que a parte chega, o atraso some sozinho (EF: RN-07.1).
- `item` é opcional na v0.1 para o cálculo de savings, mas necessário para a picking list
  futura e para conferência de contagem; incluído desde já para não remodelar depois.

---

## 5. Máquina de estados em código

Módulo `estados.js` centraliza constantes e transições válidas. Nada muda status fora daqui.

```
OS:    ABERTA → PENDENTE → LIBERADA_SEPARACAO → EM_SEPARACAO → PRONTA_DESPACHO
                    │
                    └─(derivado) ATRASADA   [flag, não persistido]
Parte: AGUARDANDO → RECEBIDA → CONSOLIDADA
                 └─→ RECUSADA / QUARENTENA (exceção)
```

Funções de domínio (puras onde possível, recebendo a conexão do DB):

| Função | Requisito | Regra central |
|--------|-----------|---------------|
| `criarOS(dados)` | RF-01, RF-02 | Gera código, cria OS `ABERTA`→`PENDENTE`, cria partes `AGUARDANDO`, calcula `prazo_limite`. |
| `registrarRecebimento(codigo, operador)` | RF-03, RF-04 | Resolve parte pelo código; valida; marca `RECEBIDA`; grava evento; chama `reavaliarOS`. |
| `reavaliarOS(osId)` | RF-05 | Se **todas** as partes `RECEBIDA` → OS `LIBERADA_SEPARACAO`; senão `PENDENTE`. Idempotente. |
| `iniciarSeparacao(osId)` | RF-06.3 | `LIBERADA_SEPARACAO` → `EM_SEPARACAO`; trava contra dois operadores. |
| `scanConsolidacao(osId, codigo)` | RF-08.1/2 | Valida que o código é uma parte **desta** OS e está `RECEBIDA`; marca `CONSOLIDADA`. Alerta se for de outra OS. |
| `finalizarSeparacao(osId)` | RF-08.3/4 | Só conclui se **N de N** partes `CONSOLIDADA`; então OS `PRONTA_DESPACHO`. |
| `osAtrasadas()` | RF-07 | Consulta OSs `PENDENTE` com alguma parte vencida; retorna parte + loja responsável. |

**Regra de ouro:** transições ilegais lançam erro nomeado e viram evento `ERRO` — nunca
alteram o banco silenciosamente.

---

## 6. Código da parte (geração e leitura)

Formato da EF (seção 4): `NV-<ANO><SEQ>-<LETRA>`, ex. `NV-2600042-A`.

- `ANO` = 2 dígitos (26). `SEQ` = 5 dígitos zero-padded, incrementado por ano via
  `contador_os` numa transação.
- Código da OS = `NV-2600042`; código da parte acrescenta a letra sequencial.
- O barcode impresso codifica o código **completo da parte** (Code128) — um scan resolve
  OS + parte + loja.
- `codigos.js`: `gerarCodigoOS(ano, conn)`, `codigoParte(codigoOS, letra)`,
  `parse(codigo) → {codigoOS, letra}`.

---

## 7. API (REST/JSON) e telas

### 7.1. Endpoints
| Método | Rota | Requisito |
|--------|------|-----------|
| POST | `/api/os` | Criar OS + partes (RF-01/02) |
| GET | `/api/os/:codigo` | Detalhe e completude (RF-04) |
| GET | `/api/os?status=` | Listagens |
| POST | `/api/recebimento/scan` | Scan de entrada (RF-03/04/05) |
| GET | `/api/fila-separacao` | Fila de OS liberadas (RF-06) |
| POST | `/api/separacao/:codigo/iniciar` | (RF-06.3) |
| POST | `/api/separacao/:codigo/scan` | Scan de conferência de saída (RF-08) |
| POST | `/api/separacao/:codigo/finalizar` | Fechar caixa (RF-08.3/4) |
| GET | `/api/atrasos` | Painel de atrasos + responsável (RF-07) |
| GET/POST | `/api/lojas` | Cadastro de lojas |
| GET | `/api/parte/:codigo/etiqueta` | Página de etiqueta com barcode p/ impressão |

### 7.2. Telas (páginas estáticas + fetch)
| Página | Papel | Foco |
|--------|-------|------|
| `/` | Dashboard | Contadores: pendentes, na fila, atrasadas, prontas. |
| `/os/nova` | Abrir OS | Form: cliente, janela, N partes (loja + itens). Gera etiquetas. |
| `/os/:codigo` | Detalhe da OS | Status, partes X/N, escaninho, links de etiqueta. |
| `/recebimento` | **Estação recebimento** | Campo de scan sempre focado; mostra OS/parte, o que falta, alertas. |
| `/separacao` | Fila | Lista de OS liberadas; abrir para separar. |
| `/separacao/:codigo` | **Estação separação** | Scan de cada parte na caixa; trava fechar se faltar. |
| `/atrasos` | Painel do Gestor | OS atrasadas, parte e **loja responsável**, dias de atraso. |
| `/lojas` | Cadastro | Lojas e janela (7/15 dias). |

Perfis (EF: Operador / Gestor) no MVP: separação por página, sem login rígido; um
seletor/identificação simples de operador para carimbar os eventos de scan.

---

## 8. Estrutura de pastas

```
nuvemvoadora/
├── EF_Nuvem_Voadora_Software.md        # requisitos (fonte de verdade do "o quê")
├── Plano_Tecnico_Nuvem_Voadora.md      # este documento
└── app/
    ├── package.json
    ├── server.js                       # bootstrap Express
    ├── db/
    │   ├── schema.sql
    │   └── db.js                        # conexão + migração + seed
    ├── src/
    │   ├── estados.js                   # constantes + transições
    │   ├── codigos.js                   # gerar/parsear NV-...
    │   ├── os.js                        # criarOS, detalhe
    │   ├── recebimento.js               # registrarRecebimento, reavaliarOS
    │   ├── separacao.js                 # fila, scan saída, finalizar
    │   └── atrasos.js                   # consultas derivadas
    ├── routes/
    │   └── api.js
    ├── public/
    │   ├── *.html  app.js  styles.css
    │   └── vendor/jsbarcode.min.js
    ├── test/
    │   └── estados.test.js              # node:test da máquina de estados
    └── data/
        └── hub.db                       # gitignored
```

---

## 9. Decisões técnicas pontuais

- **Entrada do scanner:** leitor USB = teclado que "digita" o código + Enter. A tela de
  recebimento escuta o submit e chama a API. Sem driver especial.
- **Concorrência:** SQLite em WAL; operações de estado dentro de transação. `iniciarSeparacao`
  usa update condicional (`WHERE status='LIBERADA_SEPARACAO'`) para evitar corrida.
- **Fuso/prazo:** `prazo_limite` calculado a partir de `janela_fecha_em` + tolerância;
  comparação de atraso feita contra "agora" em `America/Sao_Paulo`.
- **Etiqueta:** página HTML de impressão com JsBarcode; a **loja imprime** (EF: RN-ID-02).
- **Sem despacho parcial** no MVP (EF: RN-05.2): não há caminho de liberar OS incompleta.

---

## 10. Sequência de construção

| Passo | Entrega | Requisitos | Verificação |
|-------|---------|-----------|-------------|
| **S1 — Fundação** | Projeto Node, schema, `estados.js`, `codigos.js` + testes | base | `node --test` verde na máquina de estados. |
| **S2 — Abrir OS** | Criar OS + partes + geração de etiquetas | M1, M2 | Criar OS de 3 lojas; ver 3 etiquetas com barcode. |
| **S3 — Recebimento** | Scan de entrada, atualização e liberação automática | M3, M4, M5 | Escanear as 3 partes → OS vira `LIBERADA_SEPARACAO` sozinha. |
| **S4 — Separação** | Fila + scan de conferência + fechar caixa | M6, M8 | Fila mostra a OS; escanear 3/3 libera fechar; 2/3 bloqueia. |
| **S5 — Atrasos** | Painel de atrasos com loja responsável | M7 | Parte vencida aparece com a loja culpada. |
| **S6 — Acabamento** | Dashboard, auditoria visível, cadastro de lojas | RNF | Contadores batem; eventos de scan registrados. |

Cada passo é pequeno, roda e é verificável de ponta a ponta antes do próximo.

---

## 11. Não-metas (v0.1) e riscos

**Não-metas:** integração com API da Liga, painel do lojista, etiqueta/frete ao cliente,
rastreamento pós-venda, autenticação robusta, multiusuário em nuvem. (Backlog da EF.)

**Riscos e mitigação**
- *`node:sqlite` experimental* → fallback `better-sqlite3` (mesma modelagem).
- *Máquina do HUB é ponto único* → rotina de backup do `hub.db` (copiar arquivo/dia).
- *Leitor de barras inconsistente* → validar cedo (S1/S3) com o leitor real do HUB.

---

*Documento vivo — evolui junto com a EF a cada passo do roadmap.*
