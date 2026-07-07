// Erros de dominio com status HTTP associado, para a camada de rotas traduzir.

export class ErroValidacao extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = 'ErroValidacao';
    this.statusCode = 400;
  }
}

export class NaoEncontrado extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = 'NaoEncontrado';
    this.statusCode = 404;
  }
}

export class NaoAutorizado extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = 'NaoAutorizado';
    this.statusCode = 401;
  }
}

export class Conflito extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = 'Conflito';
    this.statusCode = 409;
  }
}
