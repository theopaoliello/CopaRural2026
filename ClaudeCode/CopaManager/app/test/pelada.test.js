// Fase 4a multiesporte: Pelada Epica (ranking individual, EF v1.0).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { prepararBanco } from '../db/db.js';
import {
  criarCampeonato, criarJogoAvulso, classificacaoDoCampeonato,
  aplicarZonasPelada, validarPremiacaoRebaixamento,
} from '../src/campeonatos.js';
import { registrarResultado, apagarResultado } from '../src/jogos.js';
import { calcularRankingPelada } from '../src/classificacao.js';
import { dadosPublicos } from '../src/publico.js';

let db;
let contaId;

before(() => {
  db = prepararBanco(':memory:');
  contaId = Number(
    db.prepare("INSERT INTO contas (nome, email, senha_hash) VALUES ('T', 't@t.com', 'x')").run().lastInsertRowid,
  );
});

const criar = (dados) => criarCampeonato(db, contaId, {
  nome: 'Pelada de Terca', esporte: 'pelada_epica',
  times: ['Camisa', 'Sem Camisa'], jogos_temporada: 40,
  jogadores_fixos: ['Daniel (G)', 'Marley', 'Theo', 'Wecsley'],
  jogadores_suplentes: ['Vitor (G)', 'Rafael'],
  ...dados,
});
const jogadorPorNome = (campId, nome) =>
  db.prepare('SELECT * FROM jogadores WHERE campeonato_id = ? AND nome = ?').get(campId, nome);
const timePorNome = (campId, nome) =>
  db.prepare('SELECT * FROM times WHERE campeonato_id = ? AND nome = ?').get(campId, nome);

test('criacao: divisoes, temporada, jogadores com (G), preset e nenhum jogo gerado', () => {
  const camp = criar({ prioriza_goleiro: true, criterio_desempate: 'presencas' });
  assert.equal(camp.esporte, 'pelada_epica');
  assert.equal(camp.jogos_temporada, 40);
  assert.equal(camp.pontos_presenca, 1); // flag padrao ligada
  assert.equal(camp.premiacao, 'primeiro');
  assert.deepEqual(JSON.parse(camp.criterios_desempate), ['goleiro', 'presencas', 'gols']);

  const daniel = jogadorPorNome(camp.id, 'Daniel');
  assert.equal(daniel.goleiro, 1); // "(G)" saiu do nome e virou marcacao
  assert.equal(daniel.tipo, 'fixo');
  assert.equal(jogadorPorNome(camp.id, 'Vitor').tipo, 'suplente');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM times WHERE campeonato_id = ?').get(camp.id).n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jogos WHERE campeonato_id = ?').get(camp.id).n, 0);

  // validacoes do wizard
  assert.throws(() => criar({ times: ['So Um'] }), /pelo menos 2/);
  assert.throws(() => criar({ jogos_temporada: undefined }), /quantidade de jogos/);
  assert.throws(() => criar({ jogadores_fixos: ['Solo'] }), /2 jogadores fixos/);
  assert.throws(() => criar({ jogadores_fixos: ['Theo', 'theo'] }), /repetidos/);
  assert.throws(() => criar({ rebaixamento_modo: 'pontuacoes' }), /quantidade do rebaixamento/);
  assert.throws(() => criar({ criterios_desempate: ['cartoes'] }), /Criterios de desempate invalidos/);
});

test('ponto por presenca opcional: flag desligada zera a presenca na pontuacao', () => {
  const camp = criar({ ponto_presenca: false });
  assert.equal(camp.pontos_presenca, 0);
});

test('jogo avulso: rodada sequencial, so na pelada, e exclusao permitida', () => {
  const camp = criar({});
  const j1 = criarJogoAvulso(db, camp, {});
  const j2 = criarJogoAvulso(db, camp, { data: '2026-07-20', local: 'Quadra 1' });
  assert.equal(j1.rodada, 1);
  assert.equal(j2.rodada, 2);
  assert.notEqual(j1.time_casa_id, j1.time_fora_id);

  const futebol = criarCampeonato(db, contaId, {
    nome: 'Copa Comum', formato: 'pontos', sortear: false, times: ['A', 'B'],
  });
  assert.throws(() => criarJogoAvulso(db, futebol, {}), /gerada automaticamente/);
});

