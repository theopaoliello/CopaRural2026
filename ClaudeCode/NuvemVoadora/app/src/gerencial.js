// Visao gerencial: indicadores do dashboard e datasets dos relatorios .xlsx.
// Tudo derivado por consulta — nada e persistido aqui.
import { OS, PARTE } from './estados.js';
import { agoraISO, addDiasISO, diffDias } from './datas.js';

const OS_FECHADAS = [OS.DESPACHADA, OS.ENCERRADA, OS.CANCELADA];
const ORDEM_STATUS = [
  OS.ABERTA, OS.PENDENTE, OS.LIBERADA_SEPARACAO, OS.EM_SEPARACAO,
  OS.PRONTA_DESPACHO, OS.DESPACHADA, OS.ENCERRADA, OS.CANCELADA,
];

function fmtDataBR(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short',
  });
}

function itensTexto(db, parteId) {
  return db
    .prepare('SELECT descricao, quantidade FROM item WHERE parte_id = ? ORDER BY id')
    .all(parteId)
    .map((i) => `${i.quantidade}× ${i.descricao}`)
    .join('; ');
}

// ---------------------------------------------------------------- Indicadores

export function indicadores(db, agora = agoraISO()) {
  // 1) Total de ordens por status (ordem do fluxo, so status presentes).
  const porStatusMapa = new Map(
    db.prepare('SELECT status, COUNT(*) AS n FROM ordem_servico GROUP BY status')
      .all()
      .map((r) => [r.status, r.n]),
  );
  const por_status = ORDEM_STATUS.filter((s) => porStatusMapa.has(s)).map((s) => ({
    status: s,
    total: porStatusMapa.get(s),
  }));

  // KPIs
  const umNum = (sql, ...p) => db.prepare(sql).get(...p).n;
  const atrasadas = umNum(
    `SELECT COUNT(DISTINCT p.os_id) AS n
       FROM parte p JOIN ordem_servico o ON o.id = p.os_id
      WHERE p.status = ? AND p.prazo_limite IS NOT NULL AND p.prazo_limite < ?
        AND o.status <> ?`,
    PARTE.AGUARDANDO, agora, OS.CANCELADA,
  );
  const partes_no_hub = umNum(
    `SELECT COUNT(*) AS n
       FROM parte p JOIN ordem_servico o ON o.id = p.os_id
      WHERE p.status IN (?, ?) AND o.status NOT IN (?, ?, ?)`,
    PARTE.RECEBIDA, PARTE.CONSOLIDADA, ...OS_FECHADAS,
  );
  const partes_a_receber = umNum(
    `SELECT COUNT(*) AS n
       FROM parte p JOIN ordem_servico o ON o.id = p.os_id
      WHERE p.status = ? AND o.status <> ?`,
    PARTE.AGUARDANDO, OS.CANCELADA,
  );
  const ordens_ativas = umNum(
    `SELECT COUNT(*) AS n FROM ordem_servico WHERE status NOT IN (?, ?, ?)`,
    ...OS_FECHADAS,
  );
  const leadRow = db
    .prepare(
      `SELECT AVG(julianday(pronta_em) - julianday(aberta_em)) AS media
         FROM ordem_servico WHERE pronta_em IS NOT NULL`,
    )
    .get();
  const lead_time_medio = leadRow.media === null ? null : Math.round(leadRow.media * 10) / 10;

  // 2) Ordens finalizadas (prontas p/ despacho) nos ultimos 20 dias,
  //    empilhado: em dia × com atraso (teve parte recebida fora do prazo).
  const inicio20 = addDiasISO(agora, -19).slice(0, 10);
  const finalizadas = db
    .prepare(
      `SELECT substr(o.pronta_em, 1, 10) AS dia,
              SUM(CASE WHEN EXISTS (SELECT 1 FROM atraso_historico h WHERE h.os_id = o.id)
                       THEN 1 ELSE 0 END) AS com_atraso,
              SUM(CASE WHEN EXISTS (SELECT 1 FROM atraso_historico h WHERE h.os_id = o.id)
                       THEN 0 ELSE 1 END) AS em_dia
         FROM ordem_servico o
        WHERE o.pronta_em IS NOT NULL AND substr(o.pronta_em, 1, 10) >= ?
        GROUP BY dia`,
    )
    .all(inicio20);
  const porDia = new Map(finalizadas.map((r) => [r.dia, r]));
  const finalizadas_20d = [];
  for (let i = 19; i >= 0; i--) {
    const dia = addDiasISO(agora, -i).slice(0, 10);
    const r = porDia.get(dia);
    finalizadas_20d.push({ dia, em_dia: r?.em_dia ?? 0, com_atraso: r?.com_atraso ?? 0 });
  }

  // 3) Partes a receber por loja (top pendencias), empilhado: no prazo × atrasadas.
  const a_receber_por_loja = db
    .prepare(
      `SELECT l.nome AS loja, l.cidade_uf,
              SUM(CASE WHEN p.prazo_limite IS NOT NULL AND p.prazo_limite < ? THEN 1 ELSE 0 END) AS atrasadas,
              SUM(CASE WHEN p.prazo_limite IS NULL OR p.prazo_limite >= ? THEN 1 ELSE 0 END) AS no_prazo,
              COUNT(*) AS total
         FROM parte p
         JOIN loja l ON l.id = p.loja_id
         JOIN ordem_servico o ON o.id = p.os_id
        WHERE p.status = ? AND o.status <> ?
        GROUP BY l.id
        ORDER BY total DESC, atrasadas DESC
        LIMIT 8`,
    )
    .all(agora, agora, PARTE.AGUARDANDO, OS.CANCELADA);

  // 5) Top lojas por mes (numero de partes nos ultimos 6 meses).
  //    Top 5 lojas do periodo ganham serie propria; o resto vira "Outras".
  const inicio6m = addDiasISO(agora, -183).slice(0, 7);
  const porLojaMes = db
    .prepare(
      `SELECT substr(o.aberta_em, 1, 7) AS mes, l.nome AS loja, COUNT(*) AS n
         FROM parte p
         JOIN loja l ON l.id = p.loja_id
         JOIN ordem_servico o ON o.id = p.os_id
        WHERE substr(o.aberta_em, 1, 7) >= ? AND o.status <> ?
        GROUP BY mes, l.id
        ORDER BY mes`,
    )
    .all(inicio6m, OS.CANCELADA);

  const meses = [...new Set(porLojaMes.map((r) => r.mes))].sort();
  const totalPorLoja = new Map();
  for (const r of porLojaMes) totalPorLoja.set(r.loja, (totalPorLoja.get(r.loja) ?? 0) + r.n);
  const topLojas = [...totalPorLoja.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([l]) => l);

  const series = topLojas.map((loja) => ({ loja, valores: meses.map(() => 0) }));
  const outras = { loja: 'Outras', valores: meses.map(() => 0) };
  for (const r of porLojaMes) {
    const idx = meses.indexOf(r.mes);
    const serie = series.find((s) => s.loja === r.loja);
    if (serie) serie.valores[idx] += r.n;
    else outras.valores[idx] += r.n;
  }
  if (outras.valores.some((v) => v > 0)) series.push(outras);

  return {
    kpis: { ordens_ativas, atrasadas, partes_no_hub, partes_a_receber, lead_time_medio },
    por_status,
    finalizadas_20d,
    a_receber_por_loja,
    lojas_por_mes: { meses, series },
  };
}

