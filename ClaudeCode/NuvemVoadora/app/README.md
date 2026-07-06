# Nuvem Voadora — Sistema do HUB (MVP)

Web app **local** para operar o HUB de consolidação: abrir Ordens de Serviço,
receber as partes por scan de código de barras, liberar automaticamente para
separação, conferir a consolidação por scan e acompanhar atrasos.

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
| `/atrasos.html` | Painel do Gestor: OSs atrasadas + loja responsável |
| `/auditoria.html` | Histórico de todos os scans |
| `/lojas.html` | Cadastro de lojas parceiras |

## Fluxo operacional
1. **Abrir OS** (`/nova-os.html`) — informa cliente e as partes (loja + itens). O
   sistema gera o código `NV-<ano><seq>-<letra>` de cada parte e as etiquetas.
2. **Loja imprime** a etiqueta e envia a parte ao HUB dentro da janela.
3. **Recebimento** (`/recebimento.html`) — escaneia cada parte que chega. Quando
   **todas** chegam, a OS é liberada para separação **automaticamente**.
4. **Separação** (`/separacao.html` → `/separar.html`) — escaneia cada parte para
   dentro da caixa consolidada. Só fecha com 100% das partes conferidas.
5. **Atrasos** (`/atrasos.html`) — o Gestor vê o que atrasou e qual loja é responsável.

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
Integração com a API da Liga, painel do lojista, etiqueta/frete ao cliente,
rastreamento pós-venda, autenticação, despacho parcial. Ver a EF (seção 8).
