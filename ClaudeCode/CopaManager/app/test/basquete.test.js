// Fase 3 multiesporte: basquete (modelo C — pontos de jogo) e cestinhas.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { prepararBanco } from '../db/db.js';
import { criarCampeonato } from '../src/campeonatos.js';
import { registrarResultado } from '../src/jogos.js';
import { calcularClassificacaoPontos, estatisticasJogadores } from '../src/classificacao.js';

let db;
let contaId;

before(() => {
  db = prepararBanco(':memory:');
  contaId = Number(
    db.prepare("INSERT INTO contas (nome, email, senha_hash) VALUES ('T', 't@t.com', 'x')").run().lastInsertRowid,
  );
});

const criar = (dados) => criarCampeonato(db, contaId, {
  nome: 'Copa Cesta', esporte: 'basquete', formato: 'pontos', sortear: false,
  times: ['Halcones', 'Piratas'], ...dados,
});

test('criacao basquete: preset FIBA (variante, pontuacao 2/1, criterios, sem melhor_de)', () => {
  const camp = criar({});
  assert.equal(camp.esporte, 'basquete');
  assert.equal(camp.modalidade, '5x5');
  assert.equal(camp.melhor_de, null); // modelo C nao tem sets
  assert.deepEqual(JSON.parse(camp.criterios_desempate), ['confronto', 'saldo_pontos', 'pontos_pro']);
});

test('resultado basquete: sem empate (RN-TC-09), cestinhas validadas e gravadas', () => {
  const camp = criar({});
  const jogo = db.prepare('SELECT * FROM jogos WHERE campeonato_id = ?').get(camp.id);
  const halcones = db.prepare('SELECT id FROM times WHERE campeonato_id = ? AND nome = ?').get(camp.id, 'Halcones').id;
  const piratas = db.prepare('SELECT id FROM times WHERE campeonato_id = ? AND nome = ?').get(camp.id, 'Piratas').id;
  const joao = Number(db.prepare('INSERT INTO jogadores (time_id, nome) VALUES (?, ?)').run(halcones, 'Joao').lastInsertRowid);

  // empate nunca (prorrogacao resolve na quadra)
  assert.throws(() => registrarResultado(db, jogo, { pontos_casa: 70, pontos_fora: 70 }), /prorrogacao/);
  // penaltis nao existem
  assert.throws(
    () => registrarResultado(db, jogo, { pontos_casa: 70, pontos_fora: 60, penaltis_casa: 1, penaltis_fora: 0 }),
    /penaltis/,
  );
  // evento de outro tipo, jogador de outro time e soma acima do placar
  assert.throws(
    () => registrarResultado(db, jogo, { pontos_casa: 70, pontos_fora: 60, eventos: [{ tipo: 'gol', time_id: halcones, jogador_id: joao, valor: 2 }] }),
    /Tipo de evento invalido/,
  );
  assert.throws(
    () => registrarResultado(db, jogo, { pontos_casa: 70, pontos_fora: 60, eventos: [{ tipo: 'pontos', time_id: piratas, jogador_id: joao, valor: 10 }] }),
    /nao pertence/,
  );
  assert.throws(
    () => registrarResultado(db, jogo, { pontos_casa: 70, pontos_fora: 60, eventos: [{ tipo: 'pontos', time_id: halcones, jogador_id: joao, valor: 71 }] }),
    /mais pontos/,
  );

  const salvo = registrarResultado(db, jogo, {
    pontos_casa: jogo.time_casa_id === halcones ? 78 : 72,
    pontos_fora: jogo.time_casa_id === halcones ? 72 : 78,
    eventos: [{ tipo: 'pontos', time_id: halcones, jogador_id: joao, valor: 22 }],
  });
  assert.equal(salvo.status, 'encerrado');
  const ev = db.prepare("SELECT * FROM eventos WHERE jogo_id = ? AND tipo = 'pontos'").get(jogo.id);
  assert.equal(ev.valor, 22);

  // estatisticas somam o valor dos eventos de pontos
  const stats = estatisticasJogadores([ev]);
  assert.equal(stats.get(joao).pontos, 22);
});

