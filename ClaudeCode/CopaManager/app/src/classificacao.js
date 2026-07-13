// Classificacao DERIVADA dos jogos encerrados — nunca armazenada.
// Corrigir/apagar um resultado recalcula tudo automaticamente por construcao.

export const CRITERIOS_VALIDOS = ['vitorias', 'saldo', 'gols_pro', 'confronto', 'cartoes'];

// Calcula a tabela de um conjunto de times a partir dos jogos encerrados entre eles.
// times: [{id, nome, ...}] | jogos: linhas de `jogos` | cartoesPorTime: {time_id: pontosCartao}
// opcoes: { pontosVitoria, pontosEmpate, criterios }
// Devolve linhas ordenadas: { time_id, pos, pts, pj, v, e, d, gp, gc, sg, ultimos }
export function calcularClassificacao(times, jogos, opcoes = {}) {
  const {
    pontosVitoria = 3,
    pontosEmpate = 1,
    criterios = ['vitorias', 'saldo', 'gols_pro', 'confronto', 'cartoes'],
    cartoesPorTime = {},
  } = opcoes;

  const linhas = new Map();
  for (const t of times) {
    linhas.set(t.id, {
      time_id: t.id, nome: t.nome,
      pts: 0, pj: 0, v: 0, e: 0, d: 0, gp: 0, gc: 0, sg: 0,
      ultimos: [], // resultados em ordem cronologica: 'V' | 'E' | 'D'
    });
  }

  const encerrados = jogos
    .filter((j) => j.status === 'encerrado' && linhas.has(j.time_casa_id) && linhas.has(j.time_fora_id))
    .sort((a, b) => a.rodada - b.rodada || a.id - b.id);

  const aplicar = (linha, gp, gc) => {
    linha.pj += 1;
    linha.gp += gp;
    linha.gc += gc;
    linha.sg = linha.gp - linha.gc;
    if (gp > gc) {
      linha.v += 1;
      linha.pts += pontosVitoria;
      linha.ultimos.push('V');
    } else if (gp === gc) {
      linha.e += 1;
      linha.pts += pontosEmpate;
      linha.ultimos.push('E');
    } else {
      linha.d += 1;
      linha.ultimos.push('D');
    }
  };

  for (const j of encerrados) {
    aplicar(linhas.get(j.time_casa_id), j.gols_casa, j.gols_fora);
    aplicar(linhas.get(j.time_fora_id), j.gols_fora, j.gols_casa);
  }

  // Confronto direto entre dois times: pontos conquistados nos jogos entre eles.
  const pontosConfronto = (idA, idB) => {
    let pts = 0;
    for (const j of encerrados) {
      const emCasa = j.time_casa_id === idA && j.time_fora_id === idB;
      const fora = j.time_fora_id === idA && j.time_casa_id === idB;
      if (!emCasa && !fora) continue;
      const gpA = emCasa ? j.gols_casa : j.gols_fora;
      const gcA = emCasa ? j.gols_fora : j.gols_casa;
      if (gpA > gcA) pts += pontosVitoria;
      else if (gpA === gcA) pts += pontosEmpate;
    }
    return pts;
  };

  const comparadores = {
    vitorias: (a, b) => b.v - a.v,
    saldo: (a, b) => b.sg - a.sg,
    gols_pro: (a, b) => b.gp - a.gp,
    confronto: (a, b) => pontosConfronto(b.time_id, a.time_id) - pontosConfronto(a.time_id, b.time_id),
    // menos cartoes e melhor (vermelho pesa 2x)
    cartoes: (a, b) => (cartoesPorTime[a.time_id] ?? 0) - (cartoesPorTime[b.time_id] ?? 0),
  };

  const ordenadas = [...linhas.values()].sort((a, b) => {
    if (b.pts !== a.pts) return b.pts - a.pts;
    for (const c of criterios) {
      const cmp = comparadores[c]?.(a, b) ?? 0;
      if (cmp !== 0) return cmp;
    }
    // Ultimo recurso deterministico: ordem alfabetica.
    return a.nome.localeCompare(b.nome, 'pt-BR');
  });

  return ordenadas.map((linha, i) => ({
    ...linha,
    pos: i + 1,
    ultimos: linha.ultimos.slice(-5), // 5 mais recentes, da mais antiga a mais nova
  }));
}

// Peso de cartoes por time para o criterio de desempate "cartoes".
// eventos: [{jogo_id, time_id, tipo}] apenas de jogos encerrados.
export function cartoesPorTime(eventos) {
  const mapa = {};
  for (const ev of eventos) {
    if (ev.tipo !== 'amarelo' && ev.tipo !== 'vermelho') continue;
    mapa[ev.time_id] = (mapa[ev.time_id] ?? 0) + (ev.tipo === 'vermelho' ? 2 : 1);
  }
  return mapa;
}

// Artilharia e disciplina por jogador a partir dos eventos de jogos encerrados.
export function estatisticasJogadores(eventos) {
  const mapa = new Map();
  for (const ev of eventos) {
    if (ev.jogador_id == null) continue;
    if (!mapa.has(ev.jogador_id)) {
      mapa.set(ev.jogador_id, { jogador_id: ev.jogador_id, gols: 0, amarelos: 0, vermelhos: 0 });
    }
    const s = mapa.get(ev.jogador_id);
    if (ev.tipo === 'gol') s.gols += 1;
    else if (ev.tipo === 'amarelo') s.amarelos += 1;
    else if (ev.tipo === 'vermelho') s.vermelhos += 1;
  }
  return mapa;
}
