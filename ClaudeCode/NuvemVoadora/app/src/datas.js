// Utilitarios de data. Timestamps guardados em ISO-8601 (UTC).
// Exibicao amigavel em America/Sao_Paulo fica na camada de UI.

export function agoraISO() {
  return new Date().toISOString();
}

export function addDias(dataISOouDate, dias) {
  const d = new Date(dataISOouDate);
  d.setUTCDate(d.getUTCDate() + dias);
  return d;
}

export function addDiasISO(dataISOouDate, dias) {
  return addDias(dataISOouDate, dias).toISOString();
}

// Diferenca inteira em dias (a - b), truncada.
export function diffDias(aISO, bISO) {
  const ms = new Date(aISO).getTime() - new Date(bISO).getTime();
  return Math.trunc(ms / 86400000);
}
