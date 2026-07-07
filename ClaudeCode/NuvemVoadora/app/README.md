# Nuvem Voadora — Sistema do HUB (MVP)

Web app **local** para operar o HUB de consolidação: abrir Ordens de Serviço,
receber as partes por scan de código de barras, liberar automaticamente para
separação, conferir a consolidação por scan, despachar e acompanhar atrasos.

Três visões:
- **Operação** (HUB): painel, recebimento, separação, despacho, atrasos, auditoria,
  e a área **Gerencial** (`/gerencial.html`) com dashboards e relatórios `.xlsx`.
- **Portal da Loja** (`/portal.html`): a loja entra com seu código de acesso e vê
  só os pacotes dela — prazos, atrasos e impressão de etiquetas.
- **Rastreio do Cliente** (`/rastreio.html`): página pública; o cliente consulta o
  código do pedido (`NV-...`) e acompanha o progresso em 5 etapas.

Baseado em `../EF_Nuvem_Voadora_Software.md` (o quê) e `../Plano_Tecnico_Nuvem_Voadora.md` (como).

## Requisitos
- **Node.js 24+** (usa o SQLite nativo `node:sqlite`, sem compilação).

## Rodar
```bash
cd app
npm install      # instala Express e JsBarcode
npm start        # sobe em http://localhost:3000
```
Para mudar a porta: `PORTA=8080 npm start`.

### Rodar em rede (estações no HUB)
As estações (recebimento, separação) e o Gestor acessam pelo IP da máquina
servidora: `http://<ip-do-hub>:3000`. O leitor de código de barras USB funciona
como teclado — basta focar o campo de scan e ler a etiqueta (ele "digita" + Enter).

## Testes
```bash
npm test         # node:test — máquina de estados, códigos, recebimento, separação, atrasos
```

## Telas
| Página | Uso |
|--------|-----|
| `/` | Painel: métricas por estado + lista de OSs com filtro |
| `/nova-os.html` | Abrir OS e gerar etiquetas das partes |
| `/etiqueta.html?codigo=NV-...-A` | Etiqueta com código de barras (a **loja** imprime) |
| `/recebimento.html` | Estação de recebimento (scan de entrada) |
| `/separacao.html` | Fila de OSs liberadas |
| `/separar.html?codigo=NV-...` | Estação de separação (scan de conferência) |
| `/gerencial.html` | **Gerencial**: KPIs, dashboards e download de relatórios `.xlsx` |
| `/atrasos.html` | Painel do Gestor: OSs atrasadas + loja responsável |
| `/auditoria.html` | Histórico de todos os scans |
| `/lojas.html` | Cadastro de lojas parceiras + código de acesso ao portal |
| `/os.html?codigo=NV-...` | Detalhe da OS + ações de despacho/encerramento |
| `/portal.html` | **Portal da Loja** — login por código de acesso (`LJ-...`) |
| `/rastreio.html` | **Rastreio público do cliente** — busca por código `NV-...` |

## Gerencial (dashboards + relatórios)
Indicadores em `/gerencial.html`: ordens por status, finalizadas nos últimos
20 dias (em dia × com atraso), partes a receber por loja, top lojas por mês e
KPIs (ativas, atrasadas, inventário, a receber, lead time). Todo gráfico tem
tooltip e alternância **Ver tabela** (acessibilidade).

Relatórios `.xlsx` (gerados sem dependências, em `src/xlsx.js`):

| Endpoint | Conteúdo |
|----------|----------|
| `/api/relatorios/inventario.xlsx` | Inventário físico no HUB (partes recebidas/consolidadas, escaninho, dias em estoque) |
| `/api/relatorios/partes-a-receber.xlsx` | Tudo que as lojas ainda devem enviar, com prazo e situação |
| `/api/relatorios/ordens.xlsx` | Todas as OSs com datas de cada etapa e lead time |
| `/api/relatorios/atrasos-lojas.xlsx` | SLA das lojas: resumo por loja + detalhe (2 abas) |

## Portal da Loja e Rastreio
- Cada loja recebe um **código de acesso** (`LJ-` + 10 hex), gerado automaticamente
  no cadastro (e por migração para lojas existentes). Ele aparece em `/lojas.html`
  — envie à loja por canal seguro. A API autentica pelo header `x-loja-token`.
- O **rastreio do cliente** é público e **sanitizado**: mostra só primeiro nome,
  etapas amigáveis e situação de cada pacote — sem CEP, escaninho ou operadores.
  Aceita código da OS (`NV-2600001`) ou de uma parte (`NV-2600001-A`).
- **Despacho** (na tela da OS, quando `PRONTA_DESPACHO`): registra o código de
  rastreio da transportadora, que passa a aparecer no rastreio do cliente.

## Fluxo operacional
1. **Abrir OS** (`/nova-os.html`) — informa cliente e as partes (loja + itens). O
   sistema gera o código `NV-<ano><seq>-<letra>` de cada parte e as etiquetas.
2. **Loja imprime** a etiqueta e envia a parte ao HUB dentro da janela.
3. **Recebimento** (`/recebimento.html`) — escaneia cada parte que chega. Quando
   **todas** chegam, a OS é liberada para separação **automaticamente**.
4. **Separação** (`/separacao.html` → `/separar.html`) — escaneia cada parte para
   dentro da caixa consolidada. Só fecha com 100% das partes conferidas.
5. **Despacho** (`/os.html`) — com a caixa pronta, registra o rastreio da
   transportadora e marca DESPACHADA; depois ENCERRADA na confirmação de entrega.
6. **Atrasos** (`/atrasos.html`) — o Gestor vê o que atrasou e qual loja é responsável.

## Dados e backup
- Tudo vive em **um arquivo**: `app/data/hub.db` (SQLite). Não versionado (`.gitignore`).
- **Backup** = copiar `hub.db` (com o servidor parado, ou incluindo `hub.db-wal`).
  Recomenda-se uma cópia diária.
- Para começar do zero: pare o servidor e apague `data/hub.db*`. Na próxima subida,
  o schema é recriado e 10 lojas de exemplo são semeadas.

## Estrutura
```
app/
├── server.js            # bootstrap Express
├── db/                  # schema.sql, db.js (conexão/migração), seed.js
├── src/                 # domínio: estados, codigos, os, recebimento, separacao, atrasos
├── routes/api.js        # endpoints REST
├── public/              # telas (HTML/CSS/JS) + vendor/jsbarcode
└── test/                # node:test
```

## Fora do MVP (backlog)
Integração com a API da Liga, etiqueta/frete ao cliente, autenticação da
operação do HUB, despacho parcial, notificações (e-mail/WhatsApp) à loja e ao
cliente. Ver a EF (seção 8).
