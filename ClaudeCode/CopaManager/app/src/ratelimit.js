// Limitador de requisicoes em memoria (janela deslizante por chave/IP).
// Protege o login (forca bruta de senha) e o registro (criacao em massa).
import { erroMuitasRequisicoes } from './erros.js';

const MAX_CHAVES = 10_000; // teto de memoria: alem disso, poda geral

export function criarLimitador({ max, janelaMs, agora = () => Date.now() }) {
  const hits = new Map(); // chave -> timestamps dentro da janela

  function podar(t) {
    for (const [chave, lista] of hits) {
      const vivas = lista.filter((x) => t - x < janelaMs);
      if (vivas.length === 0) hits.delete(chave);
      else hits.set(chave, vivas);
    }
  }

  // Registra uma tentativa; devolve false quando a chave estourou o limite.
  function tentar(chave, t = agora()) {
    if (hits.size > MAX_CHAVES) podar(t);
    const lista = (hits.get(chave) ?? []).filter((x) => t - x < janelaMs);
    if (lista.length >= max) {
      hits.set(chave, lista);
      return false;
    }
    lista.push(t);
    hits.set(chave, lista);
    return true;
  }

  function middleware(req, _res, next) {
    if (!tentar(req.ip ?? 'desconhecido')) return next(erroMuitasRequisicoes());
    next();
  }

  return { tentar, middleware };
}
