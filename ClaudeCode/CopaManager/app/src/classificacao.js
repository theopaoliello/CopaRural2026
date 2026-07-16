// Classificacao DERIVADA dos jogos encerrados — nunca armazenada.
// Corrigir/apagar um resultado recalcula tudo automaticamente por construcao.
import { pontosDaPartidaSets } from './esportes.js';

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

// Classificacao dos esportes de sets (modelo B). Nunca ha empate de jogo.
// jogos encerrados carregam o placar em sets em gols_casa/gols_fora; as
// parciais (sets) alimentam pontos pro/contra (games, no beach tennis).
// opcoes: { pontuacao (preset do esporte), criterios }
// Linhas: { time_id, pos, pts, pj, v, d, sv, sp, pp, pc, saldo_sets,
//           saldo_pontos, ultimos } (razoes/percentuais sao derivados na ordenacao)
export function calcularClassificacaoSets(times, jogos, sets, opcoes = {}) {
  const { pontuacao = { vitoria: 2, derrota: 1 }, criterios = [] } = opcoes;

  const linhas = new Map();
  for (const t of times) {
    linhas.set(t.id, {
      time_id: t.id, nome: t.nome,
      pts: 0, pj: 0, v: 0, d: 0, sv: 0, sp: 0, pp: 0, pc: 0,
      saldo_sets: 0, saldo_pontos: 0, ultimos: [],
    });
  }

  const encerrados = jogos
    .filter((j) => j.status === 'encerrado' && linhas.has(j.time_casa_id) && linhas.has(j.time_fora_id))
    .sort((a, b) => a.rodada - b.rodada || a.id - b.id);
  const parciaisPorJogo = new Map();
  for (const s of sets) {
    if (!parciaisPorJogo.has(s.jogo_id)) parciaisPorJogo.set(s.jogo_id, []);
    parciaisPorJogo.get(s.jogo_id).push(s);
  }

  for (const j of encerrados) {
    const casa = linhas.get(j.time_casa_id);
    const fora = linhas.get(j.time_fora_id);
    const casaVenceu = j.gols_casa > j.gols_fora;
    const [vSets, pSets] = casaVenceu ? [j.gols_casa, j.gols_fora] : [j.gols_fora, j.gols_casa];
    const pontos = pontosDaPartidaSets(pontuacao, vSets, pSets);
    const [vencedor, perdedor] = casaVenceu ? [casa, fora] : [fora, casa];

    vencedor.pj += 1; vencedor.v += 1; vencedor.pts += pontos.vencedor; vencedor.ultimos.push('V');
    perdedor.pj += 1; perdedor.d += 1; perdedor.pts += pontos.perdedor; perdedor.ultimos.push('D');
    casa.sv += j.gols_casa; casa.sp += j.gols_fora;
    fora.sv += j.gols_fora; fora.sp += j.gols_casa;
    for (const p of parciaisPorJogo.get(j.id) ?? []) {
      casa.pp += p.pontos_casa; casa.pc += p.pontos_fora;
      fora.pp += p.pontos_fora; fora.pc += p.pontos_casa;
    }
  }
  for (const l of linhas.values()) {
    l.saldo_sets = l.sv - l.sp;
    l.saldo_pontos = l.pp - l.pc;
  }

  // Confronto direto: pontos de classificacao conquistados nos jogos entre os dois.
  const pontosConfronto = (idA, idB) => {
    let pts = 0;
    for (const j of encerrados) {
      const emCasa = j.time_casa_id === idA && j.time_fora_id === idB;
      const deFora = j.time_fora_id === idA && j.time_casa_id === idB;
      if (!emCasa && !deFora) continue;
      const meus = emCasa ? j.gols_casa : j.gols_fora;
      const deles = emCasa ? j.gols_fora : j.gols_casa;
      const p = pontosDaPartidaSets(pontuacao, Math.max(meus, deles), Math.min(meus, deles));
      pts += meus > deles ? p.vencedor : p.perdedor;
    }
    return pts;
  };

  // Razoes e percentuais: divisao por zero vira "melhor possivel" (FIVB: MAX).
  const razao = (a, b) => (b === 0 ? (a === 0 ? 0 : Infinity) : a / b);
  const pct = (a, b) => (a + b === 0 ? 0 : a / (a + b));

  const comparadores = {
    vitorias: (a, b) => b.v - a.v,
    confronto: (a, b) => pontosConfronto(b.time_id, a.time_id) - pontosConfronto(a.time_id, b.time_id),
    saldo_sets: (a, b) => b.saldo_sets - a.saldo_sets,
    saldo_pontos: (a, b) => b.saldo_pontos - a.saldo_pontos,
    razao_sets: (a, b) => razao(b.sv, b.sp) - razao(a.sv, a.sp),
    razao_pontos: (a, b) => razao(b.pp, b.pc) - razao(a.pp, a.pc),
    pct_sets: (a, b) => pct(b.sv, b.sp) - pct(a.sv, a.sp),
    pct_pontos: (a, b) => pct(b.pp, b.pc) - pct(a.pp, a.pc),
  };

  const ordenadas = [...linhas.values()].sort((a, b) => {
    if (b.pts !== a.pts) return b.pts - a.pts;
    for (const c of criterios) {
      const cmp = comparadores[c]?.(a, b) ?? 0;
      // Infinity - Infinity = NaN: dois times sem set perdido seguem empatados.
      if (cmp !== 0 && !Number.isNaN(cmp)) return cmp;
    }
    return a.nome.localeCompare(b.nome, 'pt-BR');
  });

  return ordenadas.map((linha, i) => ({ ...linha, pos: i + 1, ultimos: linha.ultimos.slice(-5) }));
}

