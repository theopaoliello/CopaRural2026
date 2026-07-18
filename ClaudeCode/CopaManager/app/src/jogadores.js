// Cadastro de jogadores em lote: um jogador por linha, no formato "nome,numero"
// (numero opcional). Ex.: "Theo,10" ou apenas "Junior".
import { erroValidacao } from './erros.js';
import { MAX_NOME_JOGADOR } from './campeonatos.js';

// Converte o texto do lote em [{ nome, numero }], validando linha a linha.
export function parsearLoteJogadores(texto) {
  const linhas = String(texto ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!linhas.length) throw erroValidacao('Informe pelo menos um jogador (um por linha).');

  return linhas.map((linha, i) => {
    // Divide na ULTIMA virgula: o nome pode conter virgulas, o numero nao.
    const idx = linha.lastIndexOf(',');
    let nome = linha;
    let numero = null;
    if (idx >= 0) {
      const depois = linha.slice(idx + 1).trim();
      if (/^\d+$/.test(depois)) {
        nome = linha.slice(0, idx).trim();
        numero = Number(depois);
      }
      // Virgula sem numero valido depois ("Silva, Joao"): trata a linha toda como nome.
    }
    if (!nome) throw erroValidacao(`Linha ${i + 1}: informe o nome do jogador.`);
    if (nome.length > MAX_NOME_JOGADOR) {
      throw erroValidacao(`Linha ${i + 1}: nome muito longo (limite: ${MAX_NOME_JOGADOR} caracteres).`);
    }
    return { nome, numero };
  });
}

// Insere o lote no time. Devolve os jogadores criados.
export function inserirLoteJogadores(db, timeId, texto) {
  const lote = parsearLoteJogadores(texto);
  const ins = db.prepare('INSERT INTO jogadores (time_id, nome, numero) VALUES (?, ?, ?)');
  return lote.map(({ nome, numero }) => {
    const info = ins.run(timeId, nome, numero);
    return db.prepare('SELECT * FROM jogadores WHERE id = ?').get(Number(info.lastInsertRowid));
  });
}
