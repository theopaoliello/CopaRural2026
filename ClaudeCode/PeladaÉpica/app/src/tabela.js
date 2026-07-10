// Geracao de confrontos: pontos corridos (round-robin) e mata-mata (chaveamento).
// Funcoes puras: recebem ids de times, devolvem a lista de jogos a inserir.
import { erroValidacao } from './erros.js';

// ---------- pontos corridos ----------

// Round-robin pelo metodo do circulo. Com n impar, entra uma "folga" (null).
// Devolve [{ rodada, time_casa_id, time_fora_id }] com mando alternado por rodada.
export function gerarPontosCorridos(timeIds, { idaEVolta = false } = {}) {
  const ids = [...timeIds];
  if (ids.length < 2) throw erroValidacao('Sao necessarios pelo menos 2 times.');
  if (ids.length % 2 === 1) ids.push(null); // folga
  const n = ids.length;
  const rodadas = n - 1;
  const jogos = [];
  const giro = ids.slice(1); // o primeiro fica fixo, os demais giram

  for (let r = 0; r < rodadas; r++) {
    const linha = [ids[0], ...giro];
    for (let i = 0; i < n / 2; i++) {
      const a = linha[i];
      const b = linha[n - 1 - i];
      if (a === null || b === null) continue;
      // Alterna o mando do pivo (i === 0) a cada rodada para equilibrar.
      const inverte = i === 0 && r % 2 === 1;
      jogos.push({
        rodada: r + 1,
        time_casa_id: inverte ? b : a,
        time_fora_id: inverte ? a : b,
      });
    }
    giro.unshift(giro.pop()); // gira o circulo
  }

  if (idaEVolta) {
    const volta = jogos.map((j) => ({
      rodada: j.rodada + rodadas,
      time_casa_id: j.time_fora_id,
      time_fora_id: j.time_casa_id,
    }));
    jogos.push(...volta);
  }
  return jogos;
}

// Divide os times em grupos SEQUENCIALMENTE, respeitando a ordem recebida:
// os primeiros formam o Grupo A, os seguintes o B, etc. Assim, sem sorteio,
// o organizador controla a distribuicao pela ordem em que digitou os times.
// Com sobra, os primeiros grupos ficam com um time a mais.
export function dividirEmGrupos(timeIds, numGrupos) {
  if (numGrupos < 1) throw erroValidacao('Quantidade de grupos invalida.');
  if (timeIds.length < numGrupos * 2) {
    throw erroValidacao('Cada grupo precisa de pelo menos 2 times.');
  }
  const base = Math.floor(timeIds.length / numGrupos);
  let resto = timeIds.length % numGrupos;
  const grupos = [];
  let inicio = 0;
  for (let g = 0; g < numGrupos; g++) {
    const tamanho = base + (resto > 0 ? 1 : 0);
    if (resto > 0) resto--;
    grupos.push(timeIds.slice(inicio, inicio + tamanho));
    inicio += tamanho;
  }
  return grupos;
}

