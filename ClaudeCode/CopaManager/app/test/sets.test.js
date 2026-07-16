// Fase 2 multiesporte: resultado por sets (modelo B) e classificacao derivada.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { prepararBanco } from '../db/db.js';
import { criarCampeonato } from '../src/campeonatos.js';
import { registrarResultado, apagarResultado } from '../src/jogos.js';
import { calcularClassificacaoSets } from '../src/classificacao.js';
import { pontosDaPartidaSets, obterEsporte } from '../src/esportes.js';

let db;
let contaId;

before(() => {
  db = prepararBanco(':memory:');
  contaId = Number(
    db.prepare("INSERT INTO contas (nome, email, senha_hash) VALUES ('T', 't@t.com', 'x')").run().lastInsertRowid,
  );
});

const criar = (dados) => criarCampeonato(db, contaId, {
  nome: 'Copa Sets', formato: 'pontos', sortear: false, times: ['A', 'B'], ...dados,
});
const jogoDe = (campId, casaNome, foraNome) => {
  const time = (n) => db.prepare('SELECT id FROM times WHERE campeonato_id = ? AND nome = ?').get(campId, n).id;
  return db
    .prepare('SELECT * FROM jogos WHERE campeonato_id = ? AND time_casa_id = ? AND time_fora_id = ?')
    .get(campId, time(casaNome), time(foraNome))
    ?? db
      .prepare('SELECT * FROM jogos WHERE campeonato_id = ? AND time_casa_id = ? AND time_fora_id = ?')
      .get(campId, time(foraNome), time(casaNome));
};

test('pontuacao por partida: 2/1/0 fixa e FIVB com bonus pelo set decisivo', () => {
  const fixa = { vitoria: 2, derrota: 1 };
  assert.deepEqual(pontosDaPartidaSets(fixa, 2, 0), { vencedor: 2, perdedor: 1 });
  const fivb = { tipo: 'sets_bonus' };
  assert.deepEqual(pontosDaPartidaSets(fivb, 3, 0), { vencedor: 3, perdedor: 0 });
  assert.deepEqual(pontosDaPartidaSets(fivb, 3, 1), { vencedor: 3, perdedor: 0 });
  assert.deepEqual(pontosDaPartidaSets(fivb, 3, 2), { vencedor: 2, perdedor: 1 });
  assert.deepEqual(pontosDaPartidaSets(fivb, 2, 0), { vencedor: 3, perdedor: 0 });
  assert.deepEqual(pontosDaPartidaSets(fivb, 2, 1), { vencedor: 2, perdedor: 1 });
});