// ---------------------------------------------------------------- Relatorios
// Cada relatorio devolve { arquivo, abas: [{ nome, colunas, linhas }] },
// pronto para o gerador xlsx.

const COL = (titulo, largura) => (largura ? { titulo, largura } : { titulo });

// 1) Inventario total no HUB: toda parte fisicamente dentro do HUB
//    (RECEBIDA ou CONSOLIDADA em OS ainda nao despachada).
export function relatorioInventario(db, agora = agoraISO()) {
  const linhas = db
    .prepare(
      `SELECT p.id, p.codigo_barras, p.status, p.recebida_em, p.recebida_por, p.consolidada_em,
              o.codigo AS os_codigo, o.status AS os_status, o.cliente_nome, o.cliente_uf, o.escaninho,
              l.nome AS loja_nome, l.cidade_uf AS loja_cidade
         FROM parte p
         JOIN ordem_servico o ON o.id = p.os_id
         JOIN loja l ON l.id = p.loja_id
        WHERE p.status IN ('RECEBIDA', 'CONSOLIDADA')
          AND o.status NOT IN ('DESPACHADA', 'ENCERRADA', 'CANCELADA')
        ORDER BY p.recebida_em`,
    )
    .all()
    .map((p) => [
      p.codigo_barras,
      p.os_codigo,
      p.os_status,
      p.status,
      p.loja_nome,
      p.loja_cidade,
      p.cliente_nome,
      p.cliente_uf,
      p.escaninho,
      itensTexto(db, p.id),
      fmtDataBR(p.recebida_em),
      p.recebida_por,
      fmtDataBR(p.consolidada_em),
      p.recebida_em ? diffDias(agora, p.recebida_em) : null,
    ]);
  return {
    arquivo: 'inventario-hub.xlsx',
    abas: [{
      nome: 'Inventário no HUB',
      colunas: [
        COL('Pacote'), COL('OS'), COL('Status OS'), COL('Status Pacote'),
        COL('Loja'), COL('Cidade/UF Loja'), COL('Cliente'), COL('UF'),
        COL('Escaninho'), COL('Conteúdo', 40), COL('Recebido em'),
        COL('Recebido por'), COL('Consolidado em'), COL('Dias no HUB'),
      ],
      linhas,
    }],
  };
}

