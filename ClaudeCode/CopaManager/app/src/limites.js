// Limites por conta (EF Gestao de Contas, fase 1): tipos de conta com teto de
// campeonatos simultaneos e limites globais de estrutura (times/jogadores),
// com override por conta definido pelo master. A verificacao e sempre do
// servidor e sempre pela conta DONA do campeonato (RN-GC-08).
import { erroConflito } from './erros.js';

// Tipo -> limite padrao de campeonatos simultaneos (RN-GC-01). Sem billing:
// o master atribui o tipo no painel de contas.
export const TIPOS_CONTA = { padrao: 3, premium: 10, premium_plus: 30 };
export const ROTULOS_TIPO = { padrao: 'Padrão', premium: 'Premium', premium_plus: 'Premium+' };

// Limites globais de estrutura (RN-GC-05), iguais para todos os tipos.
export const MAX_TIMES_PADRAO = 48;
export const MAX_JOGADORES_TIME_PADRAO = 30;

// Limites efetivos da conta: override do master ?? padrao do tipo/global.
export function limitesDaConta(db, contaId) {
  const conta = db
    .prepare('SELECT tipo, max_campeonatos, max_times, max_jogadores_time FROM contas WHERE id = ?')
    .get(contaId) ?? {};
  const tipo = TIPOS_CONTA[conta.tipo] != null ? conta.tipo : 'padrao';
  return {
    tipo,
    max_campeonatos: conta.max_campeonatos ?? TIPOS_CONTA[tipo],
    max_times: conta.max_times ?? MAX_TIMES_PADRAO,
    max_jogadores_time: conta.max_jogadores_time ?? MAX_JOGADORES_TIME_PADRAO,
  };
}

// RN-GC-02/03: conta TODOS os campeonatos da conta (ativos e arquivados).
export function conferirLimiteCampeonatos(db, contaId) {
  const limites = limitesDaConta(db, contaId);
  const usados = db
    .prepare('SELECT COUNT(*) AS n FROM campeonatos WHERE conta_id = ?')
    .get(contaId).n;
  if (usados >= limites.max_campeonatos) {
    throw erroConflito(
      `Sua conta atingiu o limite de ${limites.max_campeonatos} campeonatos simultaneos. `
      + 'Exclua um campeonato que ja terminou ou fale com o suporte para ampliar seu plano.',
    );
  }
  return usados;
}

// RN-GC-06: `total` e o resultado final da operacao (existentes + adicionados)
// — no lote, valida tudo antes de inserir qualquer linha.
export function conferirLimiteTimes(db, contaDonaId, total) {
  const limites = limitesDaConta(db, contaDonaId);
  if (total > limites.max_times) {
    throw erroConflito(`Limite de ${limites.max_times} times por campeonato.`);
  }
}

export function conferirLimiteJogadoresTime(db, contaDonaId, total) {
  const limites = limitesDaConta(db, contaDonaId);
  if (total > limites.max_jogadores_time) {
    throw erroConflito(`Limite de ${limites.max_jogadores_time} jogadores por time.`);
  }
}

// RN-GC-07: na Pelada Epica os jogadores pertencem ao campeonato (times sao
// divisoes sorteadas a cada jogo) — o teto e por campeonato: limite por time
// multiplicado pelo numero de divisoes.
export function conferirLimiteJogadoresPelada(db, contaDonaId, total, numDivisoes) {
  const limites = limitesDaConta(db, contaDonaId);
  const teto = limites.max_jogadores_time * Math.max(1, numDivisoes);
  if (total > teto) {
    throw erroConflito(`Limite de ${teto} jogadores neste campeonato (${limites.max_jogadores_time} por time).`);
  }
}
