// Separacao / consolidacao (M6 e M8).
// Fila de OS liberadas, inicio da separacao, scan de conferencia de cada parte
// para dentro da caixa consolidada e fechamento (so com N de N partes).
import { parseCodigo } from './codigos.js';
import { OS, PARTE, validarTransicaoOS, validarTransicaoParte } from './estados.js';
import { agoraISO } from './datas.js';
import { obterOS } from './os.js';
import { ErroValidacao, NaoEncontrado, Conflito } from './erros.js';

function registrarEvento(db, e) {
  db.prepare(
    `INSERT INTO evento_scan
       (tipo, codigo_lido, os_id, parte_id, operador, resultado, mensagem, criado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(e.tipo, e.codigo_lido, e.os_id ?? null, e.parte_id ?? null, e.operador ?? null, e.resultado, e.mensagem ?? null, agoraISO());
}

// M6: fila de OS liberadas para separacao, mais antigas primeiro.
export function filaSeparacao(db) {
  return db
    .prepare(
      `SELECT o.codigo, o.cliente_nome, o.cliente_uf, o.escaninho, o.liberada_em,
              COUNT(p.id) AS total_partes
         FROM ordem_servico o
         JOIN parte p ON p.os_id = o.id
        WHERE o.status = ?
        GROUP BY o.id
        ORDER BY o.liberada_em ASC`,
    )
    .all(OS.LIBERADA_SEPARACAO);
}

// M6.3: inicia a separacao. Update condicional evita que dois operadores
// peguem a mesma OS (so um vence a corrida).
export function iniciarSeparacao(db, codigo) {
  const agora = agoraISO();
  validarTransicaoOS(OS.LIBERADA_SEPARACAO, OS.EM_SEPARACAO); // documenta a transicao
  const upd = db
    .prepare('UPDATE ordem_servico SET status = ?, atualizado_em = ? WHERE codigo = ? AND status = ?')
    .run(OS.EM_SEPARACAO, agora, codigo, OS.LIBERADA_SEPARACAO);
  if (upd.changes === 0) {
    const os = db.prepare('SELECT status FROM ordem_servico WHERE codigo = ?').get(codigo);
    if (!os) throw new NaoEncontrado(`OS não encontrada: ${codigo}`);
    throw new Conflito(`OS está ${os.status}; não pode iniciar separação.`);
  }
  return obterOS(db, codigo);
}

// M8: scan de conferencia de uma parte para dentro da caixa consolidada.
// Nunca lanca para casos de negocio; retorna { resultado, mensagem, os?, completo? }.
// resultado: OK | DUPLICADO | ALERTA (parte de outra OS) | ERRO
export function scanConsolidacao(db, codigoOSalvo, codigoLido, operador = null) {
  const os = db.prepare('SELECT id, codigo, status FROM ordem_servico WHERE codigo = ?').get(codigoOSalvo);
  if (!os) throw new NaoEncontrado(`OS não encontrada: ${codigoOSalvo}`);
  if (os.status !== OS.EM_SEPARACAO) {
    throw new Conflito(`OS está ${os.status}; inicie a separação antes de conferir.`);
  }

  const bruto = String(codigoLido ?? '').trim();
  const info = parseCodigo(bruto);
  if (!info || !info.ehParte) {
    registrarEvento(db, { tipo: 'SAIDA', codigo_lido: bruto, os_id: os.id, operador, resultado: 'ERRO', mensagem: 'Codigo invalido' });
    return { resultado: 'ERRO', mensagem: `Código inválido: ${bruto}` };
  }

  // RF-08.2: alerta se a parte pertence a OUTRA OS.
  if (info.codigoOS !== os.codigo) {
    registrarEvento(db, { tipo: 'SAIDA', codigo_lido: bruto, os_id: os.id, operador, resultado: 'ALERTA', mensagem: `Parte de outra OS (${info.codigoOS})` });
    return { resultado: 'ALERTA', mensagem: `⚠ ATENÇÃO: ${bruto} é de OUTRA OS (${info.codigoOS}). Não coloque na caixa!`, os: obterOS(db, os.codigo) };
  }

  const parte = db.prepare('SELECT * FROM parte WHERE codigo_barras = ? AND os_id = ?').get(bruto, os.id);
  if (!parte) {
    registrarEvento(db, { tipo: 'SAIDA', codigo_lido: bruto, os_id: os.id, operador, resultado: 'ERRO', mensagem: 'Parte nao pertence a OS' });
    return { resultado: 'ERRO', mensagem: `Parte ${bruto} não pertence a esta OS.`, os: obterOS(db, os.codigo) };
  }
  if (parte.status === PARTE.CONSOLIDADA) {
    registrarEvento(db, { tipo: 'SAIDA', codigo_lido: bruto, os_id: os.id, parte_id: parte.id, operador, resultado: 'DUPLICADO', mensagem: 'Ja consolidada' });
    return { resultado: 'DUPLICADO', mensagem: `Parte ${parte.letra} já estava na caixa.`, os: obterOS(db, os.codigo) };
  }
  if (parte.status !== PARTE.RECEBIDA) {
    registrarEvento(db, { tipo: 'SAIDA', codigo_lido: bruto, os_id: os.id, parte_id: parte.id, operador, resultado: 'ERRO', mensagem: `Status ${parte.status}` });
    return { resultado: 'ERRO', mensagem: `Parte ${parte.letra} está ${parte.status} — não pode consolidar.`, os: obterOS(db, os.codigo) };
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    validarTransicaoParte(parte.status, PARTE.CONSOLIDADA);
    const agora = agoraISO();
    db.prepare('UPDATE parte SET status = ?, consolidada_em = ? WHERE id = ?').run(PARTE.CONSOLIDADA, agora, parte.id);
    registrarEvento(db, { tipo: 'SAIDA', codigo_lido: bruto, os_id: os.id, parte_id: parte.id, operador, resultado: 'OK' });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  const atual = obterOS(db, os.codigo);
  const consolidadas = atual.partes.filter((p) => p.status === PARTE.CONSOLIDADA).length;
  return {
    resultado: 'OK',
    mensagem: `Parte ${parte.letra} na caixa (${consolidadas}/${atual.total_partes}).`,
    completo: consolidadas === atual.total_partes,
    os: atual,
  };
}

// M8.3/4: fecha a caixa. So conclui com TODAS as partes CONSOLIDADA.
export function finalizarSeparacao(db, codigo) {
  const os = obterOS(db, codigo);
  if (os.status !== OS.EM_SEPARACAO) {
    throw new Conflito(`OS está ${os.status}; não está em separação.`);
  }
  const consolidadas = os.partes.filter((p) => p.status === PARTE.CONSOLIDADA).length;
  if (consolidadas !== os.total_partes) {
    throw new ErroValidacao(`Faltam ${os.total_partes - consolidadas} parte(s) na caixa. Não é possível fechar.`);
  }
  validarTransicaoOS(OS.EM_SEPARACAO, OS.PRONTA_DESPACHO);
  const agora = agoraISO();
  db.prepare('UPDATE ordem_servico SET status = ?, pronta_em = ?, atualizado_em = ? WHERE id = ?')
    .run(OS.PRONTA_DESPACHO, agora, agora, os.id);
  return obterOS(db, codigo);
}
