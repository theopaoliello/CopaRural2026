// Ordem de Servico: criacao (M1/M2), leitura e listagem.
import { incrementarSeqOS } from '../db/db.js';
import { codigoOS, codigoParte, gerarLetras, parseCodigo } from './codigos.js';
import { OS, PARTE, parteEstaAtrasada, validarTransicaoOS } from './estados.js';
import { agoraISO, addDiasISO } from './datas.js';
import { obterLoja } from './lojas.js';
import { ErroValidacao, NaoEncontrado } from './erros.js';

// Dias estimados de transito loja -> HUB, somados ao fechamento da janela
// para formar o prazo-limite de chegada da parte (EF RF-02.3).
const TRANSITO_DIAS = 5;

function prazoLimiteParte({ abertaEm, janelaDias, janelaFechaEm }) {
  const base = janelaFechaEm ? janelaFechaEm : addDiasISO(abertaEm, janelaDias);
  return addDiasISO(base, TRANSITO_DIAS);
}

// Cria uma OS com suas partes. dados:
// { cliente:{nome,uf,cep}, janela_fecha_em?, prazo_cliente?, escaninho?,
//   partes:[ { loja_id, itens:[{descricao,quantidade}] } ] }
export function criarOS(db, dados) {
  const cliente = dados?.cliente ?? {};
  if (!cliente.nome || !cliente.nome.trim()) {
    throw new ErroValidacao('Nome do cliente e obrigatorio.');
  }
  const partes = Array.isArray(dados.partes) ? dados.partes : [];
  if (partes.length < 2) {
    // EF RN-01.1: pedido de loja unica nao gera OS (nao ha o que consolidar).
    throw new ErroValidacao('Uma OS precisa de pelo menos 2 partes (2 lojas distintas).');
  }
  const lojaIds = partes.map((p) => Number(p.loja_id));
  if (new Set(lojaIds).size !== lojaIds.length) {
    throw new ErroValidacao('Cada loja so pode ter uma parte na mesma OS.');
  }
  const lojas = lojaIds.map((id) => {
    const loja = obterLoja(db, id);
    if (!loja) throw new ErroValidacao(`Loja inexistente: ${id}`);
    return loja;
  });

  const ano = new Date().getFullYear();
  const abertaEm = agoraISO();
  const letras = gerarLetras(partes.length);

  db.exec('BEGIN IMMEDIATE');
  try {
    const seq = incrementarSeqOS(db, ano);
    const codigo = codigoOS(ano, seq);

    const osInfo = db
      .prepare(
        `INSERT INTO ordem_servico
          (codigo, cliente_nome, cliente_uf, cliente_cep, status, escaninho,
           janela_fecha_em, prazo_cliente, aberta_em, atualizado_em)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        codigo,
        cliente.nome.trim(),
        cliente.uf ?? null,
        cliente.cep ?? null,
        OS.PENDENTE,
        dados.escaninho ?? null,
        dados.janela_fecha_em ?? null,
        dados.prazo_cliente ?? null,
        abertaEm,
        abertaEm,
      );
    const osId = osInfo.lastInsertRowid;

    partes.forEach((p, i) => {
      const loja = lojas[i];
      const letra = letras[i];
      const cod = codigoParte(codigo, letra);
      const prazo = prazoLimiteParte({
        abertaEm,
        janelaDias: loja.janela_dias,
        janelaFechaEm: dados.janela_fecha_em,
      });
      const parteInfo = db
        .prepare(
          `INSERT INTO parte
             (os_id, letra, codigo_barras, loja_id, status, prazo_limite)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(osId, letra, cod, loja.id, PARTE.AGUARDANDO, prazo);
      const parteId = parteInfo.lastInsertRowid;

      for (const item of p.itens ?? []) {
        if (!item?.descricao || !item.descricao.trim()) continue;
        db.prepare('INSERT INTO item (parte_id, descricao, quantidade) VALUES (?, ?, ?)').run(
          parteId,
          item.descricao.trim(),
          Number(item.quantidade) > 0 ? Number(item.quantidade) : 1,
        );
      }
    });

    db.exec('COMMIT');
    return obterOS(db, codigo);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Detalhe completo de uma OS por codigo, com partes, itens e derivados.
export function obterOS(db, codigo) {
  const os = db.prepare('SELECT * FROM ordem_servico WHERE codigo = ?').get(codigo);
  if (!os) throw new NaoEncontrado(`OS nao encontrada: ${codigo}`);

  const partes = db
    .prepare(
      `SELECT p.*, l.nome AS loja_nome, l.cidade_uf AS loja_cidade_uf
         FROM parte p JOIN loja l ON l.id = p.loja_id
        WHERE p.os_id = ? ORDER BY p.letra`,
    )
    .all(os.id);

  // Atrasos ja consolidados no historico (parte que chegou apos o prazo).
  const historicoAtraso = db
    .prepare('SELECT parte_id, codigo_parte, dias_atraso, prazo_limite, recebida_em FROM atraso_historico WHERE os_id = ?')
    .all(os.id);
  const atrasoPorParte = new Map(historicoAtraso.map((h) => [h.parte_id, h]));

  const agora = agoraISO();
  for (const parte of partes) {
    parte.itens = db
      .prepare('SELECT id, descricao, quantidade FROM item WHERE parte_id = ? ORDER BY id')
      .all(parte.id);
    parte.atrasada = parteEstaAtrasada(parte.status, parte.prazo_limite, agora);
    const hist = atrasoPorParte.get(parte.id);
    parte.recebida_atrasada = !!hist;               // chegou, mas fora do prazo
    parte.dias_atraso = hist ? hist.dias_atraso : 0; // atraso registrado no recebimento
  }

  const recebidas = partes.filter((p) => p.status !== PARTE.AGUARDANDO).length;
  return {
    ...os,
    partes,
    total_partes: partes.length,
    recebidas,
    faltam: partes.length - recebidas,
    // ATRASADA cobre tanto o que ainda esta pendente e vencido quanto o que ja
    // chegou atrasado: o status de atraso permanece na ordem (RF-07.3).
    atrasada: partes.some((p) => p.atrasada) || historicoAtraso.length > 0,
    teve_atraso: historicoAtraso.length > 0,
  };
}

// Despacho (M8): PRONTA_DESPACHO -> DESPACHADA, com codigo de rastreio da
// transportadora opcional. E o que o cliente ve no rastreio publico.
export function despacharOS(db, codigo, { rastreio_postagem = null } = {}) {
  const os = db.prepare('SELECT * FROM ordem_servico WHERE codigo = ?').get(codigo);
  if (!os) throw new NaoEncontrado(`OS nao encontrada: ${codigo}`);
  validarTransicaoOS(os.status, OS.DESPACHADA);
  const agora = agoraISO();
  db.prepare(
    `UPDATE ordem_servico
        SET status = ?, despachada_em = ?, rastreio_postagem = ?, atualizado_em = ?
      WHERE id = ?`,
  ).run(OS.DESPACHADA, agora, rastreio_postagem?.trim() || null, agora, os.id);
  return obterOS(db, codigo);
}

// Encerramento: DESPACHADA -> ENCERRADA (cliente recebeu; fecha o ciclo).
export function encerrarOS(db, codigo) {
  const os = db.prepare('SELECT * FROM ordem_servico WHERE codigo = ?').get(codigo);
  if (!os) throw new NaoEncontrado(`OS nao encontrada: ${codigo}`);
  validarTransicaoOS(os.status, OS.ENCERRADA);
  const agora = agoraISO();
  db.prepare('UPDATE ordem_servico SET status = ?, atualizado_em = ? WHERE id = ?').run(
    OS.ENCERRADA,
    agora,
    os.id,
  );
  return obterOS(db, codigo);
}

export function obterParte(db, codigoBarras) {
  const info = parseCodigo(codigoBarras);
  if (!info || !info.ehParte) throw new ErroValidacao(`Codigo de parte invalido: ${codigoBarras}`);
  const parte = db
    .prepare(
      `SELECT p.*, l.nome AS loja_nome, l.cidade_uf AS loja_cidade_uf,
              o.codigo AS os_codigo, o.cliente_nome
         FROM parte p
         JOIN loja l ON l.id = p.loja_id
         JOIN ordem_servico o ON o.id = p.os_id
        WHERE p.codigo_barras = ?`,
    )
    .get(info.codigoOS + '-' + info.letra);
  if (!parte) throw new NaoEncontrado(`Parte nao encontrada: ${codigoBarras}`);
  parte.itens = db
    .prepare('SELECT id, descricao, quantidade FROM item WHERE parte_id = ? ORDER BY id')
    .all(parte.id);
  return parte;
}

// Lista OSs com contagem de partes recebidas; filtro opcional por status.
// Deriva o atraso: "em aberto" (parte AGUARDANDO vencida) e/ou "histórico"
// (parte que ja chegou fora do prazo) — o status de atraso permanece na ordem.
export function listarOS(db, { status = null } = {}) {
  const where = status ? 'WHERE o.status = ?' : '';
  const params = status ? [agoraISO(), status] : [agoraISO()];
  return db
    .prepare(
      `SELECT o.codigo, o.cliente_nome, o.cliente_uf, o.status, o.escaninho,
              o.aberta_em, o.liberada_em,
              COUNT(p.id) AS total_partes,
              SUM(CASE WHEN p.status <> 'AGUARDANDO' THEN 1 ELSE 0 END) AS recebidas,
              SUM(CASE WHEN p.status = 'AGUARDANDO' AND p.prazo_limite IS NOT NULL
                            AND p.prazo_limite < ? THEN 1 ELSE 0 END) AS partes_atrasadas,
              (SELECT COUNT(*) FROM atraso_historico h WHERE h.os_id = o.id) AS atrasos_historico
         FROM ordem_servico o
         LEFT JOIN parte p ON p.os_id = o.id
         ${where}
        GROUP BY o.id
        ORDER BY o.aberta_em DESC`,
    )
    .all(...params)
    .map((o) => ({
      ...o,
      atraso_aberto: o.partes_atrasadas > 0,
      teve_atraso: o.atrasos_historico > 0,
      atrasada: o.partes_atrasadas > 0 || o.atrasos_historico > 0,
    }));
}
