// Central de notificacoes (EF Notificacoes e Atalho do Atleta, fase B).
// As notificacoes sao DERIVADAS do estado atual (RN-NT-08): nada e armazenado.
// No MVP existe um unico tipo — solicitacoes de conexao de atleta PENDENTES,
// agrupadas por copa da qual a conta e DONA (RN-NT-06/12). O estado de "lido"
// vive no cliente (localStorage, RN-NT-09); o servidor so descreve a realidade.

export function notificacoesDaConta(db, contaId) {
  // Uma linha por copa do dono com >= 1 solicitacao pendente; a mais recente
  // primeiro. `atualizado_em` = criacao da solicitacao pendente mais nova
  // (serve ao contador de nao lidas no cliente).
  const linhas = db
    .prepare(
      `SELECT c.id AS campeonato_id, c.nome AS campeonato_nome, c.temporada,
              COUNT(*) AS contagem, MAX(cx.criado_em) AS atualizado_em
         FROM conexoes_atleta cx
         JOIN campeonatos c ON c.id = cx.campeonato_id
        WHERE c.conta_id = ? AND cx.status = 'pendente'
        GROUP BY c.id
        ORDER BY atualizado_em DESC, c.id DESC`,
    )
    .all(contaId);

  const itens = linhas.map((l) => ({
    tipo: 'conexao_pendente',
    campeonato_id: l.campeonato_id,
    titulo: l.campeonato_nome,
    temporada: l.temporada,
    contagem: l.contagem,
    atualizado_em: l.atualizado_em,
    texto:
      l.contagem === 1
        ? '1 solicitação de atleta pendente'
        : `${l.contagem} solicitações de atletas pendentes`,
  }));

  return { itens };
}