test('resultado: escalacao obrigatoria dos dois times e validada (RN-PE-03)', () => {
  const camp = criar({});
  const jogo = criarJogoAvulso(db, camp, {});
  const camisa = jogo.time_casa_id;
  const semCamisa = jogo.time_fora_id;
  const daniel = jogadorPorNome(camp.id, 'Daniel');
  const marley = jogadorPorNome(camp.id, 'Marley');
  const theo = jogadorPorNome(camp.id, 'Theo');

  // sem escalacao / so um time escalado
  assert.throws(() => registrarResultado(db, jogo, { gols_casa: 1, gols_fora: 0 }), /escalacao dos dois times/);
  assert.throws(
    () => registrarResultado(db, jogo, {
      gols_casa: 1, gols_fora: 0,
      escalacoes: [{ jogador_id: daniel.id, time_id: camisa }],
    }),
    /escalacao dos dois times/,
  );
  // jogador nos dois times
  assert.throws(
    () => registrarResultado(db, jogo, {
      gols_casa: 1, gols_fora: 0,
      escalacoes: [
        { jogador_id: daniel.id, time_id: camisa },
        { jogador_id: daniel.id, time_id: semCamisa },
      ],
    }),
    /dois times do mesmo jogo/,
  );
  // autor de gol nao escalado no time do gol
  assert.throws(
    () => registrarResultado(db, jogo, {
      gols_casa: 1, gols_fora: 0,
      escalacoes: [
        { jogador_id: daniel.id, time_id: camisa },
        { jogador_id: marley.id, time_id: semCamisa },
      ],
      eventos: [{ tipo: 'gol', time_id: camisa, jogador_id: marley.id }],
    }),
    /nao esta escalado/,
  );
  // penaltis nao existem
  assert.throws(
    () => registrarResultado(db, jogo, {
      gols_casa: 1, gols_fora: 1, penaltis_casa: 3, penaltis_fora: 1,
      escalacoes: [
        { jogador_id: daniel.id, time_id: camisa },
        { jogador_id: marley.id, time_id: semCamisa },
      ],
    }),
    /penaltis/,
  );

  const salvo = registrarResultado(db, jogo, {
    gols_casa: 2, gols_fora: 1,
    escalacoes: [
      { jogador_id: daniel.id, time_id: camisa },
      { jogador_id: theo.id, time_id: camisa },
      { jogador_id: marley.id, time_id: semCamisa },
    ],
    eventos: [
      { tipo: 'gol', time_id: camisa, jogador_id: theo.id },
      { tipo: 'gol', time_id: camisa, jogador_id: null }, // SR
      { tipo: 'gol', time_id: semCamisa, jogador_id: marley.id },
    ],
  });
  assert.equal(salvo.status, 'encerrado');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM escalacoes WHERE jogo_id = ?').get(jogo.id).n, 3);

  // apagar o resultado zera o placar mas PRESERVA a escalacao (quem jogou nao muda)
  apagarResultado(db, salvo);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM escalacoes WHERE jogo_id = ?').get(jogo.id).n, 3);
});

