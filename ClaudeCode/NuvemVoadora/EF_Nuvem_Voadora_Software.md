# EF — Nuvem Voadora Software
### Especificação Funcional do Sistema de Consolidação (HUB TCG)

- **Versão:** 0.1 (fechada — pontos em aberto resolvidos em 2026-07-06)
- **Data:** 2026-07-06
- **Base:** `Especificacao_HUB_TCG.docx` v1.0 (arquitetura operacional). Este documento
  traduz o fluxo operacional F1–F8 daquele documento em requisitos de software.
- **Escopo desta versão:** o núcleo operacional do HUB — abertura de Ordem de Serviço,
  composição em partes, recebimento com scan, liberação para separação, fila de
  separação, controle de atrasos e conferência de consolidação por scan.

---

## 1. Objetivo e escopo

### 1.1. Objetivo
Especificar funcionalmente o sistema que orquestra o fluxo físico do HUB: da criação
da Ordem de Serviço (OS) quando o cliente escolhe receber via Nuvem Voadora, até a
conferência final das partes que compõem a caixa consolidada enviada ao cliente.

### 1.2. Dentro do escopo (v0.1)
Módulos M1 a M7 (seção 5). São os nove pontos solicitados, mais o mínimo indispensável
para que eles funcionem de ponta a ponta (etiquetagem/código de barras e conferência
de divergências no recebimento).

### 1.3. Fora do escopo (versões futuras — ver seção 8)
Integração automática com a API da Liga, painel do lojista, geração de etiqueta de
envio ao cliente e cálculo de frete, pós-venda/rastreamento ao cliente, relatórios
financeiros. Sinalizados como *backlog* para não bloquear o MVP operacional.

---

## 2. Glossário e convenções

| Termo | Definição |
|-------|-----------|
| **OS** | Ordem de Serviço — registro único de um pedido de cliente a consolidar. |
| **Parte** | Trecho de uma OS sob responsabilidade de **uma** loja. Uma OS tem 1..N partes. |
| **Loja** | Parceiro Liga responsável por uma ou mais partes (em OSs distintas). |
| **Código da parte** | Identificador único e legível por código de barras de cada parte (seção 4). |
| **Janela** | Período em que a loja acumula pedidos antes de enviar ao HUB (7–15 dias). |
| **Escaninho / bin** | Posição física onde as partes de uma OS aguardam consolidação. |
| **SLA da loja** | Prazo-limite acordado para a loja entregar sua parte no HUB. |
| **Operador** | Colaborador do HUB que opera recebimento, separação e despacho. |

Convenção de IDs: **RF** = Requisito Funcional, **RN** = Regra de Negócio,
**RNF** = Requisito Não-Funcional.

---

## 3. Atores e perfis

| Ator | Descrição | Interação principal com o sistema |
|------|-----------|-----------------------------------|
| **Cliente final** | Compra na Liga e opta por receber via Nuvem Voadora. | Indireta: sua escolha no checkout dispara a criação da OS. |
| **Plataforma Liga** | Origem do pedido multi-loja. | Envia (futuro: via API) os dados do pedido e das partes. |
| **Loja parceira** | Responsável por cada parte. | (Futuro) confirma parte e registra envio; hoje é notificada por fora. |
| **Operador de recebimento** | Dá entrada nas partes que chegam ao HUB. | Scan de entrada, conferência, alocação em escaninho. |
| **Operador de separação** | Monta a caixa consolidada. | Scan de conferência de todas as partes da OS. |
| **Supervisor / Gestor** | Monitora fila, atrasos e desempenho. | Consulta filas, painéis de atraso e responsáveis. |

> **Perfis e permissões (definido):** no MVP existem apenas dois perfis — **Operador**
> (acesso pleno ao balcão: recebimento e separação) e **Gestor** (visão de fila, atrasos
> e desempenho). Acesso de lojista/atendimento entra junto com o painel do lojista
> (backlog B2).

