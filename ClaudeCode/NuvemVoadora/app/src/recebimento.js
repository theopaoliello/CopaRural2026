// Recebimento de partes no HUB via scan (M3/M4/M5).
// Registra a entrada, grava evento de auditoria e reavalia a OS: quando todas
// as partes chegam, a OS e liberada automaticamente para separacao (RN-05.1).
import { parseCodigo } from './codigos.js';
import { OS, PARTE, validarTransicaoParte, validarTransicaoOS, statusPorCompletude } from './estados.js';
import { agoraISO } from './datas.js';
import { obterOS } from './os.js';
import { ErroValidacao } from './erros.js';

function registrarEvento(db, e) {
  db.prepare(
    `INSERT INTO evento_scan
       (tipo, codigo_lido, os_id, parte_id, operador, resultado, mensagem, criado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.tipo,
    e.codigo_lido,
    e.os_id ?? null,
    e.parte_id ?? null,
    e.operador ?? null,
    e.resultado,
    e.mensagem ?? null,
    agoraISO(),
  );
}

// Reavalia a completude da OS e libera automaticamente se todas as partes
// estiverem RECEBIDA. Idempotente. NAO gerencia transacao (chamada dentro de uma).
export function reavaliarOS(db, osId) {
  const os = db.prepare('SELECT id, status FROM ordem_servico WHERE id = ?').get(osId);
  if (!os) return null;
  const statuses = db.prepare('SELECT status FROM parte WHERE os_id = ?').all(osId).map((r) => r.status);
  const alvo = statusPorCompletude(statuses);
  if (alvo === OS.LIBERADA_SEPARACAO && os.status === OS.PENDENTE) {
    validarTransicaoOS(os.status, OS.LIBERADA_SEPARACAO);
    const agora = agoraISO();
    db.prepare('UPDATE ordem_servico SET status = ?, liberada_em = ?, atualizado_em = ? WHERE id = ?')
      .run(OS.LIBERADA_SEPARACAO, agora, agora, osId);
    return OS.LIBERADA_SEPARACAO;
  }
  return os.status;
}

// Processa um scan de entrada. Nunca lanca para casos de negocio: retorna
// { resultado, mensagem, os?, liberou? } para a estacao dar feedback rapido.
// resultado: OK | DUPLICADO | ERRO
export function registrarRecebimento(db, codigoLido, operador = null) {
  const bruto = String(codigoLido ?? '').trim();
  if (!bruto) throw new ErroValidacao('Código do scan é obrigatório.');

  const info = parseCodigo(bruto);
  if (!info || !info.ehParte) {
    registrarEvento(db, { tipo: 'ENTRADA', codigo_lido: bruto, operador, resultado: 'ERRO', mensagem: 'Codigo invalido' });
    return { resultado: 'ERRO', mensagem: `Código inválido: ${bruto}` };
  }

  const codParte = `${info.codigoOS}-${info.letra}`;
  const parte = db
    .prepare(
      `SELECT p.*, o.id AS os_pk, o.codigo AS os_codigo
         FROM parte p JOIN ordem_servico o ON o.id = p.os_id
        WHERE p.codigo_barras = ?`,
    )
    .get(codParte);

  if (!parte) {
    registrarEvento(db, { tipo: 'ENTRADA', codigo_lido: codParte, operador, resultado: 'ERRO', mensagem: 'Parte nao encontrada' });
    return { resultado: 'ERRO', mensagem: `Parte não cadastrada: ${codParte}` };
  }

  if (parte.status === PARTE.RECEBIDA || parte.status === PARTE.CONSOLIDADA) {
    registrarEvento(db, { tipo: 'ENTRADA', codigo_lido: codParte, os_id: parte.os_pk, parte_id: parte.id, operador, resultado: 'DUPLICADO', mensagem: `Ja ${parte.status}` });
    return { resultado: 'DUPLICADO', mensagem: `Parte ${parte.letra} já estava ${parte.status}.`, os: obterOS(db, parte.os_codigo) };
  }

  if (parte.status !== PARTE.AGUARDANDO && parte.status !== PARTE.QUARENTENA) {
    registrarEvento(db, { tipo: 'ENTRADA', codigo_lido: codParte, os_id: parte.os_pk, parte_id: parte.id, operador, resultado: 'ERRO', mensagem: `Status ${parte.status}` });
    return { resultado: 'ERRO', mensagem: `Parte ${parte.letra} está ${parte.status} — tratar manualmente.`, os: obterOS(db, parte.os_codigo) };
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    validarTransicaoParte(parte.status, PARTE.RECEBIDA);
    const agora = agoraISO();
    db.prepare('UPDATE parte SET status = ?, recebida_em = ?, recebida_por = ? WHERE id = ?')
      .run(PARTE.RECEBIDA, agora, operador, parte.id);
    registrarEvento(db, { tipo: 'ENTRADA', codigo_lido: codParte, os_id: parte.os_pk, parte_id: parte.id, operador, resultado: 'OK' });
    const statusOS = reavaliarOS(db, parte.os_pk);
    db.exec('COMMIT');
    const os = obterOS(db, parte.os_codigo);
    return {
      resultado: 'OK',
      mensagem: `Parte ${parte.letra} recebida (${os.recebidas}/${os.total_partes}).`,
      liberou: statusOS === OS.LIBERADA_SEPARACAO,
      os,
    };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