test('classificacao basquete: 2/1, desempate FIBA por confronto direto e saldo', () => {
  const times = [{ id: 1, nome: 'X' }, { id: 2, nome: 'Y' }, { id: 3, nome: 'Z' }, { id: 4, nome: 'W' }];
  const jogo = (id, casa, fora, pc, pf) =>
    ({ id, rodada: 1, status: 'encerrado', time_casa_id: casa, time_fora_id: fora, gols_casa: pc, gols_fora: pf });
  // X 60x59 Y | Z 80x50 X | Y 100x40 W
  // X e Y: 1V1D = 3 pts (2+1). Saldo: X -29, Y +59 — mas o confronto direto
  // (X venceu Y) vem primeiro no criterio FIBA e poe X na frente.
  const jogos = [jogo(1, 1, 2, 60, 59), jogo(2, 3, 1, 80, 50), jogo(3, 2, 4, 100, 40)];
  const fiba = { pontuacao: { vitoria: 2, derrota: 1 }, criterios: ['confronto', 'saldo_pontos', 'pontos_pro'] };
  const linhas = calcularClassificacaoPontos(times, jogos, fiba);
  assert.deepEqual(linhas.map((l) => [l.nome, l.pts]), [['X', 3], ['Y', 3], ['Z', 2], ['W', 1]]);
  assert.equal(linhas[0].saldo_pontos, -29);
  assert.equal(linhas[1].saldo_pontos, 59);

  // sem o confronto direto na frente, o saldo decide e inverte X e Y
  const porSaldo = calcularClassificacaoPontos(times, jogos, { ...fiba, criterios: ['saldo_pontos'] });
  assert.deepEqual(porSaldo.map((l) => l.nome).slice(0, 2), ['Y', 'X']);
});

test('migracao: banco antigo de eventos (sem valor/pontos) e reconstruido preservando dados', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-mig-'));
  const caminho = join(dir, 'antigo.db');
  // Banco no formato pre-fase-3: eventos sem `valor` e sem 'pontos' no CHECK.
  const antigo = new DatabaseSync(caminho);
  // Stubs com as colunas que os indices do schema referenciam.
  antigo.exec(`
    CREATE TABLE jogos (id INTEGER PRIMARY KEY, campeonato_id INTEGER);
    CREATE TABLE times (id INTEGER PRIMARY KEY, campeonato_id INTEGER);
    CREATE TABLE jogadores (id INTEGER PRIMARY KEY, time_id INTEGER);
    CREATE TABLE eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jogo_id INTEGER NOT NULL REFERENCES jogos(id) ON DELETE CASCADE,
      time_id INTEGER NOT NULL REFERENCES times(id) ON DELETE CASCADE,
      jogador_id INTEGER REFERENCES jogadores(id) ON DELETE SET NULL,
      tipo TEXT NOT NULL CHECK (tipo IN ('gol', 'gol_contra', 'amarelo', 'vermelho')),
      minuto INTEGER
    );
    INSERT INTO jogos (id) VALUES (1);
    INSERT INTO times (id) VALUES (1);
    INSERT INTO eventos (jogo_id, time_id, tipo, minuto) VALUES (1, 1, 'gol', 12);
  `);
  antigo.close();

  const migrado = prepararBanco(caminho);
  const ev = migrado.prepare('SELECT * FROM eventos').get();
  assert.equal(ev.tipo, 'gol');
  assert.equal(ev.minuto, 12);
  assert.equal(ev.valor, 1); // coluna nova com o DEFAULT
  // o CHECK novo aceita o tipo 'pontos'
  migrado.exec("INSERT INTO eventos (jogo_id, time_id, tipo, valor) VALUES (1, 1, 'pontos', 20)");
  assert.equal(migrado.prepare("SELECT valor FROM eventos WHERE tipo = 'pontos'").get().valor, 20);
  migrado.close();
  rmSync(dir, { recursive: true, force: true });
});
