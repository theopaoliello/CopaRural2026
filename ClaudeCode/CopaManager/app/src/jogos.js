// Lancamento, correcao e exclusao de resultados, com eventos (gols e cartoes)
// e propagacao automatica de vencedores no mata-mata.
// O formato do lancamento e dirigido pelo modelo de placar do esporte:
// modelo A (gols, o historico) ou modelo B (sets, com parciais opcionais).
import { erroValidacao, erroConflito } from './erros.js';
import { vencedorConfronto, perdedorConfronto, CONFRONTO_TERCEIRO } from './tabela.js';
import { obterEsporte, ESPORTE_PADRAO } from './esportes.js';

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
  // Fim da chave = ULTIMA rodada (RN-MM-17). A leitura antiga era "rodada com
  // um confronto so", que numa chave com folgas pode ser uma fase do meio —
  // numa escada, toda rodada tem um jogo. Em chave cheia da no mesmo.
  const ultima = db
    .prepare("SELECT MAX(rodada) AS r FROM jogos WHERE campeonato_id = ? AND fase = 'mata'")
    .get(jogo.campeonato_id).r;
  if (jogo.rodada >= ultima) return [];
  return db
    .prepare(
      `SELECT * FROM jogos
       WHERE campeonato_id = ? AND fase = 'mata' AND rodada = ? AND confronto = ?
       ORDER BY perna`,
    )
    .all(jogo.campeonato_id, jogo.rodada + 1, Math.floor(jogo.confronto / 2));
}

// Pernas da disputa de 3o lugar alimentadas por ESTE confronto (RN-MM-22):
// so a penultima rodada alimenta a disputa, e com o perdedor. Vazio quando
// o campeonato nao tem disputa ou o confronto nao e de semifinal.
function pernasDaDisputa(db, jogo) {
  const ultima = db
    .prepare("SELECT MAX(rodada) AS r FROM jogos WHERE campeonato_id = ? AND fase = 'mata'")
    .get(jogo.campeonato_id).r;
  if (jogo.rodada !== ultima - 1) return [];
  return db
    .prepare(
      `SELECT * FROM jogos
       WHERE campeonato_id = ? AND fase = 'mata' AND rodada = ? AND confronto = ?
       ORDER BY perna`,
    )
    .all(jogo.campeonato_id, ultima, CONFRONTO_TERCEIRO);
}

// Escreve (ou limpa) a vaga que este confronto alimenta no destino.
function preencherVaga(db, jogo, destino, time, mensagemConflito) {
  if (!destino.length) return;
  if (destino.some((p) => p.status === 'encerrado')) throw erroConflito(mensagemConflito);
  const ladoCasa = jogo.confronto % 2 === 0; // confrontos pares ocupam o mando no destino
  for (const p of destino) {
    // Perna 1 respeita o lado do chaveamento; perna 2 inverte o mando.
    const coluna = (p.perna === 1) === ladoCasa ? 'time_casa_id' : 'time_fora_id';
    db.prepare(`UPDATE jogos SET ${coluna} = ? WHERE id = ?`).run(time, p.id);
  }
}

// Recalcula o resultado do confronto e preenche (ou limpa) as vagas que ele
// alimenta: o vencedor na fase seguinte e — havendo disputa de 3o lugar — o
// perdedor da semifinal no confronto 1 da ultima rodada (RN-MM-22).
function propagarVencedor(db, jogo) {
  if (jogo.fase !== 'mata') return;
  const pernas = pernasDoConfronto(db, jogo);
  const vencedor = vencedorConfronto(pernas);
  preencherVaga(
    db, jogo, proximasPernas(db, jogo), vencedor,
    'A fase seguinte deste confronto ja tem resultado lancado. Apague primeiro o resultado da fase seguinte.',
  );
  preencherVaga(
    db, jogo, pernasDaDisputa(db, jogo), perdedorConfronto(pernas, vencedor),
    'A disputa de 3o lugar ja tem resultado lancado. Apague primeiro o resultado dela.',
  );
}

// Valida e grava um resultado, no formato do modelo de placar do esporte.
// Modelo A (gols): { gols_casa, gols_fora, penaltis_casa?, penaltis_fora?,
//   eventos: [{tipo, time_id, jogador_id?, minuto?}] }
// Modelo B (sets): { sets: [[pontos_casa, pontos_fora], ...] } (parciais)
//   ou { sets_casa, sets_fora } (placar simples, sem parciais)
export function registrarResultado(db, jogo, dados) {
  if (!jogo.time_casa_id || !jogo.time_fora_id) {
    throw erroValidacao('Este jogo ainda nao tem os dois times definidos.');
  }
  const campeonato = db.prepare('SELECT * FROM campeonatos WHERE id = ?').get(jogo.campeonato_id);
  const esporte = obterEsporte(campeonato?.esporte) ?? obterEsporte(ESPORTE_PADRAO);
  if (esporte.placar === 'sets') return registrarResultadoSets(db, jogo, campeonato, esporte, dados);
  if (esporte.placar === 'pontos') return registrarResultadoPontos(db, jogo, esporte, dados);
  if (esporte.ranking === 'individual') return registrarResultadoPelada(db, jogo, dados);
  return registrarResultadoGols(db, jogo, dados);
}

