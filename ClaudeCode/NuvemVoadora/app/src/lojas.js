// Cadastro de lojas parceiras.
import { agoraISO } from './datas.js';
import { tokenLoja } from './codigos.js';
import { ErroValidacao } from './erros.js';

export function listarLojas(db, { incluirInativas = false } = {}) {
  const where = incluirInativas ? '' : 'WHERE ativo = 1';
  return db.prepare(`SELECT * FROM loja ${where} ORDER BY nome`).all();
}

export function obterLoja(db, id) {
  return db.prepare('SELECT * FROM loja WHERE id = ?').get(id);
}

export function criarLoja(db, { nome, cidade_uf = null, janela_dias = 15 }) {
  if (!nome || !nome.trim()) throw new ErroValidacao('Nome da loja e obrigatorio.');
  if (![7, 15].includes(Number(janela_dias))) {
    throw new ErroValidacao('janela_dias deve ser 7 ou 15.');
  }
  const info = db
    .prepare('INSERT INTO loja (nome, cidade_uf, janela_dias, token, ativo, criado_em) VALUES (?, ?, ?, ?, 1, ?)')
    .run(nome.trim(), cidade_uf, Number(janela_dias), tokenLoja(), agoraISO());
  return obterLoja(db, info.lastInsertRowid);
}