// Classificacao dos esportes de pontos de jogo (modelo C — basquete).
// O placar em pontos fica em gols_casa/gols_fora; nunca ha empate (RN-TC-09).
// opcoes: { pontuacao ({vitoria, derrota}), criterios }
// Linhas: { time_id, pos, pts, pj, v, d, pp, pc, saldo_pontos, ultimos }
export function calcularClassificacaoPontos(times, jogos, opcoes = {}) {
  const { pontuacao = { vitoria: 2, derrota: 1 }, criterios = [] } = opcoes;

  const linhas = new Map();
  for (const t of times) {
    linhas.set(t.id, {
      time_id: t.id, nome: t.nome,
      pts: 0, pj: 0, v: 0, d: 0, pp: 0, pc: 0, saldo_pontos: 0, ultimos: [],
    });
  }

  const encerrados = jogos
    .filter((j) => j.status === 'encerrado' && linhas.has(j.time_casa_id) && linhas.has(j.time_fora_id))
    .sort((a, b) => a.rodada - b.rodada || a.id - b.id);

  const aplicar = (linha, pp, pc) => {
    linha.pj += 1;
    linha.pp += pp;
    linha.pc += pc;
    linha.saldo_pontos = linha.pp - linha.pc;
    if (pp > pc) {
      linha.v += 1;
      linha.pts += pontuacao.vitoria;
      linha.ultimos.push('V');
    } else {
      linha.d += 1;
      linha.pts += pontuacao.derrota;
      linha.ultimos.push('D');
    }
  };
  for (const j of encerrados) {
    aplicar(linhas.get(j.time_casa_id), j.gols_casa, j.gols_fora);
    aplicar(linhas.get(j.time_fora_id), j.gols_fora, j.gols_casa);
  }

  // Confronto direto (FIBA): pontos de classificacao nos jogos entre os dois.
  const pontosConfronto = (idA, idB) => {
    let pts = 0;
    for (const j of encerrados) {
      const emCasa = j.time_casa_id === idA && j.time_fora_id === idB;
      const deFora = j.time_fora_id === idA && j.time_casa_id === idB;
      if (!emCasa && !deFora) continue;
      const meus = emCasa ? j.gols_casa : j.gols_fora;
      const deles = emCasa ? j.gols_fora : j.gols_casa;
      pts += meus > deles ? pontuacao.vitoria : pontuacao.derrota;
    }
    return pts;
  };

  const comparadores = {
    vitorias: (a, b) => b.v - a.v,
    confronto: (a, b) => pontosConfronto(b.time_id, a.time_id) - pontosConfronto(a.time_id, b.time_id),
    saldo_pontos: (a, b) => b.saldo_pontos - a.saldo_pontos,
    pontos_pro: (a, b) => b.pp - a.pp,
  };

  const ordenadas = [...linhas.values()].sort((a, b) => {
    if (b.pts !== a.pts) return b.pts - a.pts;
    for (const c of criterios) {
      const cmp = comparadores[c]?.(a, b) ?? 0;
      if (cmp !== 0) return cmp;
    }
    return a.nome.localeCompare(b.nome, 'pt-BR');
  });

  return ordenadas.map((linha, i) => ({ ...linha, pos: i + 1, ultimos: linha.ultimos.slice(-5) }));
}