// ---------- Pelada Epica: gols + escalacao obrigatoria (RN-PE-03) ----------

// Valida uma lista de escalacoes { jogador_id, time_id } contra o jogo e devolve
// o Map jogador -> time. Usada no resultado e na confirmacao do sorteio (jogo
// criado com escalacoes preenchidas).
export function validarEscalacoes(db, jogo, escalacoes) {
  const idsTimes = [jogo.time_casa_id, jogo.time_fora_id];
  const timeDoJogador = new Map();
  for (const esc of escalacoes) {
    const timeId = Number(esc.time_id);
    const jogadorId = Number(esc.jogador_id);
    if (!idsTimes.includes(timeId)) throw erroValidacao('Escalacao aponta para um time que nao esta neste jogo.');
    if (timeDoJogador.has(jogadorId)) {
      throw erroValidacao('Um jogador nao pode estar nos dois times do mesmo jogo.');
    }
    const jogador = db.prepare('SELECT * FROM jogadores WHERE id = ?').get(jogadorId);
    if (!jogador || jogador.campeonato_id !== jogo.campeonato_id) {
      throw erroValidacao('Jogador escalado nao pertence a este campeonato.');
    }
    timeDoJogador.set(jogadorId, timeId);
  }
  const escaladosPorTime = new Map(idsTimes.map((t) => [t, 0]));
  for (const t of timeDoJogador.values()) escaladosPorTime.set(t, escaladosPorTime.get(t) + 1);
  if (idsTimes.some((t) => !escaladosPorTime.get(t))) {
    throw erroValidacao('Informe a escalacao dos dois times.');
  }
  return timeDoJogador;
}

// Grava as escalacoes de um jogo (substituindo as anteriores).
export function gravarEscalacoes(db, jogoId, timeDoJogador) {
  db.prepare('DELETE FROM escalacoes WHERE jogo_id = ?').run(jogoId);
  const ins = db.prepare('INSERT INTO escalacoes (jogo_id, jogador_id, time_id) VALUES (?, ?, ?)');
  for (const [jogadorId, timeId] of timeDoJogador) ins.run(jogoId, jogadorId, timeId);
}

// `dados`: { gols_casa, gols_fora, escalacoes: [{jogador_id, time_id}],
//   eventos?: [{tipo:'gol', time_id, jogador_id?}] } — autor opcional (SR).
function registrarResultadoPelada(db, jogo, dados) {
  if (dados.penaltis_casa != null || dados.penaltis_fora != null) {
    throw erroValidacao('A Pelada Epica nao tem penaltis: empate vale ponto.');
  }
  const golsCasa = Number(dados.gols_casa);
  const golsFora = Number(dados.gols_fora);
  if (!Number.isInteger(golsCasa) || golsCasa < 0 || !Number.isInteger(golsFora) || golsFora < 0) {
    throw erroValidacao('Placar invalido.');
  }

  // Escalacao: quem jogou em cada time — e dela que sai a pontuacao individual.
  const timeDoJogador = validarEscalacoes(db, jogo, dados.escalacoes ?? []);
  const idsTimes = [jogo.time_casa_id, jogo.time_fora_id];

  // Gols: autor opcional (SR); com autor, ele precisa estar escalado no time do gol.
  const eventos = dados.eventos ?? [];
  const golsPorTime = { [jogo.time_casa_id]: 0, [jogo.time_fora_id]: 0 };
  for (const ev of eventos) {
    if (ev.tipo !== 'gol') throw erroValidacao(`Tipo de evento invalido para a Pelada Epica: ${ev.tipo}`);
    const timeId = Number(ev.time_id);
    if (!idsTimes.includes(timeId)) throw erroValidacao('Evento aponta para um time que nao esta neste jogo.');
    if (ev.jogador_id != null && timeDoJogador.get(Number(ev.jogador_id)) !== timeId) {
      throw erroValidacao('Autor do gol nao esta escalado no time do gol.');
    }
    golsPorTime[timeId] += 1;
  }
  if (golsPorTime[jogo.time_casa_id] > golsCasa || golsPorTime[jogo.time_fora_id] > golsFora) {
    throw erroValidacao('Ha mais gols atribuidos do que o placar do jogo.');
  }

  db.prepare(
    `UPDATE jogos SET gols_casa = ?, gols_fora = ?, penaltis_casa = NULL, penaltis_fora = NULL,
     status = 'encerrado' WHERE id = ?`,
  ).run(golsCasa, golsFora, jogo.id);

  db.prepare('DELETE FROM eventos WHERE jogo_id = ?').run(jogo.id);
  const insEv = db.prepare(
    "INSERT INTO eventos (jogo_id, time_id, jogador_id, tipo) VALUES (?, ?, ?, 'gol')",
  );
  for (const ev of eventos) {
    insEv.run(jogo.id, Number(ev.time_id), ev.jogador_id != null ? Number(ev.jogador_id) : null);
  }
  gravarEscalacoes(db, jogo.id, timeDoJogador);

  return db.prepare('SELECT * FROM jogos WHERE id = ?').get(jogo.id);
}

