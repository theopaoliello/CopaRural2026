// Portal da Loja: autenticacao por codigo de acesso (token) e painel com os
// pacotes (partes) sob responsabilidade daquela loja. A loja NUNCA ve dados
// de outras lojas — toda consulta filtra por loja_id autenticado.
import { PARTE, parteEstaAtrasada } from './estados.js';
import { agoraISO, diffDias } from './datas.js';
import { NaoAutorizado } from './erros.js';

// Valida o codigo de acesso e devolve a loja (sem expor o proprio token).
export function autenticarLoja(db, token) {
  const limpo = String(token ?? '').trim().toUpperCase();
  if (!limpo) throw new NaoAutorizado('Informe o código de acesso da loja.');
  const loja = db
    .prepare('SELECT id, nome, cidade_uf, janela_dias FROM loja WHERE token = ? AND ativo = 1')
    .get(limpo);
  if (!loja) throw new NaoAutorizado('Código de acesso inválido. Confira com o HUB Nuvem Voadora.');
  return loja;
}

// Painel da loja: resumo + todos os pacotes dela, com prazo e situacao de atraso.
// Pendentes primeiro (ordenados pelo prazo mais urgente), depois o historico.
export function painelLoja(db, lojaId, agora = agoraISO()) {
  const partes = db
    .prepare(
      `SELECT p.id, p.letra, p.codigo_barras, p.status, p.prazo_limite,
              p.recebida_em, p.consolidada_em,
              o.codigo AS os_codigo, o.status AS os_status, o.cliente_nome, o.aberta_em
         FROM parte p
         JOIN ordem_servico o ON o.id = p.os_id
        WHERE p.loja_id = ?
        ORDER BY CASE WHEN p.status = '${PARTE.AGUARDANDO}' THEN 0 ELSE 1 END,
                 p.prazo_limite ASC, p.id DESC`,
    )
    .all(lojaId);

  const atrasoHist = new Map(
    db
      .prepare('SELECT parte_id, dias_atraso FROM atraso_historico WHERE loja_id = ?')
      .all(lojaId)
      .map((h) => [h.parte_id, h.dias_atraso]),
  );

  for (const p of partes) {
    p.itens = db
      .prepare('SELECT descricao, quantidade FROM item WHERE parte_id = ? ORDER BY id')
      .all(p.id);
    p.atrasada = parteEstaAtrasada(p.status, p.prazo_limite, agora);
    p.recebida_atrasada = !p.atrasada && atrasoHist.has(p.id);
    p.dias_atraso = p.atrasada
      ? diffDias(agora, p.prazo_limite)
      : (atrasoHist.get(p.id) ?? 0);
  }

  const resumo = {
    total: partes.length,
    aguardando: partes.filter((p) => p.status === PARTE.AGUARDANDO).length,
    atrasadas: partes.filter((p) => p.atrasada).length,
    no_hub: partes.filter((p) => p.status === PARTE.RECEBIDA || p.status === PARTE.CONSOLIDADA).length,
    atrasos_registrados: atrasoHist.size,
  };

  return { resumo, partes };
}
