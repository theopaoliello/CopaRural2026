// Testes da classificacao derivada, desempates e ultimos 5 jogos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcularClassificacao, cartoesPorTime, estatisticasJogadores } from '../src/classificacao.js';

const times = [
  { id: 1, nome: 'Alfa' },
  { id: 2, nome: 'Bravo' },
  { id: 3, nome: 'Charlie' },
];

const jogo = (id, rodada, casa, fora, gc, gf, status = 'encerrado') => ({
  id, rodada, time_casa_id: casa, time_fora_id: fora, gols_casa: gc, gols_fora: gf, status,
});

test('classificacao basica: pontos, saldo e posicoes', () => {
  const jogos = [
    jogo(1, 1, 1, 2, 3, 0), // Alfa 3x0 Bravo
    jogo(2, 1, 3, 1, 1, 1), // Charlie 1x1 Alfa
    jogo(3, 2, 2, 3, 0, 2), // Bravo 0x2 Charlie
  ];
  const tab = calcularClassificacao(times, jogos);
  // Charlie: E(1x1) + V(2x0) = 4 pts, SG +2 | Alfa: V(3x0) + E = 4 pts, SG +3
  // Alfa tem mais saldo -> 1o lugar
  assert.equal(tab[0].nome, 'Alfa');
  assert.equal(tab[0].pts, 4);
  assert.equal(tab[0].sg, 3);
  assert.equal(tab[1].nome, 'Charlie');
  assert.equal(tab[2].nome, 'Bravo');
  assert.equal(tab[2].pts, 0);
  assert.equal(tab[0].pos, 1);
});

test('jogos agendados nao contam', () => {
  const jogos = [jogo(1, 1, 1, 2, 3, 0, 'agendado')];
  const tab = calcularClassificacao(times, jogos);
  assert.ok(tab.every((l) => l.pj === 0 && l.pts === 0));
});

test('a ordem dos criterios de desempate muda a tabela', () => {
  // Alfa: 1V 1D (3 pts, SG -1) | Bravo: 3E (3 pts, SG 0)
  const quatro = [{ id: 1, nome: 'Alfa' }, { id: 2, nome: 'Bravo' }, { id: 3, nome: 'Charlie' }, { id: 4, nome: 'Delta' }];
  const jogos = [
    jogo(1, 1, 1, 3, 1, 0), // Alfa V
    jogo(2, 2, 4, 1, 2, 0), // Alfa D (SG -1)
    jogo(3, 1, 2, 4, 0, 0), // Bravo E
    jogo(4, 2, 2, 3, 1, 1), // Bravo E
    jogo(5, 3, 3, 2, 2, 2), // Bravo E (SG 0)
  ];
  const porVitorias = calcularClassificacao(quatro, jogos, { criterios: ['vitorias'] });
  const porSaldo = calcularClassificacao(quatro, jogos, { criterios: ['saldo'] });
  const pos = (tab, nome) => tab.find((l) => l.nome === nome).pos;
  assert.equal(porVitorias.find((l) => l.nome === 'Alfa').pts, 3);
  assert.equal(porVitorias.find((l) => l.nome === 'Bravo').pts, 3);
  assert.ok(pos(porVitorias, 'Alfa') < pos(porVitorias, 'Bravo'), 'com "vitorias", Alfa na frente');
  assert.ok(pos(porSaldo, 'Bravo') < pos(porSaldo, 'Alfa'), 'com "saldo", Bravo na frente');
});

test('desempate por confronto direto', () => {
  const quatro = [{ id: 1, nome: 'Alfa' }, { id: 2, nome: 'Bravo' }, { id: 3, nome: 'Charlie' }, { id: 4, nome: 'Delta' }];
  const jogos = [
    jogo(1, 1, 1, 2, 2, 0), // Alfa vence Bravo no confronto direto
    jogo(2, 2, 1, 3, 0, 2), // Alfa perde de Charlie
    jogo(3, 3, 2, 4, 2, 0), // Bravo vence Delta
  ];
  // Alfa e Bravo: 3 pts cada, 1V cada, mesmo SG (+-0? Alfa: gp2 gc2 sg0; Bravo: gp2 gc2 sg0), mesmos gols pro
  const tab = calcularClassificacao(quatro, jogos, { criterios: ['vitorias', 'saldo', 'gols_pro', 'confronto'] });
  const alfa = tab.find((l) => l.nome === 'Alfa');
  const bravo = tab.find((l) => l.nome === 'Bravo');
  assert.equal(alfa.pts, bravo.pts);
  assert.equal(alfa.sg, bravo.sg);
  assert.ok(alfa.pos < bravo.pos, 'Alfa venceu o confronto direto e fica na frente');
});

test('desempate por cartoes (menos cartoes fica na frente)', () => {
  const dois = [{ id: 1, nome: 'Alfa' }, { id: 2, nome: 'Bravo' }];
  const jogos = [jogo(1, 1, 1, 2, 1, 1)];
  const eventos = [
    { jogo_id: 1, time_id: 1, tipo: 'amarelo' },
    { jogo_id: 1, time_id: 1, tipo: 'vermelho' },
    { jogo_id: 1, time_id: 2, tipo: 'amarelo' },
  ];
  const tab = calcularClassificacao(dois, jogos, {
    criterios: ['cartoes'],
    cartoesPorTime: cartoesPorTime(eventos),
  });
  assert.equal(tab[0].nome, 'Bravo'); // menos pontos de cartao
});

test('ultimos 5 jogos: sequencia correta e limitada a 5', () => {
  const dois = [{ id: 1, nome: 'Alfa' }, { id: 2, nome: 'Bravo' }];
  const jogos = [
    jogo(1, 1, 1, 2, 1, 0), // V
    jogo(2, 2, 2, 1, 2, 0), // D (Alfa fora)
    jogo(3, 3, 1, 2, 0, 0), // E
    jogo(4, 4, 1, 2, 2, 1), // V
    jogo(5, 5, 2, 1, 0, 3), // V (Alfa fora)
    jogo(6, 6, 1, 2, 0, 1), // D
  ];
  const tab = calcularClassificacao(dois, jogos);
  const alfa = tab.find((l) => l.nome === 'Alfa');
  // 6 resultados: V D E V V D -> ultimos 5: D E V V D
  assert.deepEqual(alfa.ultimos, ['D', 'E', 'V', 'V', 'D']);
});

test('pontuacao customizada (vitoria = 2)', () => {
  const dois = [{ id: 1, nome: 'Alfa' }, { id: 2, nome: 'Bravo' }];
  const tab = calcularClassificacao(dois, [jogo(1, 1, 1, 2, 1, 0)], { pontosVitoria: 2 });
  assert.equal(tab[0].pts, 2);
});

test('estatisticas de jogadores agregam gols e cartoes', () => {
  const stats = estatisticasJogadores([
    { jogador_id: 7, tipo: 'gol' },
    { jogador_id: 7, tipo: 'gol' },
    { jogador_id: 7, tipo: 'amarelo' },
    { jogador_id: 9, tipo: 'vermelho' },
    { jogador_id: null, tipo: 'gol' }, // gol sem autor nao quebra
  ]);
  assert.equal(stats.get(7).gols, 2);
  assert.equal(stats.get(7).amarelos, 1);
  assert.equal(stats.get(9).vermelhos, 1);
});
