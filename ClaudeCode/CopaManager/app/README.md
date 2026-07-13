# Copa Manager — MVP

Plataforma web para criar e gerenciar campeonatos esportivos amadores, conforme a
**Especificação Funcional v1.0** (`../Pelada_Epica_Especificacao_Funcional_v1.0.docx`,
escrita sob o nome antigo do produto, "Pelada Épica"). Em produção em
[copamanager.com.br](https://copamanager.com.br).

## Rodar

```bash
npm install
npm start                          # http://localhost:3000  (PORTA=3210 npm start para outra porta)
npm test                           # suite completa (node --test)
npm run master -- email@ex.com     # promove uma conta existente a usuario master
```

## Deploy

Guia de produção (Oracle Cloud Free Tier ARM + Caddy + systemd) em
[`deploy/README.md`](deploy/README.md). Em produção, suba com
`COOKIE_SEGURO=1 CONFIA_PROXY=1` (o template `deploy/copamanager.env.example`
já traz esses valores). Backup do banco: `npm run backup`.

## Stack

- Node 24+ / Express 5 (ESM)
- SQLite nativo (`node:sqlite`) — banco em `data/copamanager.db`, sem compilação nativa
- Front-end em HTML/CSS/JS puro (mobile-first), sem framework
- Uploads de imagem (escudo, foto, súmula, banner, logo) em `uploads/`

## Estrutura

| Caminho | Papel |
| --- | --- |
| `db/schema.sql` | Esquema (contas, sessões, campeonatos, grupos, times, jogadores, jogos, eventos, banners) |
| `src/auth.js` | Contas (scrypt), sessões por cookie httpOnly |
| `src/posse.js` | Isolamento multi-tenant: toda ação admin valida a posse do recurso |
| `src/tabela.js` | Round-robin (turno/returno), chaveamento, seeds cruzando grupos |
| `src/classificacao.js` | Tabela derivada dos jogos + desempates configuráveis + últimos 5 |
| `src/campeonatos.js` | Wizard de criação, slug único, geração automática da tabela |
| `src/jogos.js` | Resultados com gols/cartões, propagação de vencedores no mata-mata |
| `src/publico.js` | Dados públicos (classificação, artilharia, chaveamento, banners) |
| `routes/api.js` | API REST (auth, admin, pública) |
| `public/index.html` | Landing + login/registro |
| `public/admin.html` | Painel do organizador |
| `public/c.html` | Página pública (`/c/:slug`) |

## Conceitos-chave

- **Classificação derivada**: pontos, SG, artilharia e as bolinhas dos últimos 5 jogos
  são sempre calculados a partir dos jogos encerrados. Corrigir ou apagar um resultado
  recalcula tudo automaticamente.
- **Mata-mata**: rodadas futuras nascem vazias; o vencedor de cada confronto (agregado,
  com pênaltis em caso de empate) avança automaticamente. Para editar uma fase anterior,
  é preciso apagar antes o resultado da fase seguinte.
- **Multi-tenant**: cada conta só enxerga seus campeonatos; acessos indevidos respondem
  404 sem revelar a existência do recurso. A página pública é somente leitura, por slug.
- **Formatos**: pontos corridos | mata-mata | grupos + mata-mata (o mata é gerado quando
  a fase de grupos termina, cruzando 1ºA×2ºB etc.).
- **Banners**: até 5 por campeonato, com link do anunciante.
- **Resultado por texto**: o placar é calculado automaticamente a partir das seções
  `GOLS TIME CASA/VISITANTE` e `CARTÕES TIME CASA/VISITANTE`. Linhas: `Nome,quantidade`
  (quantidade opcional), `GC,Nome` (gol contra — autor do time adversário), `SR,2`
  (gols sem registro de autor), `A,Nome` / `V,Nome` (cartão amarelo/vermelho).
  Nomes são validados contra o elenco (sem diferenciar maiúsculas/acentos).
- **Jogadores em lote**: `nome,número` por linha (número opcional), via
  `POST /api/times/:id/jogadores/lote`.
- **Confirmação de e-mail**: cadastro novo só entra no painel após clicar no link
  enviado por e-mail (token de uso único, 24h, guardado como hash sha-256). Envio via
  Brevo (`BREVO_API_KEY` + `EMAIL_REMETENTE`); sem a chave, o link sai no log do servidor
  (modo dev). Reenvio em `POST /api/auth/reenviar-verificacao` (com rate limit e sem
  revelar quais e-mails têm conta). Contas anteriores à funcionalidade foram marcadas
  como confirmadas na migração.
- **Login com Google**: fluxo Authorization Code server-side (sem bibliotecas), ativado
  por `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (+ `URL_PUBLICA` para o redirect). Vincula
  pela igualdade de e-mail (exige e-mail verificado no Google) ou cria conta sem senha
  (`senha_hash = 'google'`). O botão só aparece quando `GET /api/auth/config` diz que há credenciais.
- **LGPD**: aceite explícito da Política de Privacidade no cadastro (data em
  `contas.consentimento_em`); política em `public/privacidade.html`; exclusão da própria
  conta em `DELETE /api/auth/minha-conta` (confirma com senha — ou e-mail, em conta Google)
  apagando tudo em cascata.
- **Usuário master**: conta com `papel = 'master'` (promovida via `npm run master`).
  Após logar, escolhe qualquer conta (tenant) e gerencia todo o conteúdo dela como
  se fosse ela — a escolha fica na sessão (`sessoes.conta_efetiva_id`) e só vale
  para quem é master de verdade (validado na conta REAL da sessão, nunca forjável
  pelo cliente). Barra laranja no painel indica o modo e permite trocar/voltar.