export function embaralhar(lista) {
  const arr = [...lista];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------- mata-mata ----------

export const ehPotenciaDe2 = (n) => n >= 2 && (n & (n - 1)) === 0;

// Ordem classica de chaveamento por cabecas de chave (1-indexada).
// n=8 -> [1, 8, 4, 5, 2, 7, 3, 6]: 1 e 2 so se encontram na final.
export function ordemChaveamento(n) {
  let ordem = [1];
  while (ordem.length < n) {
    const m = ordem.length * 2;
    const nova = [];
    for (const s of ordem) nova.push(s, m + 1 - s);
    ordem = nova;
  }
  return ordem;
}

// Gera todas as rodadas do mata-mata a partir dos seeds.
// pareamento 'seeds' (padrao): chaveamento classico por forca (1 x ultimo, 2 x penultimo...),
//   usado quando os seeds vem da classificacao dos grupos (cruza 1oA x 2oB etc.).
// pareamento 'lista': a ordem da lista define os confrontos (1o x 2o, 3o x 4o...),
//   usado no mata-mata puro para o organizador montar o chaveamento na mao.
// Rodadas futuras ficam com times nulos, preenchidos conforme os vencedores avancam.
// Devolve [{ rodada, confronto, perna, time_casa_id, time_fora_id }].
export function gerarMataMata(seeds, { idaEVolta = false, pareamento = 'seeds' } = {}) {
  const n = seeds.length;
  if (!ehPotenciaDe2(n)) {
    throw erroValidacao(
      `O mata-mata exige numero de times potencia de 2 (2, 4, 8, 16...). Recebi ${n}.`,
    );
  }
  const ordem = ordemChaveamento(n);
  const totalRodadas = Math.log2(n);
  const jogos = [];

  for (let r = 1; r <= totalRodadas; r++) {
    const confrontos = n / 2 ** r;
    for (let c = 0; c < confrontos; c++) {
      let casa = null;
      let fora = null;
      if (r === 1) {
        if (pareamento === 'lista') {
          casa = seeds[2 * c];
          fora = seeds[2 * c + 1];
        } else {
          casa = seeds[ordem[2 * c] - 1];
          fora = seeds[ordem[2 * c + 1] - 1];
        }
      }
      // Final e sempre jogo unico quando idaEVolta = false; com idaEVolta, todas tem 2 pernas.
      const pernas = idaEVolta ? 2 : 1;
      for (let p = 1; p <= pernas; p++) {
        jogos.push({
          rodada: r,
          confronto: c,
          perna: p,
          // na perna 2 inverte o mando
          time_casa_id: p === 2 ? fora : casa,
          time_fora_id: p === 2 ? casa : fora,
        });
      }
    }
  }
  return jogos;
}

// Nome amigavel da rodada do mata-mata pelo numero de confrontos que ela tem.
export function nomeFaseMata(confrontosNaRodada) {
  switch (confrontosNaRodada) {
    case 1: return 'Final';
    case 2: return 'Semifinal';
    case 4: return 'Quartas de final';
    case 8: return 'Oitavas de final';
    case 16: return '16 avos de final';
    default: return `Fase de ${confrontosNaRodada * 2} times`;
  }
}

// Decide o vencedor de um confronto dadas as pernas ENCERRADAS.
// Placar agregado; empate agregado decide nos penaltis da ultima perna.
// Devolve o time_id vencedor ou null se ainda indefinido.
export function vencedorConfronto(pernas) {
  if (!pernas.length || pernas.some((j) => j.status !== 'encerrado')) return null;
  const primeira = pernas[0];
  // Referencia: "timeA" = mandante da perna 1.
  const timeA = primeira.time_casa_id;
  const timeB = primeira.time_fora_id;
  let golsA = 0;
  let golsB = 0;
  for (const j of pernas) {
    if (j.time_casa_id === timeA) {
      golsA += j.gols_casa;
      golsB += j.gols_fora;
    } else {
      golsA += j.gols_fora;
      golsB += j.gols_casa;
    }
  }
  if (golsA > golsB) return timeA;
  if (golsB > golsA) return timeB;
  // Empate agregado: penaltis da ultima perna.
  const ultima = pernas[pernas.length - 1];
  if (ultima.penaltis_casa == null || ultima.penaltis_fora == null) return null;
  if (ultima.penaltis_casa === ultima.penaltis_fora) return null;
  return ultima.penaltis_casa > ultima.penaltis_fora ? ultima.time_casa_id : ultima.time_fora_id;
}

// Ordena os classificados dos grupos em seeds: todos os 1os colocados
// (na ordem dos grupos), depois todos os 2os, e assim por diante.
// Combinado com ordemChaveamento (1 x ultimo, 2 x penultimo...), isso cruza
// os grupos: com 2 grupos e 2 vagas, sai 1oA x 2oB e 1oB x 2oA.
// classificadosPorGrupo: [[1oA, 2oA, ...], [1oB, 2oB, ...], ...] (ids de time)
export function seedsDeGrupos(classificadosPorGrupo, porGrupo) {
  const seeds = [];
  for (let pos = 0; pos < porGrupo; pos++) {
    seeds.push(...classificadosPorGrupo.map((g) => g[pos]).filter((id) => id != null));
  }
  return seeds;
}
