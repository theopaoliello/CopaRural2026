// Painel do Atleta (EF Perfil do Atleta, fase C): estatisticas das copas com
// conexao APROVADA, calculadas AO VIVO a partir de jogos/eventos (RN-AT-07) —
// nada e armazenado nesta fase; o snapshot congelado e a fase D. O payload e
// uma linha por copa com totais e a quebra por ano; as guias, os contadores e
// o drill-down (RN-AT-14/15/16) sao agregados pelo cliente em cima disso.
import { obterEsporte } from './esportes.js';

// Ano de um jogo (EF 2.3): primeiro ano plausivel em `data` (texto livre,
// normalmente datetime-local ISO); sem ele, o ano de criado_em (sempre existe).
// O gol nunca sai da contagem total — so da quebra por ano correta.
export function anoDoJogo(jogo) {
  const m = /(\d{4})/.exec(String(jogo.data ?? ''));
  const ano = m ? Number(m[1]) : NaN;
  if (ano >= 1900 && ano <= 2100) return ano;
  return Number(String(jogo.criado_em).slice(0, 4));
}

// Acumuladores zerados de um recorte (total ou de um ano).
const zerado = () => ({
  jogos: 0, v: 0, e: 0, d: 0, gols: 0, pontos: 0, sets_vencidos: 0, sets_perdidos: 0,
});