test('criacao: melhor_de vem do preset, e validado, e ida/volta no mata e so do futebol', () => {
  const ftv = criar({ esporte: 'futevolei' });
  assert.equal(ftv.melhor_de, 1); // padrao amador: set unico
  assert.equal(ftv.modalidade, '2x2');
  assert.deepEqual(JSON.parse(ftv.criterios_desempate), ['vitorias', 'saldo_sets', 'saldo_pontos', 'confronto']);

  const volei = criar({ esporte: 'volei', melhor_de: 3 });
  assert.equal(volei.melhor_de, 3);

  assert.throws(() => criar({ esporte: 'volei', melhor_de: 7 }), /Formato de partida invalido/);
  assert.throws(
    () => criar({ esporte: 'peteca', criterios_desempate: ['cartoes'] }),
    /Criterios de desempate invalidos/,
  );

  // RN-TC-05: mata ida e volta ignorado fora do futebol
  const mata = criar({ esporte: 'beach_tennis', formato: 'mata', times: ['A', 'B', 'C', 'D'], ida_volta_mata: true });
  assert.equal(mata.ida_volta_mata, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jogos WHERE campeonato_id = ? AND perna = 2").get(mata.id).n, 0);
});

test('resultado por parciais: placar derivado, validacoes RN-TC-08 e limpeza ao apagar', () => {
  const camp = criar({ esporte: 'futevolei', melhor_de: 3 });
  const jogo = jogoDe(camp.id, 'A', 'B');

  // set empatado
  assert.throws(() => registrarResultado(db, jogo, { sets: [[15, 15]] }), /empatado/);
  // vencedor nao fechou a maioria
  assert.throws(() => registrarResultado(db, jogo, { sets: [[18, 16]] }), /vencedor fecha/);
  // parciais depois do jogo fechado (2-0 ja encerra melhor de 3)
  assert.throws(
    () => registrarResultado(db, jogo, { sets: [[15, 10], [15, 8], [15, 9]] }),
    /parciais sobrando/,
  );
  // penaltis e eventos nao existem no modelo B
  assert.throws(
    () => registrarResultado(db, jogo, { sets: [[15, 10], [15, 8]], penaltis_casa: 3, penaltis_fora: 1 }),
    /penaltis/,
  );
  assert.throws(
    () => registrarResultado(db, jogo, { sets: [[15, 10], [15, 8]], eventos: [{ tipo: 'gol', time_id: jogo.time_casa_id }] }),
    /eventos individuais/,
  );

  const salvo = registrarResultado(db, jogo, { sets: [[18, 16], [12, 15], [15, 13]] });
  assert.equal(salvo.gols_casa, 2);
  assert.equal(salvo.gols_fora, 1);
  assert.equal(salvo.status, 'encerrado');
  const parciais = db.prepare('SELECT * FROM sets WHERE jogo_id = ? ORDER BY numero').all(jogo.id);
  assert.equal(parciais.length, 3);
  assert.deepEqual([parciais[1].pontos_casa, parciais[1].pontos_fora], [12, 15]);

  apagarResultado(db, salvo);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sets WHERE jogo_id = ?').get(jogo.id).n, 0);
});

test('resultado simples em sets: valida maioria e rejeita empate', () => {
  const camp = criar({ esporte: 'volei', melhor_de: 5 });
  const jogo = jogoDe(camp.id, 'A', 'B');
  assert.throws(() => registrarResultado(db, jogo, { sets_casa: 2, sets_fora: 2 }), /vencedor fecha/);
  assert.throws(() => registrarResultado(db, jogo, { sets_casa: 4, sets_fora: 0 }), /vencedor fecha/);
  const salvo = registrarResultado(db, jogo, { sets_casa: 3, sets_fora: 2 });
  assert.equal(salvo.gols_casa, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sets WHERE jogo_id = ?').get(jogo.id).n, 0);
});

test('classificacao FIVB: bonus por placar de sets e razao de sets como desempate', () => {
  const times = [{ id: 1, nome: 'Alfa' }, { id: 2, nome: 'Beta' }, { id: 3, nome: 'Gama' }];
  const jogo = (id, casa, fora, gc, gf) =>
    ({ id, rodada: 1, status: 'encerrado', time_casa_id: casa, time_fora_id: fora, gols_casa: gc, gols_fora: gf });
  // Alfa 3-0 Beta | Beta 3-2 Gama | Alfa 3-1 Gama
  const jogos = [jogo(1, 1, 2, 3, 0), jogo(2, 2, 3, 3, 2), jogo(3, 1, 3, 3, 1)];
  const linhas = calcularClassificacaoSets(times, jogos, [], {
    pontuacao: { tipo: 'sets_bonus' }, melhorDe: 5,
    criterios: ['vitorias', 'razao_sets', 'razao_pontos', 'confronto'],
  });
  // Alfa 3+3=6 | Beta 0+2=2 | Gama 1+0=1
  assert.deepEqual(linhas.map((l) => [l.nome, l.pts]), [['Alfa', 6], ['Beta', 2], ['Gama', 1]]);
  assert.equal(linhas[0].sv, 6);
  assert.equal(linhas[0].sp, 1);
  assert.equal(linhas[0].saldo_sets, 5);
});

test('classificacao 2/1/0 com parciais: saldo de pontos desempata', () => {
  const times = [{ id: 1, nome: 'A' }, { id: 2, nome: 'B' }, { id: 3, nome: 'C' }, { id: 4, nome: 'D' }];
  const jogo = (id, casa, fora, gc, gf) =>
    ({ id, rodada: 1, status: 'encerrado', time_casa_id: casa, time_fora_id: fora, gols_casa: gc, gols_fora: gf });
  // A vence B 1-0 (18-16); C vence D 1-0 (18-10). A e C empatam em pts/vitorias/saldo de sets;
  // saldo de pontos poe C na frente.
  const jogos = [jogo(1, 1, 2, 1, 0), jogo(2, 3, 4, 1, 0)];
  const sets = [
    { jogo_id: 1, numero: 1, pontos_casa: 18, pontos_fora: 16 },
    { jogo_id: 2, numero: 1, pontos_casa: 18, pontos_fora: 10 },
  ];
  const linhas = calcularClassificacaoSets(times, jogos, sets, {
    pontuacao: { vitoria: 2, derrota: 1 }, melhorDe: 1,
    criterios: ['vitorias', 'saldo_sets', 'saldo_pontos', 'confronto'],
  });
  assert.deepEqual(linhas.map((l) => l.nome), ['C', 'A', 'B', 'D']);
  assert.equal(linhas[0].pts, 2);
  assert.equal(linhas[2].pts, 1); // derrota vale 1 (padrao FIVB praia / FIBA)
  assert.equal(linhas[0].saldo_pontos, 8);
});

test('mata-mata por sets: jogo unico e vencedor propagado', () => {
  const camp = criar({ esporte: 'peteca', formato: 'mata', times: ['A', 'B', 'C', 'D'] });
  assert.equal(camp.melhor_de, 3);
  const semi = db
    .prepare("SELECT * FROM jogos WHERE campeonato_id = ? AND rodada = 1 ORDER BY confronto")
    .all(camp.id);
  assert.equal(semi.length, 2); // jogo unico por confronto
  registrarResultado(db, semi[0], { sets: [[12, 8], [10, 12], [12, 6]] });
  registrarResultado(db, semi[1], { sets: [[12, 3], [12, 5]] });
  const final = db
    .prepare("SELECT * FROM jogos WHERE campeonato_id = ? AND rodada = 2")
    .get(camp.id);
  assert.equal(final.time_casa_id, semi[0].time_casa_id); // 2-1: casa venceu
  assert.equal(final.time_fora_id, semi[1].time_casa_id); // 2-0: casa venceu
});

test('catalogo fase 2: os 4 esportes de sets estao disponiveis', () => {
  for (const chave of ['futevolei', 'beach_tennis', 'volei', 'peteca']) {
    const e = obterEsporte(chave);
    assert.equal(e.disponivel, true, chave);
    assert.equal(e.placar, 'sets', chave);
    assert.equal(e.empate, false, chave);
  }
  assert.equal(obterEsporte('basquete').disponivel, true); // fase 3
  assert.equal(obterEsporte('basquete').placar, 'pontos');
  assert.equal(obterEsporte('pelada_epica').disponivel, true); // fase 4a
  assert.equal(obterEsporte('pelada_epica').ranking, 'individual');
});

test('placar livre (melhor_de 0): qualquer contagem de sets, mas exige vencedor', () => {
  const camp = criar({ esporte: 'futevolei', melhor_de: 0 });
  assert.equal(camp.melhor_de, 0);

  // 3 x 2 direto (nao fecharia em nenhum "melhor de" do preset) e aceito
  const jogoAB = jogoDe(camp.id, 'A', 'B');
  const salvo = registrarResultado(db, jogoAB, { sets_casa: 3, sets_fora: 2 });
  assert.equal(salvo.gols_casa, 3);

  // parciais em qualquer quantidade, sem regra de maioria/sobra
  const camp2 = criar({ esporte: 'peteca', melhor_de: 0 });
  const jogo2 = jogoDe(camp2.id, 'A', 'B');
  const comParciais = registrarResultado(db, jogo2, { sets: [[12, 8], [8, 12], [12, 10], [12, 4]] });
  assert.equal(comParciais.gols_casa, 3);
  assert.equal(comParciais.gols_fora, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sets WHERE jogo_id = ?').get(jogo2.id).n, 4);

  // empate continua proibido (classificacao e mata-mata precisam de vencedor)
  apagarResultado(db, comParciais);
  assert.throws(() => registrarResultado(db, jogo2, { sets: [[12, 8], [8, 12]] }), /vencedor/);
  assert.throws(() => registrarResultado(db, jogo2, { sets_casa: 2, sets_fora: 2 }), /vencedor/);
  // set individual empatado segue sem sentido
  assert.throws(() => registrarResultado(db, jogo2, { sets: [[10, 10], [12, 8]] }), /empatado/);
});
