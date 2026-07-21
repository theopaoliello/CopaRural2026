// Conexoes de atleta (EF Perfil do Atleta, fase B): a conta pede ao dono da
// copa para ser reconhecida como um jogador (times com elenco) ou como
// integrante de um time (copas 2x2/1x1 sem elenco — RN-AT-25). A conexao e
// somente leitura e de mao unica (RN-AT-01): nada aqui altera a competicao.
// Quem aprova, recusa e revoga e SEMPRE o dono (RN-AT-05).
import { erroValidacao, erroConflito, erroNaoEncontrado } from './erros.js';
import { obterEsporte } from './esportes.js';
import { textoLimitado } from './campeonatos.js';
import { congelarConexao, apagarCongelado } from './perfil.js';

// E-mail mascarado para a fila do dono (RN-AT-20, minimizacao LGPD):
// "theo@gmail.com" -> "th•••@gmail.com". O dono reconhece quem pede sem
// receber o endereco completo.
export function mascararEmail(email) {
  const [local, dominio] = String(email).split('@');
  return `${local.slice(0, 2)}•••@${dominio ?? ''}`;
}

// Tamanho da dupla/individuo extraido da variante ("Duplas 2x2" -> 2,
// "Individual 1x1" -> 1). NULL quando a variante nao tem o padrao NxN —
// dirige apenas o AVISO da fila (EF 3.4): o app nao trava por variante.
export function tamanhoDaVariante(modalidade) {
  const m = /(\d+)\s*x\s*\d+/i.exec(String(modalidade ?? ''));
  return m ? Number(m[1]) : null;
}

function ehPelada(campeonato) {
  return obterEsporte(campeonato.esporte)?.ranking === 'individual';
}

function seguindo(db, contaId, campeonatoId) {
  return !!db
    .prepare('SELECT 1 FROM seguidores WHERE conta_id = ? AND campeonato_id = ?')
    .get(contaId, campeonatoId);
}

// Copa aberta a conexoes: publicada e com a flag ligada (RN-AT-19).
function campeonatoConectavel(db, slug) {
  const c = db
    .prepare('SELECT * FROM campeonatos WHERE slug = ? AND publicado = 1 AND aceita_conexoes = 1')
    .get(String(slug));
  if (!c) throw erroNaoEncontrado('Campeonato nao encontrado ou nao aceita conexoes de atletas.');
  return c;
}

// Copas que a conta pode escolher no "Me conectar a Copa" (RN-AT-02): as que
// ela SEGUE, publicadas e aceitando conexoes — com o estado da conexao dela.
export function listarConectaveis(db, contaId) {
  return db
    .prepare(
      `SELECT c.id, c.nome, c.slug, c.esporte, c.modalidade, c.temporada,
              cx.status AS minha_conexao
       FROM seguidores s
       JOIN campeonatos c ON c.id = s.campeonato_id
       LEFT JOIN conexoes_atleta cx ON cx.campeonato_id = c.id AND cx.conta_id = s.conta_id
       WHERE s.conta_id = ? AND c.publicado = 1 AND c.aceita_conexoes = 1
       ORDER BY s.criado_em DESC, c.nome`,
    )
    .all(contaId);
}

// Elenco para o passo "identificar-se" (EF 3.1): na pelada, os jogadores do
// campeonato (sem etapa de time); nos demais, os times com seus jogadores.
// Time SEM elenco e conectavel diretamente (alvo 'time', RN-AT-25). Jogador
// com conexao APROVADA (de qualquer conta) aparece indisponivel (RN-AT-04),
// sem revelar por quem.
export function elencoParaConexao(db, contaId, slug) {
  const c = campeonatoConectavel(db, slug);
  if (!seguindo(db, contaId, c.id)) {
    throw erroValidacao('Siga esta copa antes de se conectar a ela.');
  }
  const reivindicados = new Set(
    db.prepare(
      "SELECT jogador_id FROM conexoes_atleta WHERE campeonato_id = ? AND status = 'aprovada' AND jogador_id IS NOT NULL",
    ).all(c.id).map((r) => r.jogador_id),
  );
  const base = { campeonato: { id: c.id, nome: c.nome, slug: c.slug, esporte: c.esporte, modalidade: c.modalidade } };
  if (ehPelada(c)) {
    const jogadores = db
      .prepare('SELECT id, nome, tipo FROM jogadores WHERE campeonato_id = ? AND ativo = 1 ORDER BY nome COLLATE NOCASE')
      .all(c.id);
    return {
      ...base,
      pelada: true,
      jogadores: jogadores.map((j) => ({ ...j, disponivel: !reivindicados.has(j.id) })),
    };
  }
  const times = db.prepare('SELECT id, nome FROM times WHERE campeonato_id = ? ORDER BY nome').all(c.id);
  const jogadoresPorTime = new Map(times.map((t) => [t.id, []]));
  for (const j of db
    .prepare('SELECT id, time_id, nome, numero FROM jogadores WHERE time_id IN (SELECT id FROM times WHERE campeonato_id = ?) ORDER BY nome COLLATE NOCASE')
    .all(c.id)) {
    jogadoresPorTime.get(j.time_id)?.push({ id: j.id, nome: j.nome, numero: j.numero, disponivel: !reivindicados.has(j.id) });
  }
  return {
    ...base,
    pelada: false,
    times: times.map((t) => {
      const jogadores = jogadoresPorTime.get(t.id) ?? [];
      // sem elenco = conexao ao proprio time (a dupla E a entidade que compete)
      return { id: t.id, nome: t.nome, sem_elenco: !jogadores.length, jogadores };
    }),
  };
}