---

## 4. Modelo de identificação: código da parte (fundamento dos scans)

Os pontos 2, 3 e 9 dependem de **cada parte carregar um identificador único, impresso
como código de barras**. Sem um padrão fechado, os scans de recebimento e de
consolidação não têm o que ler. Proposta:

### 4.1. Formato proposto do código da parte
```
NV-<ANO><SEQ_OS>-<LETRA_PARTE>
exemplo:  NV-2600042-A
          └┬┘ └──┬──┘ └┬┘
           │     │     └── letra sequencial da parte dentro da OS (A, B, C, …)
           │     └──────── sequência da OS no ano (zero-padded)
           └────────────── prefixo fixo Nuvem Voadora
```
- O **código da OS** é `NV-2600042`. O **código da parte** acrescenta a letra.
- A letra sequencial (A, B, C…) reaproveita a ideia de etiqueta por letra já prevista
  no roadmap do documento base ("cada loja receberá a etiqueta com uma letra atrelada
  à sua parte").
- O código de barras impresso na etiqueta **codifica o código da parte completo**
  (`NV-2600042-A`), de modo que um único scan identifica simultaneamente a **OS** e a
  **parte/loja** — base dos pontos 3 e 8.

### 4.2. Regras de identificação
- **RN-ID-01:** o código da parte é único e imutável durante todo o ciclo da OS.
- **RN-ID-02:** a etiqueta da parte é gerada pelo sistema no momento da composição da
  OS (RF-02). **A própria loja imprime** a etiqueta a partir do código fornecido pelo
  sistema, e a afixa na parte (regra contratual de etiquetagem do doc base). O HUB não
  envia etiquetas físicas às lojas.
- **RN-ID-03:** o scan resolve OS + parte + loja em uma leitura; leitura de código
  inexistente ou de OS já encerrada é rejeitada com mensagem clara.
- **RN-ID-04:** como a impressão é feita na loja, o sistema disponibiliza a etiqueta em
  formato pronto para impressão local (ex.: PDF/PNG com o código de barras) e o padrão
  de etiquetagem é obrigação contratual da loja (SLA).

---

## 5. Requisitos funcionais

Cada módulo abaixo corresponde a um ou mais dos nove pontos solicitados.

### M1 — Abertura da Ordem de Serviço
> Ponto 1: abrir nova OS quando o cliente optar, no site da Liga, por receber via Nuvem Voadora.

- **RF-01.1** — O sistema cria uma OS quando recebe o gatilho de que um cliente escolheu
  a Nuvem Voadora como forma de recebimento em um pedido multi-loja da Liga.
  - **MVP:** o gatilho é um **registro manual** (operador cria a OS a partir dos dados do
    pedido). **Futuro:** integração via API/importação da Liga (seção 8).
- **RF-01.2** — Cada OS recebe um **código único** (seção 4.1) e nasce no estado
  `ABERTA`.
- **RF-01.3** — A OS registra, na criação: código, cliente (id/nome/UF ou CEP de destino),
  data de abertura, **janela de consolidação** e **prazo estimado ao cliente**.
- **RN-01.1** — Uma OS só existe para pedido **multi-loja consolidável**; pedido de loja
  única **não gera OS** (não há o que consolidar; o cliente segue o frete normal da Liga).

### M2 — Composição da OS em partes
> Ponto 2: especificar a quantidade de "partes" (lojas) do pedido e o código de cada parte.

- **RF-02.1** — Na OS, o operador informa **quantas partes** compõem o pedido e, para
  cada parte, a **loja responsável** e a **lista de itens** daquela parte.
- **RF-02.2** — O sistema **gera automaticamente o código de cada parte** (letra
  sequencial A, B, C…, seção 4) e disponibiliza a etiqueta/código de barras em formato
  pronto para **impressão pela loja** (RN-ID-02/04).
- **RF-02.3** — Cada parte nasce no estado `AGUARDANDO` e recebe o **prazo-limite de
  chegada ao HUB**, contado a partir do **fechamento da janela de consolidação da loja**
  (7/15 dias) — refletindo o modelo de acúmulo do doc base, não a data de abertura da OS.
- **RN-02.1** — Nº de partes = nº de lojas distintas do pedido. Uma loja = uma parte por OS.
- **RN-02.2** — A OS não pode ser liberada para separação enquanto houver partes
  `AGUARDANDO` (ver M4/M5).

### M3 — Recebimento com scan de código de barras
> Ponto 3: scan de código de barras na entrada das partes no recebimento.

- **RF-03.1** — No recebimento, o operador **escaneia o código de barras** de cada parte
  que chega ao HUB.
- **RF-03.2** — O scan resolve **OS + parte + loja** e exibe: a qual OS pertence, quais
  itens deveria conter e qual **escaninho/bin** destinar.
- **RF-03.3** — Confirmado o recebimento, a parte passa de `AGUARDANDO` → `RECEBIDA` e
  registra data/hora e operador do scan (trilha de auditoria — RNF).
- **RF-03.4 (divergências)** — O sistema trata leituras excepcionais:
  - Código **inexistente / ilegível** → rejeita e orienta conciliação manual.
  - Parte **sem OS identificável** → encaminha para **quarentena** (cenário do doc base).
  - Parte **avariada** (marcada pelo operador) → estado `RECUSADA`, aciona reposição.
- **RN-03.1** — Uma parte não pode ser recebida duas vezes; segundo scan da mesma parte
  gera alerta (possível duplicidade).

### M4 — Atualização das OS com as partes recebidas
> Ponto 4: atualizar as ordens de serviço com os pacotes já recebidos.

- **RF-04.1** — A cada recebimento (RF-03.3), o sistema atualiza a OS mostrando
  **X de N partes recebidas** e o que ainda falta (por parte/loja).
- **RF-04.2** — O estado da OS é **derivado automaticamente** das partes:
  - alguma parte `AGUARDANDO` → OS permanece `PENDENTE`;
  - todas as partes `RECEBIDA` → OS transita para `LIBERADA_SEPARACAO` (M5).
- **RF-04.3** — Toda mudança de estado da OS é registrada com carimbo de data/hora
  (histórico da OS).

### M5 — Regra de liberação para separação
> Ponto 5: se todas as partes já estão no HUB, liberar para separação; senão, manter "Pendente".

- **RF-05.1** — Quando **todas** as partes de uma OS estão `RECEBIDA`, a OS é
  automaticamente marcada `LIBERADA_SEPARACAO` e entra na fila (M6).
- **RF-05.2** — Enquanto houver **qualquer** parte não recebida, a OS permanece
  `PENDENTE` (e pode estar também `ATRASADA` — M7).
- **RN-05.1** — A liberação é **automática e determinística**: não depende de ação
  manual; é consequência direta do último scan de recebimento que completa a OS.
- **RN-05.2 (despacho parcial):** **fora do escopo do MVP.** A OS só é liberada quando
  **100% das partes** estão `RECEBIDA`. Uma loja em atraso mantém a OS `PENDENTE`/`ATRASADA`
  (M7) até que a parte chegue ou a OS seja resolvida por fora do fluxo automático. Suporte
  a despacho parcial fica no backlog (ver B8, seção 8).

### M6 — Fila de Ordens liberadas para separação
> Ponto 6: fila de ordens liberadas para separação.

- **RF-06.1** — Tela de **fila de separação** listando todas as OSs `LIBERADA_SEPARACAO`,
  ordenadas por prioridade (padrão: mais antiga primeiro / prazo ao cliente mais próximo).
- **RF-06.2** — Cada item da fila mostra: código da OS, cliente/destino, nº de partes,
  escaninho e tempo desde a liberação.
- **RF-06.3** — Ao iniciar a separação, a OS passa a `EM_SEPARACAO` e sai da fila de
  pendentes de separação (evita dois operadores pegarem a mesma OS).

### M7 — Controle de atrasos e responsável
> Ponto 7: identificar OSs atrasadas. Ponto 8: identificar a parte e a loja responsável pelo atraso.

- **RF-07.1** — Uma OS é sinalizada **`ATRASADA`** quando está `PENDENTE` e **pelo menos
  uma parte `AGUARDANDO` ultrapassou seu prazo-limite** (RF-02.3).
- **RF-07.2** — Painel de atrasos listando as OSs atrasadas e, para cada uma, **quais
  partes** estão vencidas e **qual loja** é responsável por cada parte em atraso (ponto 8).
- **RF-07.3** — Métrica por loja: nº e frequência de atrasos, para alimentar o SLA e as
  penalidades contratuais do documento base.
- **RN-07.1** — `ATRASADA` é uma **condição derivada** sobreposta a `PENDENTE`, não um
  estado terminal: assim que a parte atrasada é recebida, o flag some e a regra M5 reavalia.
- **RN-07.2** — Alerta proativo: partes a ≤ 2 dias do prazo aparecem como "em risco"
  antes de virarem atraso.

### M8 — Conferência de consolidação na separação (scan de saída)
> Ponto 9: na separação, scan de todas as partes que entram na caixa consolidada do cliente.

- **RF-08.1** — Durante a separação de uma OS `EM_SEPARACAO`, o operador **escaneia cada
  parte** ao colocá-la na caixa consolidada.
- **RF-08.2** — O sistema valida em tempo real: cada scan deve pertencer **àquela OS**;
  scan de parte de outra OS gera **alerta imediato** (previne trocar cartas entre pedidos).
- **RF-08.3** — A separação só é concluída quando **todas as N partes** da OS foram
  escaneadas para dentro da caixa (contagem N de N). O sistema bloqueia o fechamento
  se faltar alguma.
- **RF-08.4** — Concluída a conferência, a OS transita para `PRONTA_DESPACHO` e as partes
  para `CONSOLIDADA`.
- **RN-08.1** — Este scan de saída é a **dupla-conferência** que fecha o ciclo do código
  de barras: entrou por scan (M3), sai por scan (M8), garantindo que a caixa do cliente
  contém exatamente as partes daquela OS.

---

## 6. Máquina de estados

### 6.1. Estados da OS
```
ABERTA ──(partes compostas, M2)──> PENDENTE
   PENDENTE ──(todas as partes RECEBIDA, M5)──> LIBERADA_SEPARACAO
   PENDENTE ──[condição derivada]──> (ATRASADA)     ← flag, volta a PENDENTE ao receber
LIBERADA_SEPARACAO ──(operador inicia, M6)──> EM_SEPARACAO
EM_SEPARACAO ──(todas as partes escaneadas, M8)──> PRONTA_DESPACHO
PRONTA_DESPACHO ──(despacho ao cliente — fora do escopo v0.1)──> DESPACHADA ──> ENCERRADA
qualquer estado ──> CANCELADA (exceção)
```
`(ATRASADA)` = condição sobreposta, não estado terminal.
Despacho parcial (liberar OS incompleta) está fora do MVP (RN-05.2 / B8).

### 6.2. Estados da Parte
```
AGUARDANDO ──(scan de entrada, M3)──> RECEBIDA ──(scan de saída, M8)──> CONSOLIDADA
AGUARDANDO ──[prazo vencido]──> (ATRASADA)        ← flag na parte, base do ponto 8
RECEBIDA ──(avaria/erro)──> RECUSADA
sem OS ──> QUARENTENA
```

---

## 7. Requisitos não-funcionais (mínimos do MVP)

- **RNF-01 (Scan):** o sistema deve funcionar com **leitor de código de barras físico**
  (que atua como teclado) e/ou câmera; leitura deve dar **feedback imediato** (visual/sonoro)
  de sucesso, erro ou alerta.
- **RNF-02 (Auditoria):** todo scan (entrada e saída) registra **operador, data/hora e
  resultado**. Alinha-se ao ambiente monitorado por câmeras previsto no doc base.
- **RNF-03 (Persistência/estado):** o estado da OS e das partes é a fonte de verdade e
  sobrevive ao fechamento de sessão; nada crítico vive só na tela.
- **RNF-04 (Simplicidade operacional):** telas de recebimento e separação otimizadas para
  uso rápido em balcão (scan-first, poucos cliques).
- **RNF-05 (Concorrência):** duas estações (recebimento e separação) podem operar a mesma
  base sem que uma sobrescreva a outra (M6.3).

---

## 8. Backlog / fora do escopo desta versão

Itens do fluxo F1–F8 do doc base que **não** estão em v0.1, mas o sistema precisará depois:

| # | Item | Fase base |
|---|------|-----------|
| B1 | Integração automática com API/importação da Liga para abrir a OS | F1 |
| B2 | Notificação/roteamento automático às lojas (painel do lojista) | F2 |
| B3 | Lista de expedição (picking list) consolidada por loja/janela | F3 |
| B4 | Registro pela loja do rastreio da caixa loja→HUB e monitoramento | F4 |
| B5 | Geração da etiqueta de envio ao cliente + cálculo/repasse de frete | F7 |
| B6 | Rastreamento ao cliente, encerramento e KPIs (tempo de ciclo etc.) | F8 |
| B7 | Gestão de materiais e mapa de escaninhos/ocupação do estoque | Ops |
| B8 | Despacho parcial de OS incompleta (loja em atraso + cliente autoriza) | F6/exceções |

---

## 9. Pontos em aberto (preciso da sua decisão)

Todos os pontos levantados foram **resolvidos em 2026-07-06**; a v0.1 está fechada.

- **A — Perfis e permissões:** ✅ MVP com dois perfis, **Operador** e **Gestor**.
  Lojista/atendimento no backlog (B2). (seção 3)
- **B — Quem imprime a etiqueta da parte:** ✅ **a loja imprime** a partir do código
  fornecido pelo sistema. (RN-ID-02/04, RF-02.2)
- **C — OS só para multi-loja:** ✅ confirmado — pedido de loja única **não gera OS**.
  (RN-01.1)
- **D — Despacho parcial:** ✅ **fora do MVP** — OS só libera com 100% das partes.
  (RN-05.2, backlog B8)
- **E — Prazo-limite da parte:** ✅ contado a partir do **fechamento da janela da loja**.
  (RF-02.3, M7)

---

## 10. Pontos que você não citou e recomendo incluir já

Além dos nove pontos, estes são **baratos de incluir agora** e evitam retrabalho, porque
são pré-condição dos scans ou tratam exceções que vão acontecer no dia 1:

1. **Etiquetagem / código de barras (seção 4):** é a base dos pontos 2, 3 e 8 — sem um
   padrão de código, os scans não têm o que ler. Incluí como fundamento.
2. **Divergências no recebimento (RF-03.4):** parte sem OS → quarentena, parte avariada →
   recusa. São os cenários de exceção do próprio doc base; sem eles o operador trava.
3. **Alocação em escaninho/bin (RF-03.2):** o recebimento precisa dizer *onde guardar* a
   parte, ou a consolidação (ponto 9) não encontra as partes depois.
4. **Trilha de auditoria dos scans (RNF-02):** quem escaneou o quê e quando — casa com o
   ambiente de câmeras já previsto e protege em disputas com lojas/clientes.
5. **Alerta de troca entre pedidos (RF-08.2):** na separação, impedir que uma parte de
   outra OS entre na caixa errada — é o erro mais caro (cartas trocadas entre clientes).

---

*Documento vivo — revisar a cada decisão da seção 9 e a cada marco do roadmap.*