// 2) Partes a receber: tudo que as lojas ainda precisam enviar.
export function relatorioPartesAReceber(db, agora = agoraISO()) {
  const linhas = db
    .prepare(
      `SELECT p.id, p.codigo_barras, p.prazo_limite,
              o.codigo AS os_codigo, o.cliente_nome, o.cliente_uf, o.aberta_em,
              l.nome AS loja_nome, l.cidade_uf AS loja_cidade, l.janela_dias
         FROM parte p
         JOIN ordem_servico o ON o.id = p.os_id
         JOIN loja l ON l.id = p.loja_id
        WHERE p.status = 'AGUARDANDO' AND o.status <> 'CANCELADA'
        ORDER BY p.prazo_limite`,
    )
    .all()
    .map((p) => {
      const diasParaPrazo = p.prazo_limite ? diffDias(p.prazo_limite, agora) : null;
      let situacao = 'No prazo';
      if (diasParaPrazo !== null && diasParaPrazo < 0) situacao = 'ATRASADA';
      else if (diasParaPrazo !== null && diasParaPrazo <= 2) situacao = 'Em risco (≤2 dias)';
      return [
        p.codigo_barras,
        p.os_codigo,
        p.loja_nome,
        p.loja_cidade,
        p.janela_dias,
        p.cliente_nome,
        p.cliente_uf,
        itensTexto(db, p.id),
        fmtDataBR(p.aberta_em),
        fmtDataBR(p.prazo_limite),
        situacao,
        diasParaPrazo !== null && diasParaPrazo < 0 ? -diasParaPrazo : null,
      ];
    });
  return {
    arquivo: 'partes-a-receber.xlsx',
    abas: [{
      nome: 'Partes a receber',
      colunas: [
        COL('Pacote'), COL('OS'), COL('Loja'), COL('Cidade/UF Loja'),
        COL('Janela (dias)'), COL('Cliente'), COL('UF'), COL('Conteúdo', 40),
        COL('OS aberta em'), COL('Prazo limite'), COL('Situação'), COL('Dias de atraso'),
      ],
      linhas,
    }],
  };
}

