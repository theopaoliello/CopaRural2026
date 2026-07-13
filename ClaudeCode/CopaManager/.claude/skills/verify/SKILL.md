---
name: verify
description: Receita para verificar mudanças do Copa Manager no app real (servidor + Edge headless via CDP)
---

# Verificação do Copa Manager

App Node 24 puro (sem build). O servidor serve as telas em `app/public/` e a API em `/api`.

## Subir o servidor

```bash
cd app && PORTA=3210 node server.js   # em background
```

- O banco é criado em `app/data/copamanager.db` (caminho fixo, gitignored). Se `app/data/`
  NÃO existia antes, apague-a ao final para não deixar dados de teste.
- Sem dependências além de `npm install` (express); `node:sqlite` é nativo.

## Dirigir a UI (sem Playwright/Puppeteer na máquina)

Edge headless + CDP com o WebSocket nativo do Node:

```bash
"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new \
  --remote-debugging-port=9333 --user-data-dir=<scratch>/edge-profile \
  --no-first-run --window-size=1000,900 about:blank   # em background
```

Driver: `fetch http://127.0.0.1:9333/json/list` → conectar `new WebSocket(webSocketDebuggerUrl)`
→ comandos `Page.navigate`, `Runtime.evaluate` (com `awaitPromise`/`returnByValue`),
`Page.captureScreenshot`. Exemplo funcional em sessão anterior: `drive.mjs` (scratchpad).

## Fluxos úteis

- **Seed via API no contexto do browser** (o cookie de sessão fica no Edge):
  `POST /api/auth/registrar {nome,email,senha}` → `POST /api/campeonatos
  {nome, formato:'pontos', sortear:false, times:[...]}` → `POST /api/times/:id/jogadores`.
- **Admin**: navegar `/admin`, chamar `telaCampeonato(id, 'jogos')` (função global),
  clicar `button[onclick^="modalResultado"]`. Modal de resultado tem abas
  `#aba-res-simples` / `#aba-res-detalhado` e inputs `#gols-casa`/`#gols-fora` ou `#res-texto`.
- **Página pública** `/c/<slug>`: abre na aba Classificação — clicar o botão "Resultados"
  ANTES de procurar `.abrir-jogo` (os cards de jogo só existem nessa aba).

## Pegadinhas

- Logado, `/` redireciona para `/admin` (fetch em `/api/auth/eu`): antes de testar a tela
  de login, `Network.enable` + `Network.clearBrowserCookies` no CDP.
- E-mail em modo log: sem `BREVO_API_KEY`, o link de confirmação sai no stdout do servidor —
  capture o arquivo de output do processo em background e extraia `verificar.html?token=...`.
- `verificar.html` confirma e redireciona ao `/admin` em ~1,8s — leia `#estado` logo após
  navegar, não depois de esperar.
- Google SSO sem conta real: suba o servidor com `GOOGLE_CLIENT_ID`/`SECRET` falsos e valide
  o 302 para `accounts.google.com` (Location + cookie `oauth_state`) via fetch `redirect:'manual'`.

- Rate limit: login 10/5min e rastreios por IP — evitar loops de login no mesmo run.
- `.aba.ativa` global pega a aba da página, não a do modal — usar os ids do modal.
- **`avisar()` do admin é `alert()`**: no headless o diálogo BLOQUEIA a página (o driver trava
  sem erro, e o alvo fica inutilizável até matar o Edge). Após cada navegação, estubar:
  `window.alert = () => {}; window.confirm = () => true;`.
- `app/data/` fica dentro do OneDrive: apagar a pasta pode ser desfeito pela sincronização
  (o banco de dev antigo volta). Não contar com banco "novo" — criar um campeonato de teste
  e apagá-lo ao final (DELETE /api/campeonatos/:id), deixando o banco em paz.
- Ao final: matar os processos das portas 3210/9333 (`netstat -ano` + `taskkill //F //PID`).