// Estatisticas de UMA copa conectada, na visao do alvo (jogador ou time).
function copaDoPerfil(db, cx) {
  const preset = obterEsporte(cx.esporte);
  const ehPelada = preset?.ranking === 'individual';

  // Resolve o alvo e o time de referencia (para resultados e para o podio).
  let alvoNome = null;
  let timeRef = null; // id do time cujos jogos contam (null na pelada)
  let timeNome = null;
  if (cx.alvo_tipo === 'time') {
    const t = db.prepare('SELECT id, nome FROM times WHERE id = ?').get(cx.time_id);
    alvoNome = t?.nome ?? null;
    timeNome = t?.nome ?? null;
    timeRef = t?.id ?? null;
  } else {
    const j = db.prepare('SELECT id, nome, time_id FROM jogadores WHERE id = ?').get(cx.jogador_id);
    alvoNome = j?.nome ?? null;
    if (!ehPelada && j?.time_id) {
      const t = db.prepare('SELECT id, nome FROM times WHERE id = ?').get(j.time_id);
      timeNome = t?.nome ?? null;
      timeRef = t?.id ?? null;
    }
  }

  const totais = zerado();
  const anos = {};
  const noAno = (ano) => (anos[ano] ??= zerado());
  const somar = (ano, campo, valor = 1) => {
    totais[campo] += valor;
    noAno(ano)[campo] += valor;
  };

  if (ehPelada) {
    // Pelada: os jogos do ATLETA sao as escalacoes dele (precisao real, RN 7).
    const participacoes = db
      .prepare(
        `SELECT j.id, j.data, j.criado_em, j.gols_casa, j.gols_fora, j.time_casa_id, e.time_id AS meu_time
         FROM escalacoes e JOIN jogos j ON j.id = e.jogo_id
         WHERE e.jogador_id = ? AND j.status = 'encerrado'`,
      )
      .all(cx.jogador_id);
    for (const p of participacoes) {
      const ano = anoDoJogo(p);
      const gp = p.meu_time === p.time_casa_id ? p.gols_casa : p.gols_fora;
      const gc = p.meu_time === p.time_casa_id ? p.gols_fora : p.gols_casa;
      somar(ano, 'jogos');
      somar(ano, gp > gc ? 'v' : gp === gc ? 'e' : 'd');
    }
  } else if (timeRef != null) {
    // Demais esportes: jogos encerrados do TIME (o app nao registra escalacao
    // fora da pelada — o painel rotula "jogos do time" com honestidade, EF 7).
    const jogosDoTime = db
      .prepare(
        `SELECT id, data, criado_em, gols_casa, gols_fora, time_casa_id
         FROM jogos WHERE campeonato_id = ? AND status = 'encerrado'
           AND (time_casa_id = ? OR time_fora_id = ?)`,
      )
      .all(cx.campeonato_id, timeRef, timeRef);
    for (const j of jogosDoTime) {
      const ano = anoDoJogo(j);
      const gp = j.time_casa_id === timeRef ? j.gols_casa : j.gols_fora;
      const gc = j.time_casa_id === timeRef ? j.gols_fora : j.gols_casa;
      somar(ano, 'jogos');
      somar(ano, gp > gc ? 'v' : gp === gc ? 'e' : 'd');
      if (preset?.placar === 'sets') {
        // Nos esportes de sets, o placar do jogo (gols_casa/fora) E o de sets.
        somar(ano, 'sets_vencidos', gp);
        somar(ano, 'sets_perdidos', gc);
      }
    }
  }

  // Producao individual (gols/pontos): so nas conexoes de JOGADOR e nos
  // esportes com evento individual. Gol contra NAO conta para o autor (EF 7).
  if (cx.alvo_tipo === 'jogador' && preset?.evento_individual) {
    const eventos = db
      .prepare(
        `SELECT e.tipo, e.valor, j.data, j.criado_em
         FROM eventos e JOIN jogos j ON j.id = e.jogo_id
         WHERE e.jogador_id = ? AND j.status = 'encerrado' AND e.tipo IN ('gol', 'pontos')`,
      )
      .all(cx.jogador_id);
    for (const ev of eventos) {
      const ano = anoDoJogo(ev);
      if (ev.tipo === 'gol') somar(ano, 'gols');
      else somar(ano, 'pontos', ev.valor ?? 1);
    }
  }

  // Colocacao (titulo/2o/3o): so existe com a copa ENCERRADA (RN-AT-13). Nos
  // esportes de clubes, o podio guarda TIMES — a conexao de jogador herda a
  // colocacao do time dele; na pelada o podio guarda jogadores.
  let colocacao = null;
  let anoTitulo = null;
  if (cx.encerrado_em && cx.podio) {
    const podio = JSON.parse(cx.podio);
    const alvoPodio = ehPelada ? cx.jogador_id : timeRef;
    colocacao = podio.primeiro === alvoPodio ? 1
      : podio.segundo === alvoPodio ? 2
      : podio.terceiro === alvoPodio ? 3 : null;
    anoTitulo = Number(String(cx.encerrado_em).slice(0, 4));
  }

  // Tipo de producao exibido na guia (rotulo do catalogo, RN-TC-10):
  // gols/pontos so com evento individual E conexao de jogador; sets sempre que
  // o esporte e de sets (resultado do time/dupla — e o que o atleta quer ver).
  const producao = preset?.placar === 'sets' ? 'sets'
    : cx.alvo_tipo === 'jogador' && preset?.evento_individual === 'pontos' ? 'pontos'
    : cx.alvo_tipo === 'jogador' && preset?.evento_individual ? 'gols'
    : null;

  return {
    conexao_id: cx.conexao_id,
    campeonato_id: cx.campeonato_id,
    nome: cx.nome,
    slug: cx.slug,
    publicado: !!cx.publicado,
    esporte: cx.esporte,
    esporte_nome: preset?.nome ?? cx.esporte,
    modalidade: cx.modalidade,
    temporada: cx.temporada,
    alvo_tipo: cx.alvo_tipo,
    alvo_nome: alvoNome,
    time_nome: timeNome,
    empate_possivel: !!preset?.empate,
    producao,
    encerrado: !!cx.encerrado_em,
    colocacao,
    ano_titulo: anoTitulo,
    totais,
    anos,
  };
}

// Painel completo da conta: uma linha por copa com conexao aprovada (RN-AT-07,
// ao vivo). Copas pendentes/recusadas ficam de fora — nada de estatistica sem
// aprovacao do dono. Ordena pelas mais recentes.
export function perfilDoAtleta(db, contaId) {
  const conexoes = db
    .prepare(
      `SELECT cx.id AS conexao_id, cx.alvo_tipo, cx.jogador_id, cx.time_id,
              c.id AS campeonato_id, c.nome, c.slug, c.publicado, c.esporte, c.modalidade,
              c.temporada, c.encerrado_em, c.podio
       FROM conexoes_atleta cx
       JOIN campeonatos c ON c.id = cx.campeonato_id
       WHERE cx.conta_id = ? AND cx.status = 'aprovada'
       ORDER BY cx.criado_em DESC`,
    )
    .all(contaId);
  return conexoes.map((cx) => copaDoPerfil(db, cx));
}
