// Controle de atrasos (M7 / RF-07). Tudo derivado por consulta: uma parte
// AGUARDANDO cujo prazo_limite ja venceu esta atrasada; a loja daquela parte
// e a responsavel. Assim que a parte chega, o atraso some sozinho (RN-07.1).
import { PARTE } from './estados.js';
import { agoraISO, diffDias } from './datas.js';

// OSs com pelo menos uma parte atrasada, agrupadas, com a parte e loja culpadas.
export function osAtrasadas(db, agora = agoraISO()) {
  const linhas = db
    .prepare(
      `SELECT o.codigo AS os_codigo, o.cliente_nome, o.cliente_uf, o.aberta_em,
              p.letra, p.prazo_limite,
              l.id AS loja_id, l.nome AS loja_nome, l.cidade_uf AS loja_cidade_uf
         FROM parte p
         JOIN ordem_servico o ON o.id = p.os_id
         JOIN loja l ON l.id = p.loja_id
        WHERE p.status = ? AND p.prazo_limite IS NOT NULL AND p.prazo_limite < ?
        ORDER BY p.prazo_limite ASC`,
    )
    .all(PARTE.AGUARDANDO, agora);

  const porOS = new Map();
  for (const r of linhas) {
    if (!porOS.has(r.os_codigo)) {
      porOS.set(r.os_codigo, {
        codigo: r.os_codigo,
        cliente_nome: r.cliente_nome,
        cliente_uf: r.cliente_uf,
        aberta_em: r.aberta_em,
        partes_atrasadas: [],
        max_dias_atraso: 0,
      });
    }
    const g = porOS.get(r.os_codigo);
    const dias = diffDias(agora, r.prazo_limite);
    g.partes_atrasadas.push({
      letra: r.letra,
      loja_id: r.loja_id,
      loja_nome: r.loja_nome,
      loja_cidade_uf: r.loja_cidade_uf,
      prazo_limite: r.prazo_limite,
      dias_atraso: dias,
    });
    g.max_dias_atraso = Math.max(g.max_dias_atraso, dias);
  }
  return [...porOS.values()].sort((a, b) => b.max_dias_atraso - a.max_dias_atraso);
}

// Partes ainda no prazo, mas a <= diasLimite de vencer (alerta proativo, RN-07.2).
export function partesEmRisco(db, agora = agoraISO(), diasLimite = 2) {
  const limite = new Date(new Date(agora).getTime() + diasLimite * 86400000).toISOString();
  return db
    .prepare(
      `SELECT o.codigo AS os_codigo, o.cliente_nome, p.letra, p.prazo_limite,
              l.nome AS loja_nome
         FROM parte p
         JOIN ordem_servico o ON o.id = p.os_id
         JOIN loja l ON l.id = p.loja_id
        WHERE p.status = ? AND p.prazo_limite IS NOT NULL
              AND p.prazo_limite >= ? AND p.prazo_limite < ?
        ORDER BY p.prazo_limite ASC`,
    )
    .all(PARTE.AGUARDANDO, agora, limite)
    .map((r) => ({ ...r, dias_restantes: diffDias(r.prazo_limite, agora) }));
}

// Historico persistente de atrasos por loja (RF-07.3). Diferente de osAtrasadas
// (que so mostra o que ainda esta pendente), este mantem o registro mesmo apos
// a parte ser recebida, com o numero do pacote atrasado. Alimenta o SLA da loja.
export function historicoAtrasos(db) {
  const linhas = db
    .prepare(
      `SELECT h.codigo_parte, h.dias_atraso, h.prazo_limite, h.recebida_em, h.registrado_em,
              o.codigo AS os_codigo, o.cliente_nome,
              l.id AS loja_id, l.nome AS loja_nome, l.cidade_uf AS loja_cidade_uf
         FROM atraso_historico h
         JOIN ordem_servico o ON o.id = h.os_id
         JOIN loja l ON l.id = h.loja_id
        ORDER BY h.registrado_em DESC`,
    )
    .all();

  const porLoja = new Map();
  for (const r of linhas) {
    if (!porLoja.has(r.loja_id)) {
      porLoja.set(r.loja_id, {
        loja_id: r.loja_id,
        loja_nome: r.loja_nome,
        loja_cidade_uf: r.loja_cidade_uf,
        total_atrasos: 0,
        max_dias_atraso: 0,
        pacotes: [],
      });
    }
    const g = porLoja.get(r.loja_id);
    g.total_atrasos += 1;
    g.max_dias_atraso = Math.max(g.max_dias_atraso, r.dias_atraso);
    g.pacotes.push({
      codigo_parte: r.codigo_parte,
      os_codigo: r.os_codigo,
      cliente_nome: r.cliente_nome,
      dias_atraso: r.dias_atraso,
      prazo_limite: r.prazo_limite,
      recebida_em: r.recebida_em,
    });
  }
  return [...porLoja.values()].sort((a, b) => b.total_atrasos - a.total_atrasos);
}

// Ranking de lojas com partes atualmente atrasadas (alimenta SLA/penalidades, RF-07.3).
export function desempenhoLojas(db, agora = agoraISO()) {
  return db
    .prepare(
      `SELECT l.id AS loja_id, l.nome AS loja_nome, l.cidade_uf,
              SUM(CASE WHEN p.status = ? AND p.prazo_limite IS NOT NULL AND p.prazo_limite < ?
                       THEN 1 ELSE 0 END) AS partes_atrasadas
         FROM loja l
         LEFT JOIN parte p ON p.loja_id = l.id
        GROUP BY l.id
        HAVING partes_atrasadas > 0
        ORDER BY partes_atrasadas DESC`,
    )
    .all(PARTE.AGUARDANDO, agora);
}
