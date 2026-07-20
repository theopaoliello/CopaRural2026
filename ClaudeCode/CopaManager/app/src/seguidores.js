// Seguir Campeonatos (RN-SG): vinculo PESSOAL conta<->campeonato, somente leitura.
// Seguir NAO concede nenhum acesso administrativo (RN-SG-02) — a pessoa continua
// vendo apenas a pagina publica. O vinculo e unico (RN-SG-01/03) e some em cascata
// ao excluir a conta ou o campeonato (RN-SG-08, garantido pelo schema).
import { erroNaoEncontrado, erroConflito } from './erros.js';

// Limite de campeonatos que uma conta pode seguir (decisao da spec, secao 7).
export const LIMITE_SEGUIDOS = 40;

// So da para seguir campeonato PUBLICADO; se nao existe ou esta despublicado,
// respondemos 404 — nesses casos o botao "Seguir" nem aparece (RN-SG-08).
function campeonatoPublicado(db, slug) {
  const c = db.prepare('SELECT * FROM campeonatos WHERE slug = ? AND publicado = 1').get(String(slug));
  if (!c) throw erroNaoEncontrado('Campeonato nao encontrado.');
  return c;
}

export function estaSeguindo(db, contaId, campeonatoId) {
  return !!db
    .prepare('SELECT 1 FROM seguidores WHERE conta_id = ? AND campeonato_id = ?')
    .get(contaId, campeonatoId);
}

// Contagem derivada (RN-SG-09); visivel so ao dono, no painel (RN-SG, secao 7).
export function contarSeguidores(db, campeonatoId) {
  return db.prepare('SELECT COUNT(*) AS n FROM seguidores WHERE campeonato_id = ?').get(campeonatoId).n;
}

function contarSeguidos(db, contaId) {
  return db.prepare('SELECT COUNT(*) AS n FROM seguidores WHERE conta_id = ?').get(contaId).n;
}

// Seguir e idempotente (RN-SG-03): seguir de novo nao duplica nem estoura o
// limite. O limite so barra ao passar de nao-segue para segue (RN-SG-10).
export function seguir(db, contaId, slug) {
  const c = campeonatoPublicado(db, slug);
  if (!estaSeguindo(db, contaId, c.id)) {
    if (contarSeguidos(db, contaId) >= LIMITE_SEGUIDOS) {
      throw erroConflito(
        `Voce atingiu o limite de ${LIMITE_SEGUIDOS} campeonatos seguidos. Deixe de seguir algum para acompanhar outro.`,
      );
    }
    db.prepare('INSERT INTO seguidores (conta_id, campeonato_id) VALUES (?, ?)').run(contaId, c.id);
  }
  return { seguindo: true };
}

export function deixarDeSeguir(db, contaId, slug) {
  const c = campeonatoPublicado(db, slug);
  db.prepare('DELETE FROM seguidores WHERE conta_id = ? AND campeonato_id = ?').run(contaId, c.id);
  return { seguindo: false };
}

// Estado do botao na pagina publica (RN-SG-06). Visitante anonimo nunca segue.
// Nao expoe a contagem: o numero de seguidores nao aparece na pagina publica
// (decisao da spec, secao 7).
export function estadoDeSeguir(db, contaId, slug) {
  const c = campeonatoPublicado(db, slug);
  return { logado: !!contaId, seguindo: contaId ? estaSeguindo(db, contaId, c.id) : false };
}

// Lista da secao "Seguindo" da home (RN-SG-04): as copas que a conta segue, com
// as mesmas contagens de andamento dos cards do painel. Ordena pelas seguidas
// mais recentemente. NAO conta no limite de campeonatos do plano do seguidor.
export function listarSeguidos(db, contaId) {
  return db
    .prepare(
      `SELECT c.id, c.nome, c.slug, c.esporte, c.modalidade, c.temporada, c.status, c.logo,
              dono.nome AS dono_nome,
              (SELECT COUNT(*) FROM times t WHERE t.campeonato_id = c.id) AS n_times,
              (SELECT COUNT(*) FROM jogos j WHERE j.campeonato_id = c.id) AS n_jogos,
              (SELECT COUNT(*) FROM jogos j WHERE j.campeonato_id = c.id AND j.status = 'encerrado') AS n_encerrados
       FROM seguidores s
       JOIN campeonatos c ON c.id = s.campeonato_id
       JOIN contas dono ON dono.id = c.conta_id
       WHERE s.conta_id = ?
       ORDER BY s.criado_em DESC, c.nome`,
    )
    .all(contaId);
}
