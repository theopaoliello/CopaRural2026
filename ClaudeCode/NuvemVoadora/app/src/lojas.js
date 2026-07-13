// Cadastro de lojas parceiras.
import { agoraISO } from './datas.js';
import { tokenLoja } from './codigos.js';
import { ErroValidacao, NaoEncontrado } from './erros.js';

// Projecao sem o token: o codigo de acesso e credencial e NAO deve circular
// em listagens da API (so via revelacao explicita — tokenDaLoja).
const COLS_PUBLICAS = 'id, nome, cidade_uf, janela_dias, ativo, criado_em';

export function listarLojas(db, { incluirInativas = false } = {}) {
  const where = incluirInativas ? '' : 'WHERE ativo = 1';
  return db.prepare(`SELECT ${COLS_PUBLICAS} FROM loja ${where} ORDER BY nome`).all();
}

// Uso interno (dominio); inclui o token — nunca devolver direto na API.
export function obterLoja(db, id) {
  return db.prepare('SELECT * FROM loja WHERE id = ?').get(id);
}

// Revelacao explicita do codigo de acesso (tela de lojas, sob demanda).
export function tokenDaLoja(db, id) {
  const loja = db.prepare('SELECT token FROM loja WHERE id = ? AND ativo = 1').get(id);
  if (!loja) throw new NaoEncontrado(`Loja inexistente: ${id}`);
  return loja.token;
}

export function criarLoja(db, { nome, cidade_uf = null, janela_dias = 15 }) {
  if (!nome || !nome.trim()) throw new ErroValidacao('Nome da loja e obrigatorio.');
  if (![7, 15].includes(Number(janela_dias))) {
    throw new ErroValidacao('janela_dias deve ser 7 ou 15.');
  }
  const info = db
    .prepare('INSERT INTO loja (nome, cidade_uf, janela_dias, token, ativo, criado_em) VALUES (?, ?, ?, ?, 1, ?)')
    .run(nome.trim(), cidade_uf, Number(janela_dias), tokenLoja(), agoraISO());
  // Resposta sem o token (revelacao apenas via tokenDaLoja).
  return db
    .prepare(`SELECT ${COLS_PUBLICAS} FROM loja WHERE id = ?`)
    .get(info.lastInsertRowid);
}
