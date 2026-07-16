// Validacao de posse multi-tenant: toda acao administrativa passa por aqui.
// Retorna o recurso apenas se pertencer (direta ou indiretamente) a conta.
import { erroNaoEncontrado } from './erros.js';

// Nao distinguimos "nao existe" de "nao e seu": ambos respondem 404 para
// nao revelar a existencia de dados de outras contas.
const naoAchou = () => erroNaoEncontrado('Campeonato ou recurso nao encontrado nesta conta.');

export function campeonatoDaConta(db, contaId, campeonatoId) {
  const c = db
    .prepare('SELECT * FROM campeonatos WHERE id = ? AND conta_id = ?')
    .get(Number(campeonatoId), contaId);
  if (!c) throw naoAchou();
  return c;
}

export function timeDaConta(db, contaId, timeId) {
  const t = db
    .prepare(
      `SELECT t.* FROM times t
       JOIN campeonatos c ON c.id = t.campeonato_id
       WHERE t.id = ? AND c.conta_id = ?`,
    )
    .get(Number(timeId), contaId);
  if (!t) throw naoAchou();
  return t;
}

export function jogadorDaConta(db, contaId, jogadorId) {
  // O jogador pertence a um time (esportes de clubes) OU direto ao
  // campeonato (Pelada Epica) — a posse vale pelos dois caminhos.
  const j = db
    .prepare(
      `SELECT j.* FROM jogadores j
       LEFT JOIN times t ON t.id = j.time_id
       JOIN campeonatos c ON c.id = COALESCE(j.campeonato_id, t.campeonato_id)
       WHERE j.id = ? AND c.conta_id = ?`,
    )
    .get(Number(jogadorId), contaId);
  if (!j) throw naoAchou();
  return j;
}

export function jogoDaConta(db, contaId, jogoId) {
  const j = db
    .prepare(
      `SELECT j.* FROM jogos j
       JOIN campeonatos c ON c.id = j.campeonato_id
       WHERE j.id = ? AND c.conta_id = ?`,
    )
    .get(Number(jogoId), contaId);
  if (!j) throw naoAchou();
  return j;
}

export function bannerDaConta(db, contaId, bannerId) {
  const b = db
    .prepare(
      `SELECT b.* FROM banners b
       JOIN campeonatos c ON c.id = b.campeonato_id
       WHERE b.id = ? AND c.conta_id = ?`,
    )
    .get(Number(bannerId), contaId);
  if (!b) throw naoAchou();
  return b;
}
