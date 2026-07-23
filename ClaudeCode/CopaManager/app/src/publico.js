// Montagem dos dados publicos de um campeonato (pagina do torcedor).
// Somente leitura; nada aqui exige login.
import { erroNaoEncontrado } from './erros.js';
import { classificacaoDoCampeonato, vagasDoCampeonato, chaveamentoDoCampeonato } from './campeonatos.js';
import { estatisticasJogadores } from './classificacao.js';
import {
  nomeRodadaMata, vencedorConfronto, ultimaRodadaMata, CONFRONTO_TERCEIRO,
} from './tabela.js';
import { podioComNomes } from './encerramento.js';
import { obterEsporte, ESPORTE_PADRAO } from './esportes.js';

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
      `SELECT j.id, j.time_id, j.nome, j.numero, j.tipo, j.goleiro, j.ativo FROM jogadores j
       LEFT JOIN times t ON t.id = j.time_id
       WHERE COALESCE(j.campeonato_id, t.campeonato_id) = ? ORDER BY j.nome`,
    )
    .all(campeonato.id);
  const escalacoes = db
    .prepare(
      `SELECT e.jogo_id, e.jogador_id, e.time_id FROM escalacoes e
       JOIN jogos j ON j.id = e.jogo_id WHERE j.campeonato_id = ?`,
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
  // Banner Especial (RN-BE-02/06): banners globais so aparecem em campeonatos de
  // contas do tipo Padrao. O gate le o tipo ATUAL da conta dona (sem dado gravado
  // por campeonato): promover a conta a Premium some com eles na proxima carga.
  const contaDona = db.prepare('SELECT tipo FROM contas WHERE id = ?').get(campeonato.conta_id);
  const bannersGlobais = contaDona?.tipo === 'padrao'
    ? db.prepare('SELECT id, imagem, link FROM banners_globais WHERE ativo = 1 ORDER BY ordem, id').all()
    : [];
  const sets = db
    .prepare(
      `SELECT s.jogo_id, s.numero, s.pontos_casa, s.pontos_fora FROM sets s
       JOIN jogos j ON j.id = s.jogo_id
       WHERE j.campeonato_id = ? AND j.status = 'encerrado' ORDER BY s.jogo_id, s.numero`,
    )
    .all(campeonato.id);

  // Rotulos e nome do esporte (RN-TC-10): a pagina publica nunca fixa
  // "Time"/"Artilharia" no HTML — le daqui.
  const preset = obterEsporte(campeonato.esporte) ?? obterEsporte(ESPORTE_PADRAO);

  // Estatisticas por jogador (gols/pontos/cartoes) para elenco e artilharia.
  const stats = estatisticasJogadores(eventos);
  const jogadoresComStats = jogadores.map((j) => ({
    ...j,
    gols: stats.get(j.id)?.gols ?? 0,
    pontos: stats.get(j.id)?.pontos ?? 0,
    amarelos: stats.get(j.id)?.amarelos ?? 0,
    vermelhos: stats.get(j.id)?.vermelhos ?? 0,
  }));

  const nomeTime = new Map(times.map((t) => [t.id, t.nome]));
  // Ranking individual do esporte: gols (artilharia) ou pontos (cestinhas).
  const campoIndividual = preset.evento_individual === 'pontos' ? 'pontos' : 'gols';
  const artilharia = !preset.evento_individual ? [] : jogadoresComStats
    .filter((j) => j[campoIndividual] > 0)
    .sort((a, b) => b[campoIndividual] - a[campoIndividual] || a.nome.localeCompare(b.nome, 'pt-BR'))
    .slice(0, 20)
    .map((j) => ({ nome: j.nome, time: nomeTime.get(j.time_id), tipo: j.tipo, total: j[campoIndividual] }));
  const disciplina = !preset.tem_cartoes ? [] : jogadoresComStats
    .filter((j) => j.amarelos + j.vermelhos > 0)
    .sort((a, b) => b.vermelhos - a.vermelhos || b.amarelos - a.amarelos)
    .slice(0, 20)
    .map((j) => ({ nome: j.nome, time: nomeTime.get(j.time_id), amarelos: j.amarelos, vermelhos: j.vermelhos }));

  const classificacao = classificacaoDoCampeonato(db, campeonato);

  // Chaveamento do mata-mata agrupado por rodada, com nome da fase e vencedor.
  const mata = jogos.filter((j) => j.fase === 'mata');
  const rodadasMata = [...new Set(mata.map((j) => j.rodada))].sort((a, b) => a - b);
  const ultimaMata = ultimaRodadaMata(mata);
  const chaveamento = rodadasMata.map((r) => {
    const daRodada = mata.filter((j) => j.rodada === r);
    const confrontos = [...new Set(daRodada.map((j) => j.confronto))].sort((a, b) => a - b);
    // A disputa de 3o nao conta para o nome da fase: com ela, a ultima rodada
    // tem 2 confrontos e continua sendo a Final (RN-MM-15).
    const daChave = confrontos.filter((c) => !(r === ultimaMata && c === CONFRONTO_TERCEIRO));
    return {
      rodada: r,
      fase: nomeRodadaMata(r, ultimaMata, daChave.length),
      confrontos: confrontos.map((c) => {
        const pernas = daRodada.filter((j) => j.confronto === c);
        return {
          confronto: c,
          disputa_terceiro: r === ultimaMata && c === CONFRONTO_TERCEIRO,
          jogos: pernas.map((j) => j.id),
          vencedor: vencedorConfronto(pernas),
        };
      }),
    };
  });

  // Desenho da chave (EF Mata-mata Manual, fase D): estrutura + vagas de
  // entrada. No misto manual isso existe ANTES de o mata ser gerado — e o que
  // deixa o torcedor ver o caminho ("1o do Grupo A") desde o comeco.
  let chave = null;
  if (campeonato.formato !== 'pontos') {
    const c = chaveamentoDoCampeonato(db, campeonato);
    if (c.rodadas.length) {
      chave = {
        modelo: c.modelo,
        desenho: c.desenho,
        gerado: c.gerado,
        vagas: c.vagas ?? c.slots.length,
        rodadas: c.rodadas,
        slots: c.slots.map((s) => ({
          rodada: s.rodada,
          confronto: s.confronto,
          lado: s.lado,
          time_id: s.time_id ?? null,
          rotulo: s.rotulo_texto ?? null,
          previa: s.previa_nome ?? null,
        })),
      };
    }
  }

  return {
    chave,
    esporte: {
      chave: preset.chave,
      nome: preset.nome,
      placar: preset.placar,
      ranking: preset.ranking ?? 'times',
      rotulos: preset.rotulos,
      colunas: preset.colunas,
      melhor_de: campeonato.melhor_de,
      tem_cartoes: !!preset.tem_cartoes,
    },
    campeonato: {
      nome: campeonato.nome,
      temporada: campeonato.temporada,
      esporte: campeonato.esporte,
      modalidade: campeonato.modalidade,
      descricao: campeonato.descricao,
      cor_tema: campeonato.cor_tema,
      logo: campeonato.logo,
      slug: campeonato.slug,
      formato: campeonato.formato,
      status: campeonato.status,
      regras: campeonato.regras,
      jogos_temporada: campeonato.jogos_temporada,
      // Encerramento (EF Perfil do Atleta, fase A): a pagina publica mostra o
      // podio quando o gestor encerrou a copa; NULL = em andamento.
      encerrado_em: campeonato.encerrado_em,
      // Atalho do Atleta (EF Notificacoes, fase A / RN-NT-01): a pagina publica
      // so mostra "Eu jogo nesta Copa" quando o organizador aceita conexoes.
      aceita_conexoes: campeonato.aceita_conexoes,
    },
    podio: podioComNomes(db, campeonato),
    classificacao,
    vagas: vagasDoCampeonato(db, campeonato, classificacao),
    grupos,
    times,
    jogadores: jogadoresComStats,
    jogos,
    eventos,
    sets,
    escalacoes,
    artilharia,
    disciplina,
    chaveamento,
    banners,
    banners_globais: bannersGlobais,
  };
}
