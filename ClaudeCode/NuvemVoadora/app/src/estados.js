// Maquina de estados da Ordem de Servico (OS) e da Parte.
// Fonte: EF_Nuvem_Voadora_Software.md secoes 5/6; Plano_Tecnico secao 5.
// Regra de ouro: nenhum status muda fora daqui; transicao invalida lanca erro.

export const OS = Object.freeze({
  ABERTA: 'ABERTA',
  PENDENTE: 'PENDENTE',
  LIBERADA_SEPARACAO: 'LIBERADA_SEPARACAO',
  EM_SEPARACAO: 'EM_SEPARACAO',
  PRONTA_DESPACHO: 'PRONTA_DESPACHO',
  DESPACHADA: 'DESPACHADA',
  ENCERRADA: 'ENCERRADA',
  CANCELADA: 'CANCELADA',
});

export const PARTE = Object.freeze({
  AGUARDANDO: 'AGUARDANDO',
  RECEBIDA: 'RECEBIDA',
  CONSOLIDADA: 'CONSOLIDADA',
  RECUSADA: 'RECUSADA',
  QUARENTENA: 'QUARENTENA',
});

// Transicoes permitidas. Chave = estado atual; valor = destinos validos.
const TRANSICOES_OS = Object.freeze({
  ABERTA: ['PENDENTE', 'CANCELADA'],
  PENDENTE: ['LIBERADA_SEPARACAO', 'CANCELADA'],
  LIBERADA_SEPARACAO: ['EM_SEPARACAO', 'PENDENTE', 'CANCELADA'],
  EM_SEPARACAO: ['PRONTA_DESPACHO', 'CANCELADA'],
  PRONTA_DESPACHO: ['DESPACHADA', 'CANCELADA'],
  DESPACHADA: ['ENCERRADA'],
  ENCERRADA: [],
  CANCELADA: [],
});

const TRANSICOES_PARTE = Object.freeze({
  AGUARDANDO: ['RECEBIDA', 'QUARENTENA', 'RECUSADA'],
  RECEBIDA: ['CONSOLIDADA', 'RECUSADA'],
  CONSOLIDADA: [],
  RECUSADA: ['AGUARDANDO'],   // reposicao: loja reenvia a parte
  QUARENTENA: ['RECEBIDA', 'RECUSADA'], // apos conciliacao manual
});

export class TransicaoInvalida extends Error {
  constructor(entidade, de, para) {
    super(`${entidade}: transicao invalida ${de} -> ${para}`);
    this.name = 'TransicaoInvalida';
    this.entidade = entidade;
    this.de = de;
    this.para = para;
  }
}

export function podeTransicionarOS(de, para) {
  return (TRANSICOES_OS[de] ?? []).includes(para);
}

export function validarTransicaoOS(de, para) {
  if (!podeTransicionarOS(de, para)) throw new TransicaoInvalida('OS', de, para);
  return para;
}

export function podeTransicionarParte(de, para) {
  return (TRANSICOES_PARTE[de] ?? []).includes(para);
}

export function validarTransicaoParte(de, para) {
  if (!podeTransicionarParte(de, para)) throw new TransicaoInvalida('Parte', de, para);
  return para;
}

// Regra de liberacao automatica (EF RF-05 / RN-05.1): OS so libera quando
// TODAS as partes estao RECEBIDA. Funcao pura, testavel sem banco.
export function statusPorCompletude(statusesDasPartes) {
  if (!Array.isArray(statusesDasPartes) || statusesDasPartes.length === 0) {
    return OS.PENDENTE;
  }
  const todasRecebidas = statusesDasPartes.every((s) => s === PARTE.RECEBIDA);
  return todasRecebidas ? OS.LIBERADA_SEPARACAO : OS.PENDENTE;
}

// Atraso derivado (EF RN-07.1): parte ainda AGUARDANDO cujo prazo ja venceu.
// Nao e persistido; e calculado. Funcao pura.
export function parteEstaAtrasada(status, prazoLimite, agora = new Date()) {
  if (status !== PARTE.AGUARDANDO) return false;
  if (!prazoLimite) return false;
  return new Date(prazoLimite).getTime() < new Date(agora).getTime();
}