// Resolve e valida o ALVO da solicitacao pela estrutura (RN-AT-04/25):
// pelada -> jogador do campeonato; jogador_id -> jogador de um time da copa;
// time_id -> so quando o time nao tem elenco cadastrado.
function resolverAlvo(db, c, dados) {
  if (ehPelada(c)) {
    const j = db
      .prepare('SELECT id FROM jogadores WHERE id = ? AND campeonato_id = ? AND ativo = 1')
      .get(Number(dados.jogador_id), c.id);
    if (!j) throw erroValidacao('Escolha um jogador deste campeonato.');
    return { alvo_tipo: 'jogador', jogador_id: j.id, time_id: null };
  }
  if (dados.jogador_id != null) {
    const j = db
      .prepare(
        `SELECT j.id FROM jogadores j JOIN times t ON t.id = j.time_id
         WHERE j.id = ? AND t.campeonato_id = ?`,
      )
      .get(Number(dados.jogador_id), c.id);
    if (!j) throw erroValidacao('Escolha um jogador de um time deste campeonato.');
    return { alvo_tipo: 'jogador', jogador_id: j.id, time_id: null };
  }
  if (dados.time_id != null) {
    const t = db.prepare('SELECT id FROM times WHERE id = ? AND campeonato_id = ?').get(Number(dados.time_id), c.id);
    if (!t) throw erroValidacao('Escolha um time deste campeonato.');
    const elenco = db.prepare('SELECT COUNT(*) AS n FROM jogadores WHERE time_id = ?').get(t.id).n;
    if (elenco) {
      throw erroValidacao('Este time tem jogadores cadastrados: escolha o SEU jogador no elenco.');
    }
    return { alvo_tipo: 'time', jogador_id: null, time_id: t.id };
  }
  throw erroValidacao('Informe o jogador (ou o time, nas copas de dupla) para se conectar.');
}

function jogadorJaReivindicado(db, jogadorId) {
  return jogadorId != null && !!db
    .prepare("SELECT 1 FROM conexoes_atleta WHERE jogador_id = ? AND status = 'aprovada'")
    .get(jogadorId);
}