test('ranking: pontos pelo time escalado, presenca opcional e desempates (goleiro/gols/presencas)', () => {
  const jogadores = [
    { id: 1, nome: 'Daniel', tipo: 'fixo', goleiro: 1 },
    { id: 2, nome: 'Marley', tipo: 'fixo', goleiro: 0 },
    { id: 3, nome: 'Theo', tipo: 'fixo', goleiro: 0 },
    { id: 4, nome: 'Vitor', tipo: 'suplente', goleiro: 0 },
  ];
  const jogos = [
    { id: 1, rodada: 1, status: 'encerrado', time_casa_id: 10, time_fora_id: 20, gols_casa: 2, gols_fora: 1 },
    { id: 2, rodada: 2, status: 'encerrado', time_casa_id: 10, time_fora_id: 20, gols_casa: 0, gols_fora: 0 },
  ];
  const escalacoes = [
    // jogo 1: Daniel e Theo no vencedor; Marley e Vitor no perdedor
    { jogo_id: 1, jogador_id: 1, time_id: 10 }, { jogo_id: 1, jogador_id: 3, time_id: 10 },
    { jogo_id: 1, jogador_id: 2, time_id: 20 }, { jogo_id: 1, jogador_id: 4, time_id: 20 },
    // jogo 2 (empate): so Daniel e Marley
    { jogo_id: 2, jogador_id: 1, time_id: 10 }, { jogo_id: 2, jogador_id: 2, time_id: 20 },
  ];
  const eventos = [
    { jogo_id: 1, tipo: 'gol', jogador_id: 3 }, // gol do Theo
    { jogo_id: 1, tipo: 'gol', jogador_id: 4 }, // gol do suplente (fora do ranking)
  ];

  const linhas = calcularRankingPelada(jogadores, jogos, escalacoes, eventos, {
    pontosVitoria: 3, pontosEmpate: 1, pontosPresenca: 1, criterios: ['gols', 'presencas'],
  });
  // Daniel: 2 presencas + V + E = 2+3+1 = 6 | Theo: 1+3 = 4 | Marley: 2+0+1 = 3
  assert.deepEqual(linhas.map((l) => [l.nome, l.pts]), [['Daniel', 6], ['Theo', 4], ['Marley', 3]]);
  assert.ok(!linhas.some((l) => l.nome === 'Vitor')); // suplente fora (RN-PE-01)
  assert.equal(linhas[1].gols, 1);

  // sem ponto por presenca: Daniel 4 (V+E), Theo 3 (V), Marley 1 (E)
  const semPresenca = calcularRankingPelada(jogadores, jogos, escalacoes, eventos, {
    pontosPresenca: 0, criterios: ['gols', 'presencas'],
  });
  assert.deepEqual(semPresenca.map((l) => [l.nome, l.pts]), [['Daniel', 4], ['Theo', 3], ['Marley', 1]]);

  // desempate: Daniel (goleiro) e Theo empatados em 4 pts no cenario sem presenca?
  // nao — teste dedicado: dois jogadores 4 pts, um goleiro, flag prioriza goleiro
  const duelo = calcularRankingPelada(
    [{ id: 1, nome: 'Zico', tipo: 'fixo', goleiro: 0 }, { id: 2, nome: 'Anjo', tipo: 'fixo', goleiro: 1 }],
    [{ id: 1, rodada: 1, status: 'encerrado', time_casa_id: 10, time_fora_id: 20, gols_casa: 1, gols_fora: 1 }],
    [{ jogo_id: 1, jogador_id: 1, time_id: 10 }, { jogo_id: 1, jogador_id: 2, time_id: 20 }],
    [{ jogo_id: 1, tipo: 'gol', jogador_id: 1 }],
    { criterios: ['goleiro', 'gols', 'presencas'] },
  );
  // empatados em pts (empate 1+1): goleiro na frente APESAR do gol do Zico
  assert.deepEqual(duelo.map((l) => l.nome), ['Anjo', 'Zico']);
  // sem a flag, o gol desempata para o Zico
  const semFlag = calcularRankingPelada(
    [{ id: 1, nome: 'Zico', tipo: 'fixo', goleiro: 0 }, { id: 2, nome: 'Anjo', tipo: 'fixo', goleiro: 1 }],
    [{ id: 1, rodada: 1, status: 'encerrado', time_casa_id: 10, time_fora_id: 20, gols_casa: 1, gols_fora: 1 }],
    [{ jogo_id: 1, jogador_id: 1, time_id: 10 }, { jogo_id: 1, jogador_id: 2, time_id: 20 }],
    [{ jogo_id: 1, tipo: 'gol', jogador_id: 1 }],
    { criterios: ['gols', 'presencas'] },
  );
  assert.deepEqual(semFlag.map((l) => l.nome), ['Zico', 'Anjo']);
});

test('integracao: classificacao do campeonato e pagina publica da pelada', () => {
  const camp = criar({});
  const jogo = criarJogoAvulso(db, camp, {});
  const daniel = jogadorPorNome(camp.id, 'Daniel');
  const marley = jogadorPorNome(camp.id, 'Marley');
  const vitor = jogadorPorNome(camp.id, 'Vitor'); // suplente
  registrarResultado(db, jogo, {
    gols_casa: 3, gols_fora: 0,
    escalacoes: [
      { jogador_id: daniel.id, time_id: jogo.time_casa_id },
      { jogador_id: vitor.id, time_id: jogo.time_casa_id },
      { jogador_id: marley.id, time_id: jogo.time_fora_id },
    ],
    eventos: [{ tipo: 'gol', time_id: jogo.time_casa_id, jogador_id: vitor.id }],
  });

  const [{ linhas }] = classificacaoDoCampeonato(db, camp);
  assert.equal(linhas[0].nome, 'Daniel');
  assert.equal(linhas[0].pts, 4); // presenca 1 + vitoria 3
  assert.ok(!linhas.some((l) => l.nome === 'Vitor'));
  assert.ok(linhas.some((l) => l.nome === 'Theo' && l.pts === 0)); // fixo sem jogar aparece

  const pub = dadosPublicos(db, camp.slug);
  assert.equal(pub.esporte.ranking, 'individual');
  assert.equal(pub.esporte.rotulos.classificacao, 'Ranking');
  assert.equal(pub.campeonato.jogos_temporada, 40);
  assert.equal(pub.escalacoes.length, 3);
  // suplente aparece na artilharia, marcado
  assert.deepEqual(pub.artilharia[0], { nome: 'Vitor', time: undefined, tipo: 'suplente', total: 1 });
});

