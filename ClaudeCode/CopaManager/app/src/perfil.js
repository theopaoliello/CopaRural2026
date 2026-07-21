// Painel do Atleta (EF Perfil do Atleta, fases C e D). Duas fontes:
// - AO VIVO (RN-AT-07): copas conectadas em andamento, calculadas de
//   jogos/eventos a cada carga — nenhum numero armazenado que possa divergir.
// - CONGELADO (RN-AT-08/09): snapshot em `atleta_estatisticas`, gravado ao
//   encerrar a copa e antes de qualquer exclusao. E o que faz o historico do
//   atleta SOBREVIVER a exclusao do campeonato — o requisito central da EF.
// O payload e uma linha por copa com totais e a quebra por ano; as guias, os
// contadores e o drill-down (RN-AT-14/15/16) sao agregados pelo cliente.
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

// Conexoes aprovadas com os campos da copa, prontas para copaDoPerfil.
const SELECT_CONEXOES = `
  SELECT cx.id AS conexao_id, cx.conta_id, cx.alvo_tipo, cx.jogador_id, cx.time_id,
         c.id AS campeonato_id, c.nome, c.slug, c.publicado, c.esporte, c.modalidade,
         c.temporada, c.encerrado_em, c.podio
  FROM conexoes_atleta cx
  JOIN campeonatos c ON c.id = cx.campeonato_id
  WHERE cx.status = 'aprovada'`;

// ---------- congelamento (fase D) ----------

// Ano de referencia do snapshot: o ano do titulo quando houver; senao o ano
// com mais jogos; senao o ano do congelamento (copa sem nenhum jogo).
function anoDeReferencia(copa) {
  if (copa.ano_titulo) return copa.ano_titulo;
  const anos = Object.entries(copa.anos);
  if (anos.length) {
    return Number(anos.sort((a, b) => b[1].jogos - a[1].jogos || Number(b[0]) - Number(a[0]))[0][0]);
  }
  return new Date().getFullYear();
}

