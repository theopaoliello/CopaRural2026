// Encerramento explicito do campeonato com podio (EF Perfil do Atleta, fase A).
// O podio (1o/2o/3o) so existe ao encerrar (RN-AT-13): o sistema SUGERE pelo
// resultado da competicao e o gestor confirma ou ajusta. Reabrir limpa ambos
// (RN-AT-12). O "fim definido" (todos os jogos encerrados) tambem dirige o
// dialogo "encerrar antes de excluir" (RN-AT-10, EF 3.5).
import { erroValidacao, erroConflito } from './erros.js';
import { obterEsporte } from './esportes.js';
import { vencedorConfronto, perdedorConfronto, CONFRONTO_TERCEIRO } from './tabela.js';
import { classificacaoDoCampeonato } from './campeonatos.js';
import { congelarEstatisticas, descongelarCampeonato } from './perfil.js';

// Estado que dirige o card de Config e o dialogo de exclusao (EF 3.5):
// "fim definido" = ha jogos e nenhum pendente — a leitura mais proxima de
// "a copa acabou" que o modelo permite. No grupos_mata o fim e no mata:
// sem jogos de mata gerados, a copa ainda nao chegou ao fim.
export function estadoEncerramento(db, campeonato) {
  const total = db
    .prepare('SELECT COUNT(*) AS n FROM jogos WHERE campeonato_id = ?')
    .get(campeonato.id).n;
  const pendentes = db
    .prepare("SELECT COUNT(*) AS n FROM jogos WHERE campeonato_id = ? AND status != 'encerrado'")
    .get(campeonato.id).n;
  let fimDefinido = total > 0 && pendentes === 0;
  if (fimDefinido && campeonato.formato === 'grupos_mata') {
    const mata = db
      .prepare("SELECT COUNT(*) AS n FROM jogos WHERE campeonato_id = ? AND fase = 'mata'")
      .get(campeonato.id).n;
    if (!mata) fimDefinido = false;
  }
  return {
    encerrado: !!campeonato.encerrado_em,
    encerrado_em: campeonato.encerrado_em,
    podio: campeonato.podio ? JSON.parse(campeonato.podio) : null,
    jogos_total: total,
    jogos_pendentes: pendentes,
    fim_definido: fimDefinido,
  };
}

// Sugestao automatica do podio (RN-AT-13, EF 2.2): campeao/vice pela final do
// mata-mata; nos pontos corridos (e na pelada), os primeiros da classificacao.
// O 3o lugar do mata-mata e ambiguo sem disputa de 3o: fica null e o gestor
// escolhe. Nunca lanca erro — sem dado suficiente, sugere nulls.
export function sugerirPodio(db, campeonato) {
  const vazio = { primeiro: null, segundo: null, terceiro: null };
  const temMata = campeonato.formato === 'mata' || campeonato.formato === 'grupos_mata';

  if (temMata) {
    // Ultima rodada do mata: confronto 0 = final; confronto 1, quando existe,
    // = disputa de 3o lugar (RN-MM-22). Antes da disputa existir, a ultima
    // rodada tinha sempre um confronto so — dai a checagem antiga.
    const ultima = db
      .prepare(
        `SELECT * FROM jogos WHERE campeonato_id = ? AND fase = 'mata'
         AND rodada = (SELECT MAX(rodada) FROM jogos WHERE campeonato_id = ? AND fase = 'mata')
         ORDER BY perna`,
      )
      .all(campeonato.id, campeonato.id);
    const confrontos = new Set(ultima.map((j) => j.confronto));
    if (!ultima.length || confrontos.size > 2 || !confrontos.has(0)) return vazio;

    const pernasFinal = ultima.filter((j) => j.confronto === 0);
    const campeao = vencedorConfronto(pernasFinal);
    if (!campeao) return vazio;
    const vice = perdedorConfronto(pernasFinal, campeao);

    // RN-MM-23: com disputa de 3o, o podio ja vem completo. Sem ela, o 3o
    // segue em branco — nao ha como deduzi-lo de uma eliminacao simples.
    const pernasDisputa = ultima.filter((j) => j.confronto === CONFRONTO_TERCEIRO);
    const terceiro = pernasDisputa.length ? vencedorConfronto(pernasDisputa) : null;
    return { primeiro: campeao, segundo: vice, terceiro };
  }

  // Pontos corridos e Pelada Epica: os 3 primeiros da classificacao/ranking.
  const linhas = classificacaoDoCampeonato(db, campeonato)[0]?.linhas ?? [];
  if (!linhas.some((l) => l.pj > 0)) return vazio;
  const id = (l) => l?.time_id ?? l?.jogador_id ?? null;
  return { primeiro: id(linhas[0]), segundo: id(linhas[1]), terceiro: id(linhas[2]) };
}

