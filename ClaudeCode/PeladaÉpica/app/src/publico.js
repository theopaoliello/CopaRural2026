// Montagem dos dados publicos de um campeonato (pagina do torcedor).
// Somente leitura; nada aqui exige login.
import { erroNaoEncontrado } from './erros.js';
import { classificacaoDoCampeonato } from './campeonatos.js';
import { estatisticasJogadores } from './classificacao.js';
import { nomeFaseMata, vencedorConfronto } from './tabela.js';

export function dadosPublicos(db, slug) {
  const campeonato = db
    .prepare("SELECT * FROM campeonatos WHERE slug = ? AND publicado = 1")
    .get(String(slug));
  if (!campeonato) throw erroNaoEncontrado('Campeonato nao encontrado.');

  const times = db
    .prepare('SELECT id, grupo_id, nome, escudo, foto FROM times WHERE campeonato_id = ? ORDER BY nome')
    .all(campeonato.id);
  const grupos = db
    .prepare('SELECT id, nome FROM grupos WHERE campeonato_id = ? ORDER BY nome')
    .all(campeonato.id);
  const jogadores = db
    .prepare(
      `SELECT j.id, j.time_id, j.nome, j.numero FROM jogadores j
       JOIN times t ON t.id = j.time_id WHERE t.campeonato_id = ? ORDER BY j.nome`,
    )
    .all(campeonato.id);
  const jogos = db
    .prepare('SELECT * FROM jogos WHERE campeonato_id = ? ORDER BY fase, rodada, confronto, perna, id')
    .all(campeonato.id);
  const eventos = db
    .prepare(
      `SELECT e.* FROM eventos e JOIN jogos j ON j.id = e.jogo_id
       WHERE j.campeonato_id = ? AND j.status = 'encerrado'`,
    )
    .all(campeonato.id);
  const banners = db
    .prepare('SELECT id, imagem, link FROM banners WHERE campeonato_id = ? AND ativo = 1 ORDER BY ordem, id')
    .all(campeonato.id);

  // Estatisticas por jogador (gols/cartoes) para elenco e artilharia.
  const stats = estatisticasJogadores(eventos);
  const jogadoresComStats = jogadores.map((j) => ({
    ...j,
    gols: stats.get(j.id)?.gols ?? 0,
    amarelos: stats.get(j.id)?.amarelos ?? 0,
    vermelhos: stats.get(j.id)?.vermelhos ?? 0,
  }));

  const nomeTime = new Map(times.map((t) => [t.id, t.nome]));
  const artilharia = jogadoresComStats
    .filter((j) => j.gols > 0)
    .sort((a, b) => b.gols - a.gols || a.nome.localeCompare(b.nome, 'pt-BR'))
    .slice(0, 20)
    .map((j) => ({ nome: j.nome, time: nomeTime.get(j.time_id), gols: j.gols }));
  const disciplina = jogadoresComStats
    .filter((j) => j.amarelos + j.vermelhos > 0)
    .sort((a, b) => b.vermelhos - a.vermelhos || b.amarelos - a.amarelos)
    .slice(0, 20)
    .map((j) => ({ nome: j.nome, time: nomeTime.get(j.time_id), amarelos: j.amarelos, vermelhos: j.vermelhos }));

  // Chaveamento do mata-mata agrupado por rodada, com nome da fase e vencedor.
  const mata = jogos.filter((j) => j.fase === 'mata');
  const rodadasMata = [...new Set(mata.map((j) => j.rodada))].sort((a, b) => a - b);
  const chaveamento = rodadasMata.map((r) => {
    const daRodada = mata.filter((j) => j.rodada === r);
    const confrontos = [...new Set(daRodada.map((j) => j.confronto))].sort((a, b) => a - b);
    return {
      rodada: r,
      fase: nomeFaseMata(confrontos.length),
      confrontos: confrontos.map((c) => {
        const pernas = daRodada.filter((j) => j.confronto === c);
        return { confronto: c, jogos: pernas.map((j) => j.id), vencedor: vencedorConfronto(pernas) };
      }),
    };
  });

  return {
    campeonato: {
      nome: campeonato.nome,
      temporada: campeonato.temporada,
      modalidade: campeonato.modalidade,
      descricao: campeonato.descricao,
      cor_tema: campeonato.cor_tema,
      logo: campeonato.logo,
      slug: campeonato.slug,
      formato: campeonato.formato,
      status: campeonato.status,
    },
    classificacao: classificacaoDoCampeonato(db, campeonato),
    grupos,
    times,
    jogadores: jogadoresComStats,
    jogos,
    eventos,
    artilharia,
    disciplina,
    chaveamento,
    banners,
  };
}