// ---------- modelo C: pontos de jogo (basquete) ----------

// `dados`: { pontos_casa, pontos_fora, eventos?: [{tipo:'pontos', time_id,
//   jogador_id, valor}] } — valor = total de pontos do jogador no jogo (cestinhas).
function registrarResultadoPontos(db, jogo, esporte, dados) {
  if (dados.penaltis_casa != null || dados.penaltis_fora != null) {
    throw erroValidacao(`Nao existem penaltis no ${esporte.nome}.`);
  }
  const pontosCasa = Number(dados.pontos_casa ?? dados.gols_casa);
  const pontosFora = Number(dados.pontos_fora ?? dados.gols_fora);
  if (!Number.isInteger(pontosCasa) || pontosCasa < 0 || !Number.isInteger(pontosFora) || pontosFora < 0) {
    throw erroValidacao('Placar invalido.');
  }
  // RN-TC-09: prorrogacao resolve na quadra — o placar final sempre tem vencedor.
  if (pontosCasa === pontosFora) {
    throw erroValidacao(`O ${esporte.nome} nao tem empate: informe o placar apos a prorrogacao.`);
  }

  const eventos = dados.eventos ?? [];
  const idsTimes = [jogo.time_casa_id, jogo.time_fora_id];
  const somaPorTime = { [jogo.time_casa_id]: 0, [jogo.time_fora_id]: 0 };
  for (const ev of eventos) {
    if (ev.tipo !== 'pontos') throw erroValidacao(`Tipo de evento invalido para ${esporte.nome}: ${ev.tipo}`);
    const timeId = Number(ev.time_id);
    if (!idsTimes.includes(timeId)) throw erroValidacao('Evento aponta para um time que nao esta neste jogo.');
    const valor = Number(ev.valor);
    if (!Number.isInteger(valor) || valor < 1) throw erroValidacao('Pontos do jogador invalidos.');
    const jogador = db.prepare('SELECT * FROM jogadores WHERE id = ?').get(Number(ev.jogador_id));
    if (!jogador || jogador.time_id !== timeId) {
      throw erroValidacao('Jogador do evento nao pertence ao time esperado.');
    }
    somaPorTime[timeId] += valor;
  }
  if (somaPorTime[jogo.time_casa_id] > pontosCasa || somaPorTime[jogo.time_fora_id] > pontosFora) {
    throw erroValidacao('Ha mais pontos atribuidos a jogadores do que o placar do time.');
  }

  db.prepare(
    `UPDATE jogos SET gols_casa = ?, gols_fora = ?, penaltis_casa = NULL, penaltis_fora = NULL,
     status = 'encerrado' WHERE id = ?`,
  ).run(pontosCasa, pontosFora, jogo.id);

  db.prepare('DELETE FROM eventos WHERE jogo_id = ?').run(jogo.id);
  db.prepare('DELETE FROM sets WHERE jogo_id = ?').run(jogo.id);
  const insEv = db.prepare(
    "INSERT INTO eventos (jogo_id, time_id, jogador_id, tipo, valor) VALUES (?, ?, ?, 'pontos', ?)",
  );
  for (const ev of eventos) insEv.run(jogo.id, Number(ev.time_id), Number(ev.jogador_id), Number(ev.valor));

  propagarVencedor(db, db.prepare('SELECT * FROM jogos WHERE id = ?').get(jogo.id));
  return db.prepare('SELECT * FROM jogos WHERE id = ?').get(jogo.id);
}

// ---------- modelo B: sets (futevolei, beach tennis, volei, peteca) ----------