// Valida um id do podio: time do campeonato ou, na pelada, jogador FIXO dele
// (suplentes sao coringas, fora do ranking e da premiacao — RN-PE-01).
function conferirIntegrante(db, campeonato, valor, rotulo, ehPelada) {
  if (valor == null || valor === '') return null;
  const id = Number(valor);
  const dono = ehPelada
    ? db.prepare("SELECT id FROM jogadores WHERE id = ? AND campeonato_id = ? AND tipo = 'fixo'").get(id, campeonato.id)
    : db.prepare('SELECT id FROM times WHERE id = ? AND campeonato_id = ?').get(id, campeonato.id);
  if (!dono) {
    throw erroValidacao(`${rotulo} lugar invalido: escolha ${ehPelada ? 'um jogador fixo' : 'um time'} deste campeonato.`);
  }
  return id;
}

// Encerra o campeonato gravando o podio declarado (RN-AT-13). Exige o fim
// definido: com jogos pendentes nao ha campeao a declarar (EF 3.5).
export function encerrarCampeonato(db, campeonato, dados = {}) {
  if (campeonato.encerrado_em) throw erroConflito('Este campeonato ja foi encerrado.');
  const estado = estadoEncerramento(db, campeonato);
  if (!estado.fim_definido) {
    throw erroValidacao(
      estado.jogos_pendentes > 0
        ? `Ainda ha ${estado.jogos_pendentes} jogo(s) sem resultado. Encerre todos os jogos antes de encerrar o campeonato.`
        : 'Este campeonato ainda nao tem jogos realizados para encerrar.',
    );
  }

  const ehPelada = obterEsporte(campeonato.esporte)?.ranking === 'individual';
  const primeiro = conferirIntegrante(db, campeonato, dados.primeiro, '1º', ehPelada);
  if (!primeiro) throw erroValidacao('Informe o campeão (1º lugar) para encerrar.');
  const segundo = conferirIntegrante(db, campeonato, dados.segundo, '2º', ehPelada);
  const terceiro = conferirIntegrante(db, campeonato, dados.terceiro, '3º', ehPelada);
  const ids = [primeiro, segundo, terceiro].filter((x) => x != null);
  if (new Set(ids).size !== ids.length) {
    throw erroValidacao('O pódio tem posições repetidas: cada lugar deve ser de um participante diferente.');
  }

  const podio = JSON.stringify({ primeiro, segundo, terceiro });
  db.prepare("UPDATE campeonatos SET encerrado_em = datetime('now'), podio = ? WHERE id = ?")
    .run(podio, campeonato.id);
  // Congela DEPOIS de gravar o podio (RN-AT-08): o snapshot ja nasce com a
  // colocacao — e o numero final e oficial da competicao (EF secao 5).
  congelarEstatisticas(db, campeonato.id);
  return db.prepare('SELECT * FROM campeonatos WHERE id = ?').get(campeonato.id);
}

// Reabre um campeonato encerrado (RN-AT-12): o podio e descartado e sera
// declarado de novo no proximo encerramento (correcoes nao ficam para sempre).
// Os snapshots congelados sao descartados junto: a copa volta ao vivo.
export function reabrirCampeonato(db, campeonato) {
  if (!campeonato.encerrado_em) throw erroConflito('Este campeonato nao esta encerrado.');
  db.prepare('UPDATE campeonatos SET encerrado_em = NULL, podio = NULL WHERE id = ?').run(campeonato.id);
  descongelarCampeonato(db, campeonato.id);
  return db.prepare('SELECT * FROM campeonatos WHERE id = ?').get(campeonato.id);
}

// Podio com nomes resolvidos para exibicao (admin e pagina publica). Devolve
// null se o campeonato nao esta encerrado.
export function podioComNomes(db, campeonato) {
  if (!campeonato.encerrado_em || !campeonato.podio) return null;
  const podio = JSON.parse(campeonato.podio);
  const ehPelada = obterEsporte(campeonato.esporte)?.ranking === 'individual';
  const resolver = (id) => {
    if (id == null) return null;
    if (ehPelada) {
      const j = db.prepare('SELECT id, nome FROM jogadores WHERE id = ?').get(id);
      return j ? { id: j.id, nome: j.nome, escudo: null } : null;
    }
    const t = db.prepare('SELECT id, nome, escudo FROM times WHERE id = ?').get(id);
    return t ? { id: t.id, nome: t.nome, escudo: t.escudo } : null;
  };
  return {
    primeiro: resolver(podio.primeiro),
    segundo: resolver(podio.segundo),
    terceiro: resolver(podio.terceiro),
  };
}
