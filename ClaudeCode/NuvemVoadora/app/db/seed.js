// Seed de lojas para desenvolvimento. So insere se a tabela estiver vazia.
// Baseado no pedido real de exemplo (LigaLorcana) do projeto.
import { agoraISO } from '../src/datas.js';
import { tokenLoja } from '../src/codigos.js';

const LOJAS_EXEMPLO = [
  ['Barao Geek House', 'Campinas/SP', 15],
  ['Meruru', 'Curitiba/PR', 15],
  ['Suka Toys', 'Mogi das Cruzes/SP', 15],
  ['Load or Cast', 'Caxias do Sul/RS', 15],
  ['Main Deck Card Games', 'Sao Paulo/SP', 7],
  ['SupraCard', 'Belem/PA', 15],
  ['Dominaria Cards & Games', 'Sao Paulo/SP', 7],
  ['Gradd', 'Sao Jose dos Campos/SP', 15],
  ['Reserva Game Store', null, 15],
  ['Dellos TCG', 'Balneario Camboriu/SC', 15],
];

export function seedLojas(db) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM loja').get();
  if (n > 0) return 0;
  const agora = agoraISO();
  const stmt = db.prepare(
    'INSERT INTO loja (nome, cidade_uf, janela_dias, token, ativo, criado_em) VALUES (?, ?, ?, ?, 1, ?)',
  );
  for (const [nome, cidade, janela] of LOJAS_EXEMPLO) stmt.run(nome, cidade, janela, tokenLoja(), agora);
  return LOJAS_EXEMPLO.length;
}
