// Rotas HTTP da API. Todas as respostas em JSON.
import express from 'express';
import { criarOS, obterOS, obterParte, listarOS } from '../src/os.js';
import { listarLojas, criarLoja } from '../src/lojas.js';
import { registrarRecebimento } from '../src/recebimento.js';
import { filaSeparacao, iniciarSeparacao, scanConsolidacao, finalizarSeparacao } from '../src/separacao.js';
import { osAtrasadas, partesEmRisco, desempenhoLojas } from '../src/atrasos.js';
import { OS, PARTE } from '../src/estados.js';
import { agoraISO } from '../src/datas.js';
import { ErroValidacao } from '../src/erros.js';

// Envolve um handler sincrono e encaminha erros para o middleware de erro.
const h = (fn) => (req, res, next) => {
  try {
    fn(req, res);
  } catch (e) {
    next(e);
  }
};

export function montarRotas(db) {
  const r = express.Router();

  // --- Lojas ---
  r.get('/lojas', h((req, res) => res.json(listarLojas(db))));
  r.post('/lojas', h((req, res) => res.status(201).json(criarLoja(db, req.body ?? {}))));

  // --- Ordens de Servico ---
  r.post('/os', h((req, res) => res.status(201).json(criarOS(db, req.body ?? {}))));
  r.get('/os', h((req, res) => res.json(listarOS(db, { status: req.query.status ?? null }))));
  r.get('/os/:codigo', h((req, res) => res.json(obterOS(db, req.params.codigo))));

  // --- Partes ---
  r.get('/parte/:codigo', h((req, res) => res.json(obterParte(db, req.params.codigo))));

  // --- Recebimento (scan de entrada) ---
  r.post('/recebimento/scan', h((req, res) => {
    const { codigo, operador } = req.body ?? {};
    if (!codigo) throw new ErroValidacao('Campo "codigo" é obrigatório.');
    res.json(registrarRecebimento(db, codigo, operador ?? null));
  }));

  // --- Separacao / consolidacao ---
  r.get('/fila-separacao', h((req, res) => res.json(filaSeparacao(db))));
  r.post('/separacao/:codigo/iniciar', h((req, res) => res.json(iniciarSeparacao(db, req.params.codigo))));
  r.post('/separacao/:codigo/scan', h((req, res) => {
    const { codigo, operador } = req.body ?? {};
    if (!codigo) throw new ErroValidacao('Campo "codigo" (parte lida) é obrigatório.');
    res.json(scanConsolidacao(db, req.params.codigo, codigo, operador ?? null));
  }));
  r.post('/separacao/:codigo/finalizar', h((req, res) => res.json(finalizarSeparacao(db, req.params.codigo))));

  // --- Atrasos (painel do Gestor) ---
  r.get('/atrasos', h((req, res) => res.json({
    atrasadas: osAtrasadas(db),
    em_risco: partesEmRisco(db),
    lojas: desempenhoLojas(db),
  })));

  // --- Auditoria de scans (RNF-02) ---
  r.get('/eventos', h((req, res) => {
    const limite = Math.min(Number(req.query.limite) || 100, 500);
    const eventos = db
      .prepare(
        `SELECT e.id, e.tipo, e.codigo_lido, e.operador, e.resultado, e.mensagem, e.criado_em,
                o.codigo AS os_codigo
           FROM evento_scan e
           LEFT JOIN ordem_servico o ON o.id = e.os_id
          ORDER BY e.id DESC
          LIMIT ?`,
      )
      .all(limite);
    res.json(eventos);
  }));

  // --- Resumo para o dashboard ---
  r.get('/resumo', h((req, res) => {
    const porStatus = (st) =>
      db.prepare('SELECT COUNT(*) AS n FROM ordem_servico WHERE status = ?').get(st).n;
    const atrasadas = db
      .prepare(
        `SELECT COUNT(DISTINCT p.os_id) AS n
           FROM parte p
          WHERE p.status = ? AND p.prazo_limite IS NOT NULL AND p.prazo_limite < ?`,
      )
      .get(PARTE.AGUARDANDO, agoraISO()).n;
    res.json({
      pendentes: porStatus(OS.PENDENTE),
      fila_separacao: porStatus(OS.LIBERADA_SEPARACAO),
      em_separacao: porStatus(OS.EM_SEPARACAO),
      prontas: porStatus(OS.PRONTA_DESPACHO),
      atrasadas,
    });
  }));

  return r;
}
