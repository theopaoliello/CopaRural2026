// Motor da chave manual (EF Mata-mata Manual Personalizado, fase A):
// catalogo de desenhos, expansao em indices do esqueleto, folgas e geracao
// dos jogos. Inclui a equivalencia com o mata-mata de hoje em chave cheia —
// o modelo Padrao nao pode mudar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  expandirDesenho, desenhoPadrao, catalogoDeChaveamentos, obterDesenho,
  gerarChaveManual, MIN_VAGAS, MAX_VAGAS,
} from '../src/chaveamentos.js';
import { gerarMataMata, nomeRodadaMata, aceitaDisputaTerceiro } from '../src/tabela.js';
import { prepararBanco } from '../db/db.js';
import { registrarResultado } from '../src/jogos.js';

const NAO_POTENCIA = [3, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 17, 23, 31];

// Confrontos da 1a fase de uma lista de jogos, como pares [casa, fora].
const paresDaRodada = (jogos, rodada) => jogos
  .filter((j) => j.rodada === rodada && j.perna === 1)
  .sort((a, b) => a.confronto - b.confronto)
  .map((j) => [j.time_casa_id, j.time_fora_id]);

test('desenho padrao: chave cheia reproduz exatamente o mata-mata de hoje', () => {
  for (const n of [2, 4, 8, 16, 32]) {
    const times = Array.from({ length: n }, (_, i) => (i + 1) * 10);
    const atual = gerarMataMata(times);
    const manual = gerarChaveManual(expandirDesenho(desenhoPadrao(n)), times);
    assert.deepEqual(
      manual.map((j) => [j.rodada, j.confronto, j.perna, j.time_casa_id, j.time_fora_id]),
      atual.map((j) => [j.rodada, j.confronto, j.perna, j.time_casa_id, j.time_fora_id]),
      `chave de ${n} deveria ser identica a atual`,
    );
  }
});

test('desenho padrao: N-1 confrontos, folgas para os primeiros e 1a rodada certa', () => {
  for (const n of NAO_POTENCIA) {
    const d = expandirDesenho(desenhoPadrao(n));
    const esqueleto = 2 ** d.rodadas;
    assert.equal(d.vagas, n);
    assert.equal(d.jogos, n - 1, `chave de ${n}`);
    assert.ok(esqueleto >= n && esqueleto < n * 2, `esqueleto de ${n}`);
    // Jogos na 1a rodada = N - P/2; folgas = P - N (EF secao 4.1).
    const primeira = d.confrontos.filter((c) => c.rodada === 1).length;
    assert.equal(primeira, n - esqueleto / 2, `jogos da 1a rodada com ${n}`);
    // Quem folga entra numa rodada posterior: sao exatamente P - N vagas.
    const folgas = d.slots.filter((s) => s.rodada > 1).length;
    assert.equal(folgas, esqueleto - n, `folgas com ${n}`);
    // As folgas vao para os primeiros colocados.
    const comFolga = d.slots.filter((s) => s.rodada > 1).map((s) => s.posicao).sort((a, b) => a - b);
    assert.deepEqual(comFolga, Array.from({ length: esqueleto - n }, (_, i) => i + 1));
  }
});

test('chave de 6 (desenho 6A): 1o e 2o esperam nas semifinais', () => {
  const [padrao] = catalogoDeChaveamentos(6);
  assert.equal(padrao.id, '6A');
  assert.equal(padrao.recomendado, true);
  assert.equal(padrao.rodadas, 3);
  assert.equal(padrao.jogos, 5);

  const times = [10, 20, 30, 40, 50, 60]; // P1..P6
  const jogos = gerarChaveManual(padrao, times);
  // Quartas: so os dois confrontos reais (P4xP5 e P3xP6), sem jogo de folga.
  assert.deepEqual(paresDaRodada(jogos, 1), [[40, 50], [30, 60]]);
  // Semifinais: quem folgou ja esta na vaga (e manda em campo), do lado oposto
  // ao que o vencedor das quartas vai ocupar.
  assert.deepEqual(paresDaRodada(jogos, 2), [[10, null], [20, null]]);
  assert.deepEqual(paresDaRodada(jogos, 3), [[null, null]]);
});

