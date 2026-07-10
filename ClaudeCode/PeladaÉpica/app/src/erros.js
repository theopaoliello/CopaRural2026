// Erros de dominio com status HTTP, traduzidos pelo middleware do server.
export class ErroDominio extends Error {
  constructor(mensagem, statusCode = 400, nome = 'ErroDominio') {
    super(mensagem);
    this.name = nome;
    this.statusCode = statusCode;
  }
}

export const erroValidacao = (msg) => new ErroDominio(msg, 400, 'ErroValidacao');
export const erroNaoAutenticado = (msg = 'Faca login para continuar.') =>
  new ErroDominio(msg, 401, 'ErroNaoAutenticado');
export const erroProibido = (msg = 'Voce nao tem acesso a este recurso.') =>
  new ErroDominio(msg, 403, 'ErroProibido');
export const erroNaoEncontrado = (msg = 'Recurso nao encontrado.') =>
  new ErroDominio(msg, 404, 'ErroNaoEncontrado');
export const erroConflito = (msg) => new ErroDominio(msg, 409, 'ErroConflito');
