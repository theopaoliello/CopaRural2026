// Validacao de posse multi-tenant: toda acao administrativa passa por aqui.
// Retorna o recurso apenas se pertencer (direta ou indiretamente) a conta.
import { erroNaoEncontrado, erroProibido } from './erros.js';

// Nao distinguimos "nao existe" de "nao e seu": ambos respondem 404 para
// nao revelar a existencia de dados de outras contas.
const naoAchou = () => erroNaoEncontrado('Campeonato ou recurso nao encontrado nesta conta.');

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

// ---------- acesso de colaborador (Gestao de Contas fase 4, RN-CO) ----------
// Caminho PARALELO ao de posse acima (que fica intocado): alem do dono, um
// colaborador ATIVO acessa as secoes marcadas nas suas flags. Sem vinculo
// nenhum: 404 (anti-enumeracao, RN-CO-06). Com vinculo mas sem a flag: 403.

export const FLAG_DA_SECAO = {
  jogos: 'pode_jogos', times: 'pode_times', regras: 'pode_regras', sorteio: 'pode_sorteio',
};

const semAcessoSecao = () => erroProibido('Voce nao tem acesso a esta secao.');

// Resolve o vinculo da conta com o campeonato: 'dono', o registro do colaborador
// ativo, ou null. Convite pendente (conta_id NULL no vinculo) nunca casa aqui.
export function vinculoDoCampeonato(db, contaId, campeonato) {
  if (!campeonato) return { tipo: null };
  if (campeonato.conta_id === contaId) return { tipo: 'dono' };
  const col = db
    .prepare('SELECT * FROM colaboradores WHERE campeonato_id = ? AND conta_id = ?')
    .get(campeonato.id, contaId);
  return col ? { tipo: 'colaborador', col } : { tipo: null };
}

// secao: null = leitura (qualquer vinculo ve); 'dono' = so o dono; nome de secao
// (jogos/times/regras/sorteio) ou array delas = dono OU colaborador com a flag.
function conferirAcesso(v, secao) {
  if (v.tipo === null) throw naoAchou();
  if (v.tipo === 'dono') return;
  if (!secao) return; // leitura: todo colaborador ve o campeonato (RN-CO-04)
  if (secao === 'dono') throw semAcessoSecao(); // RN-CO-05
  const secoes = Array.isArray(secao) ? secao : [secao];
  if (!secoes.some((s) => v.col[FLAG_DA_SECAO[s]])) throw semAcessoSecao();
}

export function campeonatoComAcesso(db, contaId, campeonatoId, secao) {
  const c = db.prepare('SELECT * FROM campeonatos WHERE id = ?').get(Number(campeonatoId));
  const v = vinculoDoCampeonato(db, contaId, c);
  conferirAcesso(v, secao);
  return c;
}

export function timeComAcesso(db, contaId, timeId, secao) {
  const t = db.prepare('SELECT * FROM times WHERE id = ?').get(Number(timeId));
  const c = t && db.prepare('SELECT * FROM campeonatos WHERE id = ?').get(t.campeonato_id);
  conferirAcesso(vinculoDoCampeonato(db, contaId, c), secao);
  return t;
}

export function jogadorComAcesso(db, contaId, jogadorId, secao) {
  const j = db
    .prepare(
      `SELECT j.* FROM jogadores j
       LEFT JOIN times t ON t.id = j.time_id
       WHERE j.id = ?`,
    )
    .get(Number(jogadorId));
  const campId = j && (j.campeonato_id ?? db.prepare('SELECT campeonato_id FROM times WHERE id = ?').get(j.time_id)?.campeonato_id);
  const c = campId && db.prepare('SELECT * FROM campeonatos WHERE id = ?').get(campId);
  conferirAcesso(vinculoDoCampeonato(db, contaId, c), secao);
  return j;
}

export function jogoComAcesso(db, contaId, jogoId, secao) {
  const j = db.prepare('SELECT * FROM jogos WHERE id = ?').get(Number(jogoId));
  const c = j && db.prepare('SELECT * FROM campeonatos WHERE id = ?').get(j.campeonato_id);
  conferirAcesso(vinculoDoCampeonato(db, contaId, c), secao);
  return j;
}