test('faltas: fixo ausente conta falta apenas quando um suplente jogou no lugar', () => {
  const jogadores = [
    { id: 1, nome: 'Daniel', tipo: 'fixo', goleiro: 1 },
    { id: 2, nome: 'Marley', tipo: 'fixo', goleiro: 0 },
    { id: 3, nome: 'Theo', tipo: 'fixo', goleiro: 0 },
    { id: 4, nome: 'Vitor', tipo: 'suplente', goleiro: 0 },
  ];
  const jogos = [
    { id: 1, rodada: 1, status: 'encerrado', time_casa_id: 10, time_fora_id: 20, gols_casa: 1, gols_fora: 0 },
    { id: 2, rodada: 2, status: 'encerrado', time_casa_id: 10, time_fora_id: 20, gols_casa: 0, gols_fora: 0 },
    { id: 3, rodada: 3, status: 'agendado', time_casa_id: 10, time_fora_id: 20, gols_casa: null, gols_fora: null },
  ];
  const escalacoes = [
    // jogo 1: Theo faltou e o suplente Vitor cobriu -> falta do Theo
    { jogo_id: 1, jogador_id: 1, time_id: 10 }, { jogo_id: 1, jogador_id: 4, time_id: 10 },
    { jogo_id: 1, jogador_id: 2, time_id: 20 },
    // jogo 2: Theo faltou mas NINGUEM cobriu (sem suplente) -> nao e falta
    { jogo_id: 2, jogador_id: 1, time_id: 10 }, { jogo_id: 2, jogador_id: 2, time_id: 20 },
  ];

  const linhas = calcularRankingPelada(jogadores, jogos, escalacoes, [], { criterios: ['gols', 'presencas'] });
  const porNome = Object.fromEntries(linhas.map((l) => [l.nome, l]));
  assert.equal(porNome.Theo.faltas, 1); // so o jogo 1 (jogo agendado nao conta)
  assert.equal(porNome.Daniel.faltas, 0);
  assert.equal(porNome.Marley.faltas, 0);
});

test('zonas do ranking (RN-PE-06): medalhas, rebaixamento por colocados e por pontuacoes', () => {
  const linhas = (pts) => pts.map((p, i) => ({ jogador_id: i + 1, pos: i + 1, nome: `J${i + 1}`, pj: 1, pts: p }));

  // antes do 1o resultado (todos com pj 0) nao ha zona nenhuma
  const semJogos = [{ pos: 1, nome: 'A', pj: 0, pts: 0 }, { pos: 2, nome: 'B', pj: 0, pts: 0 }];
  aplicarZonasPelada(semJogos, { premiacao: 'top3' });
  assert.ok(semJogos.every((l) => !l.zona));

  // premiacao 'primeiro': so o lider leva medalha
  const primeiro = linhas([9, 7, 5]);
  aplicarZonasPelada(primeiro, { premiacao: 'primeiro' });
  assert.deepEqual(primeiro.map((l) => l.medalha ?? null), [1, null, null]);

  // top3 + rebaixamento por colocados: base do ranking, sem sobrepor premiacao
  const colocados = linhas([9, 7, 5, 3, 1]);
  aplicarZonasPelada(colocados, { premiacao: 'top3', rebaixamento_modo: 'colocados', rebaixamento_qtd: 2 });
  assert.deepEqual(colocados.map((l) => l.zona ?? null), ['premiacao', 'premiacao', 'premiacao', 'rebaixamento', 'rebaixamento']);
  assert.deepEqual(colocados.slice(0, 3).map((l) => l.medalha), [1, 2, 3]);

  // pontuacoes: N menores valores DISTINTOS, empates incluidos (exemplo canonico:
  // Chico 10, Manuel 10, Bernardo 8, Theo 5, Thiago 5 com qtd 2 -> caem 8 e 5)
  const pontuacoes = linhas([10, 10, 8, 5, 5]);
  aplicarZonasPelada(pontuacoes, { premiacao: 'primeiro', rebaixamento_modo: 'pontuacoes', rebaixamento_qtd: 2 });
  assert.deepEqual(pontuacoes.map((l) => l.zona ?? null), ['premiacao', null, 'rebaixamento', 'rebaixamento', 'rebaixamento']);
});