// Ranking individual da Pelada Epica (EF v1.0). Conta apenas jogadores FIXOS
// (RN-PE-01); pontos vem da escalacao em jogos encerrados (RN-PE-02):
// presenca (opcional) + vitoria/empate/derrota do time em que o jogador estava.
// Falta = jogo encerrado em que o fixo nao participou (total de jogos
// realizados - jogos do jogador) — decisao do Theo em 2026-07-16.
// opcoes: { pontosVitoria, pontosEmpate, pontosPresenca, criterios }
// Linhas: { jogador_id, pos, nome, goleiro, pts, presencas, pj, v, e, d,
//           gols, faltas, ultimos }
export function calcularRankingPelada(jogadores, jogos, escalacoes, eventos, opcoes = {}) {
  const {
    pontosVitoria = 3, pontosEmpate = 1, pontosPresenca = 1,
    criterios = ['gols', 'presencas'],
  } = opcoes;

  const linhas = new Map(
    jogadores
      .filter((j) => j.tipo === 'fixo')
      .map((j) => [j.id, {
        jogador_id: j.id, nome: j.nome, goleiro: j.goleiro ? 1 : 0,
        pts: 0, presencas: 0, pj: 0, v: 0, e: 0, d: 0, gols: 0, faltas: 0, ultimos: [],
      }]),
  );
  const encerrados = jogos
    .filter((j) => j.status === 'encerrado')
    .sort((a, b) => a.rodada - b.rodada || a.id - b.id);
  const escalacoesPorJogo = new Map();
  for (const e of escalacoes) {
    if (!escalacoesPorJogo.has(e.jogo_id)) escalacoesPorJogo.set(e.jogo_id, []);
    escalacoesPorJogo.get(e.jogo_id).push(e);
  }

  for (const j of encerrados) {
    for (const esc of escalacoesPorJogo.get(j.id) ?? []) {
      const linha = linhas.get(esc.jogador_id);
      if (!linha) continue; // suplente: coringa, fora do ranking
      const gp = esc.time_id === j.time_casa_id ? j.gols_casa : j.gols_fora;
      const gc = esc.time_id === j.time_casa_id ? j.gols_fora : j.gols_casa;
      linha.presencas += 1;
      linha.pj += 1;
      linha.pts += pontosPresenca;
      if (gp > gc) { linha.v += 1; linha.pts += pontosVitoria; linha.ultimos.push('V'); }
      else if (gp === gc) { linha.e += 1; linha.pts += pontosEmpate; linha.ultimos.push('E'); }
      else { linha.d += 1; linha.ultimos.push('D'); }
    }
  }
  // Faltas: jogos realizados em que o fixo nao estava escalado.
  for (const linha of linhas.values()) linha.faltas = encerrados.length - linha.pj;
  for (const ev of eventos) {
    if (ev.tipo === 'gol' && ev.jogador_id != null) {
      const linha = linhas.get(ev.jogador_id);
      if (linha) linha.gols += 1;
    }
  }

  const comparadores = {
    goleiro: (a, b) => b.goleiro - a.goleiro, // flag "Priorizar goleiro" (RN-PE-11)
    gols: (a, b) => b.gols - a.gols,
    presencas: (a, b) => b.presencas - a.presencas,
  };
  const ordenadas = [...linhas.values()].sort((a, b) => {
    if (b.pts !== a.pts) return b.pts - a.pts;
    for (const c of criterios) {
      const cmp = comparadores[c]?.(a, b) ?? 0;
      if (cmp !== 0) return cmp;
    }
    return a.nome.localeCompare(b.nome, 'pt-BR');
  });

  return ordenadas.map((linha, i) => ({ ...linha, pos: i + 1, ultimos: linha.ultimos.slice(-5) }));
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

// Artilharia/cestinhas e disciplina por jogador a partir dos eventos de jogos
// encerrados. `pontos` soma o `valor` dos eventos tipo 'pontos' (basquete).
export function estatisticasJogadores(eventos) {
  const mapa = new Map();
  for (const ev of eventos) {
    if (ev.jogador_id == null) continue;
    if (!mapa.has(ev.jogador_id)) {
      mapa.set(ev.jogador_id, { jogador_id: ev.jogador_id, gols: 0, pontos: 0, amarelos: 0, vermelhos: 0 });
    }
    const s = mapa.get(ev.jogador_id);
    if (ev.tipo === 'gol') s.gols += 1;
    else if (ev.tipo === 'pontos') s.pontos += ev.valor ?? 1;
    else if (ev.tipo === 'amarelo') s.amarelos += 1;
    else if (ev.tipo === 'vermelho') s.vermelhos += 1;
  }
  return mapa;
}