function registrarResultadoSets(db, jogo, campeonato, esporte, dados) {
  if (dados.penaltis_casa != null || dados.penaltis_fora != null) {
    throw erroValidacao(`Nao existem penaltis no ${esporte.nome}: o jogo por sets sempre tem vencedor.`);
  }
  if (dados.eventos?.length) {
    throw erroValidacao(`O ${esporte.nome} nao registra eventos individuais.`);
  }

  // melhor_de 0 = placar livre: qualquer contagem de sets, so exige vencedor.
  const melhorDe = campeonato.melhor_de ?? esporte.melhor_de?.padrao ?? 1;
  const livre = melhorDe === 0;
  const paraFechar = livre ? null : Math.ceil(melhorDe / 2); // sets que fecham o jogo

  let setsCasa;
  let setsFora;
  let parciais = null;

  if (Array.isArray(dados.sets)) {
    // Sumula detalhada (RN-TC-08): as parciais mandam; o placar do jogo e derivado.
    if (!dados.sets.length) throw erroValidacao('Informe as parciais de pelo menos 1 set.');
    parciais = dados.sets.map((s, i) => {
      const casa = Number(Array.isArray(s) ? s[0] : s?.pontos_casa);
      const fora = Number(Array.isArray(s) ? s[1] : s?.pontos_fora);
      if (!Number.isInteger(casa) || casa < 0 || !Number.isInteger(fora) || fora < 0) {
        throw erroValidacao(`Parcial do ${i + 1}o set invalida.`);
      }
      if (casa === fora) throw erroValidacao(`O ${i + 1}o set nao pode terminar empatado.`);
      return { numero: i + 1, pontos_casa: casa, pontos_fora: fora };
    });
    setsCasa = 0;
    setsFora = 0;
    for (const p of parciais) {
      if (!livre && (setsCasa === paraFechar || setsFora === paraFechar)) {
        throw erroValidacao(`O jogo fecha em ${paraFechar} set(s): ha parciais sobrando.`);
      }
      if (p.pontos_casa > p.pontos_fora) setsCasa += 1;
      else setsFora += 1;
    }
  } else {
    // Placar simples: so o placar do jogo em sets.
    setsCasa = Number(dados.sets_casa);
    setsFora = Number(dados.sets_fora);
    if (!Number.isInteger(setsCasa) || setsCasa < 0 || !Number.isInteger(setsFora) || setsFora < 0) {
      throw erroValidacao('Placar de sets invalido.');
    }
  }

  const [vencedor, perdedor] = setsCasa > setsFora ? [setsCasa, setsFora] : [setsFora, setsCasa];
  if (livre) {
    // Placar livre: sem regra de contagem, mas o jogo precisa ter um vencedor.
    if (setsCasa === setsFora) throw erroValidacao('O jogo nao pode terminar empatado: informe um vencedor.');
  } else if (vencedor !== paraFechar || perdedor > melhorDe - paraFechar) {
    throw erroValidacao(
      `Placar de sets invalido para melhor de ${melhorDe}: o vencedor fecha com ${paraFechar} set(s)` +
      (melhorDe > 1 ? ` e o perdedor faz no maximo ${melhorDe - paraFechar}.` : '.'),
    );
  }

  db.prepare(
    `UPDATE jogos SET gols_casa = ?, gols_fora = ?, penaltis_casa = NULL, penaltis_fora = NULL,
     status = 'encerrado' WHERE id = ?`,
  ).run(setsCasa, setsFora, jogo.id);

  db.prepare('DELETE FROM eventos WHERE jogo_id = ?').run(jogo.id);
  db.prepare('DELETE FROM sets WHERE jogo_id = ?').run(jogo.id);
  if (parciais) {
    const ins = db.prepare('INSERT INTO sets (jogo_id, numero, pontos_casa, pontos_fora) VALUES (?, ?, ?, ?)');
    for (const p of parciais) ins.run(jogo.id, p.numero, p.pontos_casa, p.pontos_fora);
  }

  propagarVencedor(db, db.prepare('SELECT * FROM jogos WHERE id = ?').get(jogo.id));
  return db.prepare('SELECT * FROM jogos WHERE id = ?').get(jogo.id);
}

// ---------- modelo A: gols (futebol) ----------

function registrarResultadoGols(db, jogo, dados) {
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
    // A semifinal tambem alimenta a disputa de 3o: apagar o resultado dela
    // esvaziaria uma vaga de um jogo ja decidido.
    if (pernasDaDisputa(db, jogo).some((p) => p.status === 'encerrado')) {
      throw erroConflito(
        'A disputa de 3o lugar ja tem resultado lancado. Apague primeiro o resultado dela.',
      );
    }
  }

  db.prepare(
    `UPDATE jogos SET gols_casa = NULL, gols_fora = NULL, penaltis_casa = NULL, penaltis_fora = NULL,
     status = 'agendado' WHERE id = ?`,
  ).run(jogo.id);
  db.prepare('DELETE FROM eventos WHERE jogo_id = ?').run(jogo.id);
  db.prepare('DELETE FROM sets WHERE jogo_id = ?').run(jogo.id);

  propagarVencedor(db, db.prepare('SELECT * FROM jogos WHERE id = ?').get(jogo.id));
}
