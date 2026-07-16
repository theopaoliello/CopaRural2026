// Sorteio de times da Pelada Epica (EF Pelada Epica v1.0, secao 7): matriz de
// entrosamento derivada das escalacoes e Sorteio Premium ponderado por ela.
// Nada aqui grava no banco — o organizador confirma a proposta para criar o jogo.

// Expoente da separacao (EF 7.3): 1 = suave, 3 = agressiva. Fixo em 2 no MVP.
export const EXPOENTE_SORTEIO = 2;

// Matriz de entrosamento (EF 7.1): quadrada, so jogadores FIXOS, alinhada com a
// ordem de `fixos`. Celula (a, b) = jogos encerrados em que a e b foram escalados
// no MESMO time; diagonal = total de jogos do jogador. Sempre derivada — nunca
// armazenada nem editavel. Suplentes ficam fora (coringas).
export function matrizEntrosamento(fixos, jogos, escalacoes) {
  const indice = new Map(fixos.map((j, i) => [j.id, i]));
  const matriz = Array.from({ length: fixos.length }, () => new Array(fixos.length).fill(0));
  const encerrados = new Set(jogos.filter((j) => j.status === 'encerrado').map((j) => j.id));

  const porJogo = new Map();
  for (const e of escalacoes) {
    if (!encerrados.has(e.jogo_id) || !indice.has(e.jogador_id)) continue;
    if (!porJogo.has(e.jogo_id)) porJogo.set(e.jogo_id, []);
    porJogo.get(e.jogo_id).push(e);
  }
  for (const escs of porJogo.values()) {
    for (let a = 0; a < escs.length; a++) {
      const ia = indice.get(escs[a].jogador_id);
      matriz[ia][ia] += 1;
      for (let b = a + 1; b < escs.length; b++) {
        if (escs[a].time_id !== escs[b].time_id) continue;
        const ib = indice.get(escs[b].jogador_id);
        matriz[ia][ib] += 1;
        matriz[ib][ia] += 1;
      }
    }
  }
  return matriz;
}

function embaralhar(itens, rng) {
  const a = [...itens];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function roleta(pesos, rng) {
  const total = pesos.reduce((s, p) => s + p, 0);
  let r = rng() * total;
  for (let i = 0; i < pesos.length; i++) {
    r -= pesos[i];
    if (r < 0) return i;
  }
  return pesos.length - 1;
}

// Sorteia os presentes entre os times do jogo (EF 7.3).
// - Passo 1: goleiros primeiro, um por time (excedentes viram jogadores de linha).
// - Passo 2: fixos por sorteio ponderado — peso do time = 1/(1+c)^expoente, onde
//   c = soma do "jogaram juntos" com os fixos ja alocados naquele time.
// - Passo 3: suplentes por ultimo, uniforme (fora da matriz em qualquer hipotese).
// Tamanhos equilibrados: vaga extra sorteada; time 2+ a frente do menor sai da vez.
// `premium: false` = sorteio simples (mesmo fluxo, pesos uniformes).
// `fixos` e `matriz` vem de matrizEntrosamento (mesma ordem); `rng` e injetavel p/ teste.
export function sortearTimes({
  times, presentes, fixos = [], matriz = [],
  premium = true, expoente = EXPOENTE_SORTEIO, rng = Math.random,
}) {
  const indice = new Map(fixos.map((j, i) => [j.id, i]));
  const alocado = new Map(times.map((t) => [t.id, []]));
  const base = Math.floor(presentes.length / times.length);
  const sobra = presentes.length % times.length;
  const cap = new Map(embaralhar(times, rng).map((t, i) => [t.id, base + (i < sobra ? 1 : 0)]));

  const custo = (jogador, timeId) => {
    const i = indice.get(jogador.id);
    if (i == null) return 0; // suplente: coringa, fora da matriz
    let c = 0;
    for (const membro of alocado.get(timeId)) {
      const k = indice.get(membro.id);
      if (k != null) c += matriz[i][k];
    }
    return c;
  };
  const escolher = (jogador, elegiveis) => {
    const pesos = elegiveis.map((t) => (premium ? 1 / (1 + custo(jogador, t.id)) ** expoente : 1));
    return elegiveis[roleta(pesos, rng)];
  };
  const equilibrados = () => {
    const comVaga = times.filter((t) => alocado.get(t.id).length < cap.get(t.id));
    const menor = Math.min(...comVaga.map((t) => alocado.get(t.id).length));
    return comVaga.filter((t) => alocado.get(t.id).length - menor <= 1);
  };

  // Passo 1 — goleiros, um por time; sem time disponivel, entram na fila do seu tipo.
  const filaLinha = { fixo: [], suplente: [] };
  for (const g of embaralhar(presentes.filter((p) => p.goleiro), rng)) {
    const elegiveis = equilibrados().filter((t) => !alocado.get(t.id).some((j) => j.goleiro));
    if (!elegiveis.length) { filaLinha[g.tipo === 'suplente' ? 'suplente' : 'fixo'].push(g); continue; }
    alocado.get(escolher(g, elegiveis).id).push(g);
  }
  // Passo 2 — fixos de linha (ponderado pela matriz).
  const fixosLinha = presentes.filter((p) => !p.goleiro && p.tipo !== 'suplente');
  for (const j of embaralhar([...fixosLinha, ...filaLinha.fixo], rng)) {
    alocado.get(escolher(j, equilibrados()).id).push(j);
  }
  // Passo 3 — suplentes (uniforme: custo 0 fora da matriz).
  const suplentesLinha = presentes.filter((p) => !p.goleiro && p.tipo === 'suplente');
  for (const j of embaralhar([...suplentesLinha, ...filaLinha.suplente], rng)) {
    alocado.get(escolher(j, equilibrados()).id).push(j);
  }

  return times.map((t) => ({ time_id: t.id, jogadores: alocado.get(t.id) }));
}
