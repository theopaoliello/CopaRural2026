// Lancamento, correcao e exclusao de resultados, com eventos (gols e cartoes)
// e propagacao automatica de vencedores no mata-mata.
import { erroValidacao, erroConflito } from './erros.js';
import { vencedorConfronto } from './tabela.js';

const TIPOS_EVENTO = ['gol', 'gol_contra', 'amarelo', 'vermelho'];

function pernasDoConfronto(db, jogo) {
  return db
    .prepare(
      `SELECT * FROM jogos
       WHERE campeonato_id = ? AND fase = 'mata' AND rodada = ? AND confronto = ?
       ORDER BY perna`,
    )
    .all(jogo.campeonato_id, jogo.rodada, jogo.confronto);
}

function proximasPernas(db, jogo) {
  const totalNaRodada = db
    .prepare("SELECT COUNT(DISTINCT confronto) AS n FROM jogos WHERE campeonato_id = ? AND fase = 'mata' AND rodada = ?")
    .get(jogo.campeonato_id, jogo.rodada).n;
  if (totalNaRodada <= 1) return []; // ja era a final
  return db
    .prepare(
      `SELECT * FROM jogos
       WHERE campeonato_id = ? AND fase = 'mata' AND rodada = ? AND confronto = ?
       ORDER BY perna`,
    )
    .all(jogo.campeonato_id, jogo.rodada + 1, Math.floor(jogo.confronto / 2));
}

// Recalcula o vencedor do confronto e preenche (ou limpa) a vaga na fase seguinte.
function propagarVencedor(db, jogo) {
  if (jogo.fase !== 'mata') return;
  const proximas = proximasPernas(db, jogo);
  if (!proximas.length) return;

  if (proximas.some((p) => p.status === 'encerrado')) {
    throw erroConflito(
      'A fase seguinte deste confronto ja tem resultado lancado. Apague primeiro o resultado da fase seguinte.',
    );
  }

  const vencedor = vencedorConfronto(pernasDoConfronto(db, jogo));
  const ladoCasa = jogo.confronto % 2 === 0; // confrontos pares ocupam o mando na proxima fase
  for (const p of proximas) {
    // Perna 1 respeita o lado do chaveamento; perna 2 inverte o mando.
    const coluna = (p.perna === 1) === ladoCasa ? 'time_casa_id' : 'time_fora_id';
    db.prepare(`UPDATE jogos SET ${coluna} = ? WHERE id = ?`).run(vencedor, p.id);
  }
}

