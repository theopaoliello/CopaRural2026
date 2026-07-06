# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project: Nuvem Voadora

Startup em fase de criação que resolve um problema logístico nas plataformas Liga (LigaMagic, LigaPokemon, LigaLorcana, LigaYugioh, etc.): pedidos de cartas TCG são frequentemente divididos entre múltiplas lojas, gerando fretes que somados superam o valor das cartas.

**Modelo de negócio:** HUB de consolidação em São Paulo/SP. Lojas enviam seus "pedaços" de pedido ao HUB em lotes (a cada 7–15 dias). O HUB consolida tudo e envia um único pacote ao cliente final. O cliente paga uma taxa de consolidação (ex: R$ 8–12) + 1 frete único em vez de múltiplos fretes.

**Prova do problema (dados reais, LigaLorcana, Jun/2026):**
- 70 cartas buscadas → 58 encontradas → 10 lojas → R$ 161,11 em fretes para R$ 135,22 em cartas
- Frete consolidado via HUB representaria economia de ~R$ 100–120 para o cliente

**Parceiro estratégico chave:** LIGAMAGIC PORTAL DE COMPRAS LTDA - ME (CNPJ: 18.148.958/0001-90) — controla todas as plataformas Liga. Uma única integração desbloqueia todos os marketplaces.

**Objetivo de integração técnica:** Nuvem Voadora aparece como opção de frete no checkout das plataformas Liga. Quando selecionado, lojas recebem instrução de enviar ao HUB SP.

## Estrutura do Repositório

```
nuvemvoadora/
├── .claude/
│   └── agentes/        # Agentes de IA para automação de processos
└── CLAUDE.md
```

O diretório `.claude/agentes/` é destinado a agentes Claude Code customizados (arquivos `.md`) que automatizam tarefas recorrentes do negócio — ex: análise de pedidos, geração de relatórios, comunicação com lojas.

## Contexto de Desenvolvimento

Este é um projeto em fase zero (pré-código). Trabalho esperado neste repositório:

- **Agentes:** Criar subagentes em `.claude/agentes/` para automatizar processos operacionais do HUB
- **Integrações:** Eventual integração com a API das plataformas Liga para receber pedidos e notificar lojas
- **Operacional:** Ferramentas para gestão de lotes, rastreamento de consolidação, comunicação com clientes

Ao criar agentes ou scripts, priorizar automação do fluxo: recebimento de pedido → notificação às lojas → controle de recebimento no HUB → despacho único ao cliente.