// 3) Ordens de servico: visao completa com datas e lead time.
export function relatorioOrdens(db, agora = agoraISO()) {
  const linhas = db
    .prepare(
      `SELECT o.*, COUNT(p.id) AS total_partes,
              SUM(CASE WHEN p.status <> 'AGUARDANDO' THEN 1 ELSE 0 END) AS recebidas,
              SUM(CASE WHEN p.status = 'AGUARDANDO' AND p.prazo_limite IS NOT NULL
                            AND p.prazo_limite < ? THEN 1 ELSE 0 END) AS partes_atrasadas,
              (SELECT COUNT(*) FROM atraso_historico h WHERE h.os_id = o.id) AS atrasos_hist
         FROM ordem_servico o
         LEFT JOIN parte p ON p.os_id = o.id
        GROUP BY o.id
        ORDER BY o.aberta_em DESC`,
    )
    .all(agora)
    .map((o) => [
      o.codigo,
      o.cliente_nome,
      o.cliente_uf,
      o.status,
      o.total_partes,
      o.recebidas,
      o.partes_atrasadas > 0 ? 'Sim' : 'Não',
      o.atrasos_hist > 0 ? 'Sim' : 'Não',
      fmtDataBR(o.aberta_em),
      fmtDataBR(o.liberada_em),
      fmtDataBR(o.pronta_em),
      fmtDataBR(o.despachada_em),
      o.rastreio_postagem,
      o.pronta_em ? diffDias(o.pronta_em, o.aberta_em) : null,
    ]);
  return {
    arquivo: 'ordens-de-servico.xlsx',
    abas: [{
      nome: 'Ordens de Serviço',
      colunas: [
        COL('OS'), COL('Cliente'), COL('UF'), COL('Status'), COL('Partes'),
        COL('Recebidas'), COL('Atraso em aberto'), COL('Teve atraso'),
        COL('Aberta em'), COL('Liberada em'), COL('Pronta em'), COL('Despachada em'),
        COL('Rastreio transportadora'), COL('Lead time (dias)'),
      ],
      linhas,
    }],
  };
}

// 4) SLA das lojas: resumo por loja + detalhe de cada pacote atrasado.
export function relatorioAtrasosLojas(db) {
  const resumo = db
    .prepare(
      `SELECT l.nome, l.cidade_uf, COUNT(*) AS total,
              MAX(h.dias_atraso) AS max_dias,
              ROUND(AVG(h.dias_atraso), 1) AS media_dias
         FROM atraso_historico h JOIN loja l ON l.id = h.loja_id
        GROUP BY l.id
        ORDER BY total DESC, max_dias DESC`,
    )
    .all()
    .map((r) => [r.nome, r.cidade_uf, r.total, r.max_dias, r.media_dias]);

  const detalhe = db
    .prepare(
      `SELECT l.nome AS loja, h.codigo_parte, o.codigo AS os_codigo, o.cliente_nome,
              h.prazo_limite, h.recebida_em, h.dias_atraso
         FROM atraso_historico h
         JOIN loja l ON l.id = h.loja_id
         JOIN ordem_servico o ON o.id = h.os_id
        ORDER BY h.registrado_em DESC`,
    )
    .all()
    .map((r) => [
      r.loja, r.codigo_parte, r.os_codigo, r.cliente_nome,
      fmtDataBR(r.prazo_limite), fmtDataBR(r.recebida_em), r.dias_atraso,
    ]);

  return {
    arquivo: 'atrasos-por-loja.xlsx',
    abas: [
      {
        nome: 'Resumo por loja',
        colunas: [
          COL('Loja'), COL('Cidade/UF'), COL('Total de atrasos'),
          COL('Maior atraso (dias)'), COL('Atraso médio (dias)'),
        ],
        linhas: resumo,
      },
      {
        nome: 'Detalhe dos atrasos',
        colunas: [
          COL('Loja'), COL('Pacote'), COL('OS'), COL('Cliente'),
          COL('Prazo limite'), COL('Recebido em'), COL('Dias de atraso'),
        ],
        linhas: detalhe,
      },
    ],
  };
}

export const RELATORIOS = Object.freeze({
  inventario: relatorioInventario,
  'partes-a-receber': relatorioPartesAReceber,
  ordens: relatorioOrdens,
  'atrasos-lojas': relatorioAtrasosLojas,
});