test('chave de 3: dois jogos, o cabeca entra direto na final', () => {
  const [d] = catalogoDeChaveamentos(3);
  assert.equal(d.id, '3A');
  const jogos = gerarChaveManual(d, [10, 20, 30]);
  assert.equal(jogos.length, 2);
  assert.deepEqual(paresDaRodada(jogos, 1), [[20, 30]]);
  assert.deepEqual(paresDaRodada(jogos, 2), [[10, null]]);
});

test('escada (5B): uma rodada por jogo, o ultimo colocado abre', () => {
  const escada = obterDesenho(5, '5B');
  assert.equal(escada.rodadas, 4);
  assert.equal(escada.jogos, 4);
  const jogos = gerarChaveManual(escada, [10, 20, 30, 40, 50]);
  assert.deepEqual(paresDaRodada(jogos, 1), [[50, 40]]);
  assert.deepEqual(paresDaRodada(jogos, 2), [[null, 30]]);
  assert.deepEqual(paresDaRodada(jogos, 3), [[null, 20]]);
  assert.deepEqual(paresDaRodada(jogos, 4), [[null, 10]]);
});

test('lider na final (9C): P1 joga uma vez, os outros oito jogam chave completa', () => {
  const d = obterDesenho(9, '9C');
  assert.equal(d.rodadas, 4);
  assert.equal(d.jogos, 8);
  const times = Array.from({ length: 9 }, (_, i) => (i + 1) * 10);
  const jogos = gerarChaveManual(d, times);
  // 4 jogos na 1a rodada (os 8 de baixo), 2, 1 e a final com P1 esperando.
  assert.deepEqual(paresDaRodada(jogos, 1), [[20, 90], [50, 60], [40, 70], [30, 80]]);
  assert.equal(paresDaRodada(jogos, 2).length, 2);
  assert.equal(paresDaRodada(jogos, 3).length, 1);
  assert.deepEqual(paresDaRodada(jogos, 4), [[10, null]]);
});

test('todo desenho do catalogo respeita os invariantes da eliminacao simples', () => {
  for (const n of NAO_POTENCIA) {
    for (const d of catalogoDeChaveamentos(n)) {
      assert.equal(d.vagas, n, `${d.id}: vagas`);
      assert.equal(d.jogos, n - 1, `${d.id}: N-1 confrontos`);
      assert.equal(d.slots.length, n, `${d.id}: uma vaga por participante`);
      // Cada confronto tem exatamente 2 entradas: vagas diretas + alimentadores.
      for (const c of d.confrontos) {
        const diretas = d.slots.filter((s) => s.rodada === c.rodada && s.confronto === c.confronto).length;
        const alimentadores = d.confrontos.filter(
          (o) => o.rodada === c.rodada - 1 && Math.floor(o.confronto / 2) === c.confronto,
        ).length;
        assert.equal(diretas + alimentadores, 2, `${d.id}: confronto ${c.rodada}/${c.confronto}`);
      }
      // Cada confronto alimenta no maximo um da rodada seguinte, e o destino existe.
      const ultima = d.rodadas;
      for (const c of d.confrontos.filter((x) => x.rodada < ultima)) {
        const destino = d.confrontos.find(
          (o) => o.rodada === c.rodada + 1 && o.confronto === Math.floor(c.confronto / 2),
        );
        assert.ok(destino, `${d.id}: confronto ${c.rodada}/${c.confronto} sem destino`);
      }
      // O jogo gerado bate com a disputa de 3o declarada pelo catalogo.
      const jogos = gerarChaveManual(d, Array.from({ length: n }, (_, i) => i + 1));
      assert.equal(aceitaDisputaTerceiro(jogos), d.aceita_disputa_terceiro, `${d.id}: disputa de 3o`);
    }
  }
});