// Grava (ou regrava) o snapshot de UMA conexao aprovada. Fonte da verdade e o
// mesmo calculo ao vivo da fase C — nada de logica de apuracao duplicada.
function congelarUma(db, cx) {
  const copa = copaDoPerfil(db, cx);
  const anosComJogo = Object.keys(copa.anos).map(Number);
  db.prepare('DELETE FROM atleta_estatisticas WHERE conta_id = ? AND campeonato_id = ?')
    .run(cx.conta_id, cx.campeonato_id);
  db.prepare(
    `INSERT INTO atleta_estatisticas
     (conta_id, campeonato_id, campeonato_nome, esporte, modalidade, temporada,
      time_nome, jogador_nome, ano, periodo_inicio, periodo_fim,
      jogos, vitorias, empates, derrotas, gols, pontos, sets_vencidos, sets_perdidos, colocacao)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    cx.conta_id,
    cx.campeonato_id,
    copa.nome,
    copa.esporte,
    copa.modalidade,
    copa.temporada,
    copa.time_nome,
    copa.alvo_tipo === 'jogador' ? copa.alvo_nome : null,
    anoDeReferencia(copa),
    anosComJogo.length ? String(Math.min(...anosComJogo)) : null,
    anosComJogo.length ? String(Math.max(...anosComJogo)) : null,
    copa.totais.jogos, copa.totais.v, copa.totais.e, copa.totais.d,
    copa.totais.gols, copa.totais.pontos, copa.totais.sets_vencidos, copa.totais.sets_perdidos,
    copa.colocacao,
  );
}

// FUNCAO UNICA de congelamento de um campeonato (EF secao 5): chamada ao
// encerrar (RN-AT-08) e por TODOS os caminhos que excluem campeonatos —
// rota do dono, master, exclusao de conta LGPD (RN-AT-09). O CASCADE do
// SQLite nao da gancho: quem apagar sem passar por aqui perde o historico
// dos atletas silenciosamente. Idempotente (regrava).
export function congelarEstatisticas(db, campeonatoId) {
  const conexoes = db.prepare(`${SELECT_CONEXOES} AND cx.campeonato_id = ?`).all(campeonatoId);
  for (const cx of conexoes) congelarUma(db, cx);
  return conexoes.length;
}

// Congela uma conexao especifica: aprovacao em copa JA encerrada e exclusao
// de jogador do elenco (EF 5.1 — congela antes de a conexao cair em cascata).
export function congelarConexao(db, conexaoId) {
  const cx = db.prepare(`${SELECT_CONEXOES} AND cx.id = ?`).get(Number(conexaoId));
  if (cx) congelarUma(db, cx);
}

// Reabrir descarta os snapshots (RN-AT-12): a copa volta ao calculo ao vivo e
// o congelamento sera regravado no proximo encerramento.
export function descongelarCampeonato(db, campeonatoId) {
  db.prepare('DELETE FROM atleta_estatisticas WHERE campeonato_id = ?').run(campeonatoId);
}

// Revogacao/desconexao removem o historico da copa do perfil (RN-AT-06):
// diferente do fim da copa, aqui a premissa e que o vinculo nao valia.
export function apagarCongelado(db, contaId, campeonatoId) {
  db.prepare('DELETE FROM atleta_estatisticas WHERE conta_id = ? AND campeonato_id = ?')
    .run(contaId, campeonatoId);
}

// Converte um snapshot na MESMA forma das linhas ao vivo — o painel nao
// distingue as fontes; so ganha as flags `congelado` e `removido` (etiqueta
// "Campeonato removido" no drill-down, EF 3.3.3).
function linhaCongelada(s) {
  const preset = obterEsporte(s.esporte);
  const alvoTipo = s.jogador_nome ? 'jogador' : 'time';
  const totais = {
    jogos: s.jogos, v: s.vitorias, e: s.empates, d: s.derrotas,
    gols: s.gols, pontos: s.pontos, sets_vencidos: s.sets_vencidos, sets_perdidos: s.sets_perdidos,
  };
  return {
    congelado: true,
    removido: s.campeonato_id == null,
    conexao_id: null,
    campeonato_id: s.campeonato_id,
    nome: s.campeonato_nome,
    slug: s.slug ?? null,
    publicado: !!s.publicado,
    esporte: s.esporte,
    esporte_nome: preset?.nome ?? s.esporte,
    modalidade: s.modalidade,
    temporada: s.temporada,
    alvo_tipo: alvoTipo,
    alvo_nome: s.jogador_nome ?? s.time_nome,
    time_nome: s.time_nome,
    empate_possivel: !!preset?.empate,
    producao: preset?.placar === 'sets' ? 'sets'
      : alvoTipo === 'jogador' && preset?.evento_individual === 'pontos' ? 'pontos'
      : alvoTipo === 'jogador' && preset?.evento_individual ? 'gols'
      : null,
    encerrado: true,
    colocacao: s.colocacao,
    ano_titulo: s.colocacao != null ? s.ano : null,
    totais,
    // O snapshot colapsa a copa no ano de referencia (decisao da EF 4.2).
    anos: s.ano != null ? { [s.ano]: totais } : {},
  };
}

// ---------- painel (vivo + congelado) ----------

// Uma linha por copa. Regra da fonte (EF secao 5): copa em andamento = ao
// vivo; copa ENCERRADA = snapshot (o numero final e oficial); copa excluida =
// snapshot orfao (campeonato_id NULL). Copa encerrada sem snapshot (estado
// anterior a fase D) cai no calculo ao vivo — os numeros sao identicos.
export function perfilDoAtleta(db, contaId) {
  const conexoes = db
    .prepare(`${SELECT_CONEXOES} AND cx.conta_id = ? ORDER BY cx.criado_em DESC`)
    .all(contaId);
  const congelados = db
    .prepare(
      `SELECT ae.*, c.slug, c.publicado
       FROM atleta_estatisticas ae
       LEFT JOIN campeonatos c ON c.id = ae.campeonato_id
       WHERE ae.conta_id = ? ORDER BY ae.congelado_em DESC`,
    )
    .all(contaId);
  const snapshotPorCampeonato = new Map(
    congelados.filter((s) => s.campeonato_id != null).map((s) => [s.campeonato_id, s]),
  );
  const campeonatosComConexao = new Set(conexoes.map((cx) => cx.campeonato_id));

  const linhas = conexoes.map((cx) => {
    const snap = cx.encerrado_em ? snapshotPorCampeonato.get(cx.campeonato_id) : null;
    return snap ? linhaCongelada(snap) : copaDoPerfil(db, cx);
  });
  // Snapshots sem conexao viva: copas excluidas (orfaos) e o caso do jogador
  // removido do elenco (conexao caiu em cascata, historico ficou — EF 5.1).
  for (const s of congelados) {
    if (s.campeonato_id != null && campeonatosComConexao.has(s.campeonato_id)) continue;
    linhas.push(linhaCongelada(s));
  }
  return linhas;
}