test('config de premiacao editavel: validacao parcial preserva o que nao mudou', () => {
  const base = { premiacao: 'top3', premia_artilheiro: 1, rebaixamento_modo: 'colocados', rebaixamento_qtd: 3 };
  // troca so o modo: quantidade atual e preservada
  const mudouModo = validarPremiacaoRebaixamento({ rebaixamento_modo: 'pontuacoes' }, base);
  assert.deepEqual(mudouModo, { premiacao: 'top3', premia_artilheiro: 1, rebaixamento_modo: 'pontuacoes', rebaixamento_qtd: 3 });
  // desligar o rebaixamento limpa a quantidade
  const desligou = validarPremiacaoRebaixamento({ rebaixamento_modo: null }, base);
  assert.equal(desligou.rebaixamento_modo, null);
  assert.equal(desligou.rebaixamento_qtd, null);
  // ligar sem quantidade (e sem valor anterior) e erro
  assert.throws(
    () => validarPremiacaoRebaixamento({ rebaixamento_modo: 'colocados' }, { premiacao: 'primeiro' }),
    /quantidade do rebaixamento/,
  );
  assert.throws(() => validarPremiacaoRebaixamento({ premiacao: 'segundo' }, base), /Premiacao invalida/);
});

test('integracao: zonas chegam na classificacao e na pagina publica', () => {
  const camp = criar({ premiacao: 'top3', rebaixamento_modo: 'colocados', rebaixamento_qtd: 1 });
  const jogo = criarJogoAvulso(db, camp, {});
  const daniel = jogadorPorNome(camp.id, 'Daniel');
  const marley = jogadorPorNome(camp.id, 'Marley');
  registrarResultado(db, jogo, {
    gols_casa: 2, gols_fora: 0,
    escalacoes: [
      { jogador_id: daniel.id, time_id: jogo.time_casa_id },
      { jogador_id: marley.id, time_id: jogo.time_fora_id },
    ],
  });

  const [{ linhas }] = classificacaoDoCampeonato(db, camp);
  assert.equal(linhas[0].zona, 'premiacao');
  assert.equal(linhas[0].medalha, 1);
  assert.equal(linhas.at(-1).zona, 'rebaixamento');

  const pub = dadosPublicos(db, camp.slug);
  assert.equal(pub.classificacao[0].linhas[0].medalha, 1);
  assert.equal(pub.classificacao[0].linhas.at(-1).zona, 'rebaixamento');
});

test('migracao: banco antigo de jogadores (time_id NOT NULL) e reconstruido com FKs integras', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-mig-jog-'));
  const caminho = join(dir, 'antigo.db');
  const antigo = new DatabaseSync(caminho);
  antigo.exec(`
    CREATE TABLE times (id INTEGER PRIMARY KEY, campeonato_id INTEGER);
    CREATE TABLE jogos (id INTEGER PRIMARY KEY, campeonato_id INTEGER);
    CREATE TABLE jogadores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time_id INTEGER NOT NULL REFERENCES times(id) ON DELETE CASCADE,
      nome TEXT NOT NULL,
      numero INTEGER
    );
    CREATE TABLE eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jogo_id INTEGER NOT NULL REFERENCES jogos(id) ON DELETE CASCADE,
      time_id INTEGER NOT NULL REFERENCES times(id) ON DELETE CASCADE,
      jogador_id INTEGER REFERENCES jogadores(id) ON DELETE SET NULL,
      tipo TEXT NOT NULL CHECK (tipo IN ('gol', 'gol_contra', 'amarelo', 'vermelho', 'pontos')),
      minuto INTEGER,
      valor INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO times (id) VALUES (1);
    INSERT INTO jogos (id) VALUES (1);
    INSERT INTO jogadores (time_id, nome, numero) VALUES (1, 'Pele', 10);
    INSERT INTO eventos (jogo_id, time_id, jogador_id, tipo) VALUES (1, 1, 1, 'gol');
  `);
  antigo.close();

  const migrado = prepararBanco(caminho);
  const pele = migrado.prepare('SELECT * FROM jogadores').get();
  assert.equal(pele.nome, 'Pele');
  assert.equal(pele.tipo, 'fixo');
  assert.equal(pele.ativo, 1);
  // time_id deixou de ser NOT NULL (jogador de pelada) e as FKs seguem integras:
  migrado.exec("INSERT INTO jogadores (campeonato_id, nome, tipo) VALUES (NULL, 'Novo', 'suplente')");
  // ON DELETE SET NULL de eventos.jogador_id continua apontando para a tabela nova
  migrado.prepare('DELETE FROM jogadores WHERE id = ?').run(pele.id);
  assert.equal(migrado.prepare('SELECT jogador_id FROM eventos').get().jogador_id, null);
  migrado.close();
  rmSync(dir, { recursive: true, force: true });
});