test('catalogo: potencias de 2 e tamanhos fora da faixa sao recusados', () => {
  for (const n of [4, 8, 16, 32]) {
    assert.throws(() => catalogoDeChaveamentos(n), /modelo Padrao/, `${n} deveria cair no Padrao`);
  }
  // 2 e final unica: fica fora da faixa da chave manual, nao e um desenho.
  assert.throws(() => catalogoDeChaveamentos(2), /de 3 a 32/);
  assert.throws(() => catalogoDeChaveamentos(MIN_VAGAS - 1), /de 3 a 32/);
  assert.throws(() => catalogoDeChaveamentos(MAX_VAGAS + 1), /de 3 a 32/);
  assert.throws(() => catalogoDeChaveamentos('oito'), /de 3 a 32/);
  assert.throws(() => obterDesenho(5, '5Z'), /nao existe/);
});

test('geracao: ida e volta duplica so os confrontos, e as vagas sao validadas', () => {
  const d = obterDesenho(5, '5A');
  const jogos = gerarChaveManual(d, [1, 2, 3, 4, 5], { idaEVolta: true });
  assert.equal(jogos.length, 8, '4 confrontos x 2 pernas');
  const volta = jogos.filter((j) => j.rodada === 1 && j.perna === 2)[0];
  assert.equal(volta.time_casa_id, 5, 'a perna 2 inverte o mando');
  assert.equal(volta.time_fora_id, 4);

  assert.throws(() => gerarChaveManual(d, [1, 2, 3]), /5 vagas/);
  assert.throws(() => gerarChaveManual(d, [1, 2, 3, 4, null]), /sem participante/);
  assert.throws(() => gerarChaveManual(d, [1, 2, 3, 4, 4]), /duas vagas/);
});

test('expansao recusa desenhos incoerentes', () => {
  // Rodada nao adjacente: o vencedor sumiria no meio da chave.
  assert.throws(
    () => expandirDesenho({ rodada: 3, esquerda: { rodada: 1, esquerda: 1, direita: 2 }, direita: 3 }),
    /nao adjacente/,
  );
  // Posicoes com buraco.
  assert.throws(
    () => expandirDesenho({ rodada: 1, esquerda: 1, direita: 3 }),
    /de 1 a N/,
  );
  assert.throws(() => expandirDesenho(1), /raiz/);
});

// Monta um campeonato de mata-mata direto no banco com um desenho do catalogo.
// (Criar isso pela API e assunto da fase B; aqui o que importa e o motor.)
function campeonatoComChave(vagas, desenhoId) {
  const db = prepararBanco(':memory:');
  const conta = db.prepare("INSERT INTO contas (nome, email, senha_hash) VALUES ('Dona', 'dona@teste.com', 'x')").run();
  const camp = db.prepare(
    `INSERT INTO campeonatos (conta_id, nome, slug, formato) VALUES (?, 'Chave manual', 'chave-manual', 'mata')`,
  ).run(Number(conta.lastInsertRowid));
  const campId = Number(camp.lastInsertRowid);

  const insTime = db.prepare('INSERT INTO times (campeonato_id, nome) VALUES (?, ?)');
  const times = Array.from({ length: vagas }, (_, i) =>
    Number(insTime.run(campId, `Time ${i + 1}`).lastInsertRowid));

  const insJogo = db.prepare(
    `INSERT INTO jogos (campeonato_id, fase, rodada, confronto, perna, time_casa_id, time_fora_id)
     VALUES (?, 'mata', ?, ?, ?, ?, ?)`,
  );
  for (const j of gerarChaveManual(obterDesenho(vagas, desenhoId), times)) {
    insJogo.run(campId, j.rodada, j.confronto, j.perna, j.time_casa_id, j.time_fora_id);
  }
  const jogo = (rodada, confronto) => db
    .prepare("SELECT * FROM jogos WHERE campeonato_id = ? AND fase = 'mata' AND rodada = ? AND confronto = ?")
    .get(campId, rodada, confronto);
  return { db, times, jogo };
}