// Solicita a conexao (EF 3.1 passo 4). Nasce pendente (RN-AT-05); uma recusa
// anterior nesta copa e REUSADA como novo pedido (RN-AT-22: refazer e um ato
// explicito) — pendente/aprovada existente barra com 409 (RN-AT-03).
export function solicitarConexao(db, contaId, dados = {}) {
  const c = campeonatoConectavel(db, dados.slug);
  if (!seguindo(db, contaId, c.id)) {
    throw erroValidacao('Siga esta copa antes de se conectar a ela.');
  }
  const alvo = resolverAlvo(db, c, dados);
  if (jogadorJaReivindicado(db, alvo.jogador_id)) {
    throw erroConflito('Este jogador ja esta conectado a outra conta.');
  }
  const observacao = textoLimitado(dados.observacao, 200, 'Observacao');

  const existente = db
    .prepare('SELECT * FROM conexoes_atleta WHERE conta_id = ? AND campeonato_id = ?')
    .get(contaId, c.id);
  if (existente && existente.status !== 'recusada') {
    throw erroConflito(
      existente.status === 'aprovada'
        ? 'Voce ja esta conectado a este campeonato.'
        : 'Voce ja tem uma solicitacao pendente neste campeonato.',
    );
  }
  if (existente) {
    db.prepare(
      `UPDATE conexoes_atleta SET alvo_tipo = ?, jogador_id = ?, time_id = ?, status = 'pendente',
       observacao = ?, decidido_por = NULL, decidido_em = NULL, criado_em = datetime('now') WHERE id = ?`,
    ).run(alvo.alvo_tipo, alvo.jogador_id, alvo.time_id, observacao, existente.id);
    return db.prepare('SELECT * FROM conexoes_atleta WHERE id = ?').get(existente.id);
  }
  const info = db
    .prepare(
      `INSERT INTO conexoes_atleta (conta_id, campeonato_id, alvo_tipo, jogador_id, time_id, observacao)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(contaId, c.id, alvo.alvo_tipo, alvo.jogador_id, alvo.time_id, observacao);
  return db.prepare('SELECT * FROM conexoes_atleta WHERE id = ?').get(Number(info.lastInsertRowid));
}

// Conexoes da propria conta, para a secao Atleta do painel: copa + alvo com
// nome resolvido + status. Ordena pendentes primeiro, depois mais recentes.
export function minhasConexoes(db, contaId) {
  return db
    .prepare(
      `SELECT cx.id, cx.status, cx.alvo_tipo, cx.observacao, cx.criado_em, cx.decidido_em,
              c.nome AS campeonato_nome, c.slug, c.esporte, c.temporada,
              COALESCE(j.nome, t.nome) AS alvo_nome
       FROM conexoes_atleta cx
       JOIN campeonatos c ON c.id = cx.campeonato_id
       LEFT JOIN jogadores j ON j.id = cx.jogador_id
       LEFT JOIN times t ON t.id = cx.time_id
       WHERE cx.conta_id = ?
       ORDER BY cx.status = 'pendente' DESC, cx.criado_em DESC`,
    )
    .all(contaId);
}

// O atleta cancela a solicitacao ou se desconecta (RN-AT-06): a linha some e,
// se havia jogador reivindicado, ele volta a ficar disponivel. A desconexao
// APAGA o historico congelado da copa (decisao fechada da EF: apagar, nao
// ocultar — e o dado dele; se quer tirar do perfil, tira).
export function removerConexaoDoAtleta(db, contaId, conexaoId) {
  const cx = db
    .prepare('SELECT * FROM conexoes_atleta WHERE id = ? AND conta_id = ?')
    .get(Number(conexaoId), contaId);
  if (!cx) throw erroNaoEncontrado('Conexao nao encontrada.');
  db.prepare('DELETE FROM conexoes_atleta WHERE id = ?').run(cx.id);
  apagarCongelado(db, contaId, cx.campeonato_id);
  return { ok: true };
}

// Fila do dono (EF 3.2): pendentes para decidir + conectados para revogar.
// Cada item traz o alvo com nome, quem pediu (nome + e-mail MASCARADO) e, nas
// conexoes de time, o aviso quando as conexoes passam do tamanho da variante.
export function filaDoCampeonato(db, campeonato) {
  const linhas = db
    .prepare(
      `SELECT cx.id, cx.status, cx.alvo_tipo, cx.jogador_id, cx.time_id, cx.observacao,
              cx.criado_em, cx.decidido_em,
              conta.nome AS conta_nome, conta.email AS conta_email,
              COALESCE(j.nome, t.nome) AS alvo_nome,
              COALESCE(tj.nome, t.nome) AS time_nome
       FROM conexoes_atleta cx
       JOIN contas conta ON conta.id = cx.conta_id
       LEFT JOIN jogadores j ON j.id = cx.jogador_id
       LEFT JOIN times t ON t.id = cx.time_id
       LEFT JOIN times tj ON tj.id = j.time_id
       WHERE cx.campeonato_id = ? AND cx.status != 'recusada'
       ORDER BY cx.status = 'pendente' DESC, cx.criado_em`,
    )
    .all(campeonato.id);

  const tamanho = tamanhoDaVariante(campeonato.modalidade);
  const aprovadasPorTime = new Map();
  for (const l of linhas) {
    if (l.status === 'aprovada' && l.alvo_tipo === 'time') {
      aprovadasPorTime.set(l.time_id, (aprovadasPorTime.get(l.time_id) ?? 0) + 1);
    }
  }
  const item = (l) => ({
    id: l.id,
    status: l.status,
    alvo_tipo: l.alvo_tipo,
    alvo_nome: l.alvo_nome,
    time_nome: l.time_nome,
    conta_nome: l.conta_nome,
    conta_email: mascararEmail(l.conta_email),
    observacao: l.observacao,
    criado_em: l.criado_em,
    decidido_em: l.decidido_em,
    // EF 3.4: mais conexoes ao time do que a variante sugere (2 em 2x2, 1 em
    // 1x1) — so alerta, quem controla e a aprovacao do dono.
    aviso_variante: l.alvo_tipo === 'time' && tamanho != null
      && (aprovadasPorTime.get(l.time_id) ?? 0) + (l.status === 'pendente' ? 1 : 0) > tamanho,
  });
  return {
    pendentes: linhas.filter((l) => l.status === 'pendente').map(item),
    conectados: linhas.filter((l) => l.status === 'aprovada').map(item),
  };
}

// Dono aprova ou recusa uma solicitacao pendente (RN-AT-05).
export function decidirConexao(db, campeonato, conexaoId, acao, decididoPor) {
  if (!['aprovar', 'recusar'].includes(acao)) throw erroValidacao('Acao invalida: use aprovar ou recusar.');
  const cx = db
    .prepare("SELECT * FROM conexoes_atleta WHERE id = ? AND campeonato_id = ? AND status = 'pendente'")
    .get(Number(conexaoId), campeonato.id);
  if (!cx) throw erroNaoEncontrado('Solicitacao pendente nao encontrada.');
  if (acao === 'aprovar' && jogadorJaReivindicado(db, cx.jogador_id)) {
    // Duas solicitacoes pendentes pro mesmo jogador: a primeira aprovada vence
    // (o indice unico garante; aqui a mensagem fica amigavel).
    throw erroConflito('Este jogador ja foi conectado a outra conta. Recuse esta solicitacao.');
  }
  db.prepare(
    "UPDATE conexoes_atleta SET status = ?, decidido_por = ?, decidido_em = datetime('now') WHERE id = ?",
  ).run(acao === 'aprovar' ? 'aprovada' : 'recusada', decididoPor, cx.id);
  // Aprovacao em copa JA encerrada: congela na hora (fase D) — o painel de
  // copa encerrada le do snapshot, e este atleta acabou de ganhar o dele.
  if (acao === 'aprovar' && campeonato.encerrado_em) congelarConexao(db, cx.id);
  return db.prepare('SELECT * FROM conexoes_atleta WHERE id = ?').get(cx.id);
}

// Dono aprova TODAS as solicitacoes pendentes de uma vez (EF Notificacoes, fase
// C / RN-NT-10). Idempotente: aprova so o que ainda esta pendente. Reaproveita
// decidirConexao (mesmas invariantes: exclusividade do jogador, congelamento em
// copa encerrada). Um conflito (dois pedidos pro mesmo jogador) NAO aborta o
// lote — aprova o resto e devolve a contagem de ignoradas para o dono resolver.
export function aprovarTodasConexoes(db, campeonato, decididoPor) {
  const pendentes = db
    .prepare("SELECT id FROM conexoes_atleta WHERE campeonato_id = ? AND status = 'pendente' ORDER BY id")
    .all(campeonato.id);
  let aprovadas = 0;
  let ignoradas = 0;
  for (const { id } of pendentes) {
    try {
      decidirConexao(db, campeonato, id, 'aprovar', decididoPor);
      aprovadas += 1;
    } catch {
      ignoradas += 1; // jogador ja reivindicado / resolvida no intervalo
    }
  }
  return { aprovadas, ignoradas };
}

// Dono revoga uma conexao aprovada (aprovacao errada, RN-AT-06): a linha some,
// o jogador volta a ficar disponivel e o historico congelado da copa e
// REMOVIDO do perfil — a premissa e que a conexao era indevida (pessoa
// errada); manter o numero seria manter uma fraude (EF 5.1).
export function revogarConexao(db, campeonato, conexaoId) {
  const cx = db
    .prepare("SELECT * FROM conexoes_atleta WHERE id = ? AND campeonato_id = ? AND status = 'aprovada'")
    .get(Number(conexaoId), campeonato.id);
  if (!cx) throw erroNaoEncontrado('Conexao aprovada nao encontrada.');
  db.prepare('DELETE FROM conexoes_atleta WHERE id = ?').run(cx.id);
  apagarCongelado(db, cx.conta_id, campeonato.id);
  return { ok: true };
}

// Contagem de pendentes para o badge da aba Atletas (so o dono ve).
export function contarPendentes(db, campeonatoId) {
  return db
    .prepare("SELECT COUNT(*) AS n FROM conexoes_atleta WHERE campeonato_id = ? AND status = 'pendente'")
    .get(campeonatoId).n;
}