// Valida e grava um resultado. `dados`: { gols_casa, gols_fora, penaltis_casa?,
// penaltis_fora?, eventos: [{tipo, time_id, jogador_id?, minuto?}] }
export function registrarResultado(db, jogo, dados) {
  if (!jogo.time_casa_id || !jogo.time_fora_id) {
    throw erroValidacao('Este jogo ainda nao tem os dois times definidos.');
  }
  const golsCasa = Number(dados.gols_casa);
  const golsFora = Number(dados.gols_fora);
  if (!Number.isInteger(golsCasa) || golsCasa < 0 || !Number.isInteger(golsFora) || golsFora < 0) {
    throw erroValidacao('Placar invalido.');
  }

  let penCasa = null;
  let penFora = null;
  if (dados.penaltis_casa != null || dados.penaltis_fora != null) {
    penCasa = Number(dados.penaltis_casa);
    penFora = Number(dados.penaltis_fora);
    if (!Number.isInteger(penCasa) || penCasa < 0 || !Number.isInteger(penFora) || penFora < 0) {
      throw erroValidacao('Penaltis invalidos.');
    }
    if (penCasa === penFora) throw erroValidacao('A disputa de penaltis nao pode terminar empatada.');
  }

  // Eventos: gols nao podem exceder o placar; jogador precisa ser do time do evento.
  const eventos = dados.eventos ?? [];
  const idsTimes = [jogo.time_casa_id, jogo.time_fora_id];
  const golsPorTime = { [jogo.time_casa_id]: 0, [jogo.time_fora_id]: 0 };
  for (const ev of eventos) {
    if (!TIPOS_EVENTO.includes(ev.tipo)) throw erroValidacao(`Tipo de evento invalido: ${ev.tipo}`);
    const timeId = Number(ev.time_id);
    if (!idsTimes.includes(timeId)) throw erroValidacao('Evento aponta para um time que nao esta neste jogo.');
    if (ev.jogador_id != null) {
      const jogador = db.prepare('SELECT * FROM jogadores WHERE id = ?').get(Number(ev.jogador_id));
      // Gol contra: time_id e o time BENEFICIADO; o autor pertence ao adversario.
      const timeEsperado =
        ev.tipo === 'gol_contra'
          ? (timeId === jogo.time_casa_id ? jogo.time_fora_id : jogo.time_casa_id)
          : timeId;
      if (!jogador || jogador.time_id !== timeEsperado) {
        throw erroValidacao('Jogador do evento nao pertence ao time esperado.');
      }
    }
    if (ev.tipo === 'gol' || ev.tipo === 'gol_contra') golsPorTime[timeId] += 1;
  }
  if (golsPorTime[jogo.time_casa_id] > golsCasa || golsPorTime[jogo.time_fora_id] > golsFora) {
    throw erroValidacao('Ha mais gols atribuidos a jogadores do que o placar do jogo.');
  }

  // No jogo que decide um confronto de mata-mata, empate exige penaltis.
  if (jogo.fase === 'mata' && penCasa === null) {
    const pernas = pernasDoConfronto(db, jogo);
    const decisiva = jogo.perna === Math.max(...pernas.map((p) => p.perna));
    if (decisiva) {
      const simulado = pernas.map((p) =>
        p.id === jogo.id
          ? { ...p, gols_casa: golsCasa, gols_fora: golsFora, penaltis_casa: null, penaltis_fora: null, status: 'encerrado' }
          : p,
      );
      if (simulado.every((p) => p.status === 'encerrado') && vencedorConfronto(simulado) === null) {
        throw erroValidacao('O confronto terminou empatado: informe o resultado dos penaltis.');
      }
    }
  }

  db.prepare(
    `UPDATE jogos SET gols_casa = ?, gols_fora = ?, penaltis_casa = ?, penaltis_fora = ?, status = 'encerrado'
     WHERE id = ?`,
  ).run(golsCasa, golsFora, penCasa, penFora, jogo.id);

  db.prepare('DELETE FROM eventos WHERE jogo_id = ?').run(jogo.id);
  const insEv = db.prepare(
    'INSERT INTO eventos (jogo_id, time_id, jogador_id, tipo, minuto) VALUES (?, ?, ?, ?, ?)',
  );
  for (const ev of eventos) {
    insEv.run(
      jogo.id,
      Number(ev.time_id),
      ev.jogador_id != null ? Number(ev.jogador_id) : null,
      ev.tipo,
      ev.minuto != null ? Number(ev.minuto) : null,
    );
  }

  propagarVencedor(db, db.prepare('SELECT * FROM jogos WHERE id = ?').get(jogo.id));
  return db.prepare('SELECT * FROM jogos WHERE id = ?').get(jogo.id);
}

// Apaga um resultado (volta o jogo para "agendado") e limpa a vaga na fase seguinte.
export function apagarResultado(db, jogo) {
  if (jogo.status !== 'encerrado') throw erroValidacao('Este jogo ainda nao tem resultado.');

  if (jogo.fase === 'mata') {
    const proximas = proximasPernas(db, jogo);
    if (proximas.some((p) => p.status === 'encerrado')) {
      throw erroConflito(
        'A fase seguinte ja tem resultado lancado. Apague primeiro o resultado da fase seguinte.',
      );
    }
  }

  db.prepare(
    `UPDATE jogos SET gols_casa = NULL, gols_fora = NULL, penaltis_casa = NULL, penaltis_fora = NULL,
     status = 'agendado' WHERE id = ?`,
  ).run(jogo.id);
  db.prepare('DELETE FROM eventos WHERE jogo_id = ?').run(jogo.id);

  propagarVencedor(db, db.prepare('SELECT * FROM jogos WHERE id = ?').get(jogo.id));
}