test('chave de 5 (5A) roda de ponta a ponta: a preliminar propaga e a final decide', () => {
  const { db, times, jogo } = campeonatoComChave(5, '5A');
  const [t1, t2, t3, t4, t5] = times;

  // Preliminar: rodada com UM confronto so — antes da fase A, a propagacao
  // parava aqui achando que ja era a final.
  const prelim = jogo(1, 1);
  assert.deepEqual([prelim.time_casa_id, prelim.time_fora_id], [t4, t5]);
  registrarResultado(db, prelim, { gols_casa: 3, gols_fora: 0 });

  const semi1 = jogo(2, 0);
  assert.deepEqual([semi1.time_casa_id, semi1.time_fora_id], [t1, t4], 'o vencedor da preliminar enfrenta quem folgou');
  const semi2 = jogo(2, 1);
  assert.deepEqual([semi2.time_casa_id, semi2.time_fora_id], [t2, t3], 'dois times de folga se cruzam');

  registrarResultado(db, semi1, { gols_casa: 1, gols_fora: 2 }); // t4 avanca
  registrarResultado(db, semi2, { gols_casa: 2, gols_fora: 1 }); // t2 avanca
  const decisao = jogo(3, 0);
  assert.deepEqual([decisao.time_casa_id, decisao.time_fora_id], [t4, t2]);

  registrarResultado(db, decisao, { gols_casa: 0, gols_fora: 3 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jogos WHERE campeonato_id = ? AND fase = 'mata'").get(decisao.campeonato_id).n, 4);
  db.close();
});

test('escada de 5 (5B): quatro rodadas de um jogo, cada vencedor sobe um degrau', () => {
  const { db, times, jogo } = campeonatoComChave(5, '5B');
  const [t1, t2, t3, t4, t5] = times;

  const f1 = jogo(1, 0);
  assert.deepEqual([f1.time_casa_id, f1.time_fora_id], [t5, t4]);
  registrarResultado(db, f1, { gols_casa: 2, gols_fora: 1 }); // t5 sobe

  const f2 = jogo(2, 0);
  assert.deepEqual([f2.time_casa_id, f2.time_fora_id], [t5, t3], 'o vencedor sobe e enfrenta o proximo colocado');
  registrarResultado(db, f2, { gols_casa: 2, gols_fora: 1 });

  const semi = jogo(3, 0);
  assert.deepEqual([semi.time_casa_id, semi.time_fora_id], [t5, t2]);
  registrarResultado(db, semi, { gols_casa: 2, gols_fora: 1 });

  const decisao = jogo(4, 0);
  assert.deepEqual([decisao.time_casa_id, decisao.time_fora_id], [t5, t1], 'o lider so aparece na final');
  db.close();
});

test('nome da rodada: por distancia do fim, sem mudar a chave cheia', () => {
  // Chave cheia: identico ao que o produto ja mostrava.
  assert.deepEqual(
    [1, 2, 3, 4].map((r) => nomeRodadaMata(r, 4, 2 ** (4 - r))),
    ['Oitavas de final', 'Quartas de final', 'Semifinal', 'Final'],
  );
  assert.equal(nomeRodadaMata(1, 5, 16), '16 avos de final');
  // Escada de 5: 4 rodadas de 1 jogo — sem a regra nova, todas seriam "Final".
  assert.deepEqual(
    [1, 2, 3, 4].map((r) => nomeRodadaMata(r, 4, 1)),
    ['Fase preliminar', 'Fase 2', 'Semifinal', 'Final'],
  );
  // Chave de 6: a 1a rodada tem 2 jogos e mesmo assim e "quartas de final" —
  // e a rodada das quartas do esqueleto de 8, com duas folgas.
  assert.equal(nomeRodadaMata(1, 3, 2), 'Quartas de final');
  // 9C: a 1a rodada tem 4 confrontos num esqueleto de 16 — nao e oitavas.
  assert.equal(nomeRodadaMata(1, 4, 4), 'Fase preliminar');
  assert.equal(nomeRodadaMata(2, 4, 2), 'Quartas de final');
});
