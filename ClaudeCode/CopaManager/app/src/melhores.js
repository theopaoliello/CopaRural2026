// Melhores Colocados (EF v1.0): vagas extras e corte no mata-mata do formato
// misto. Quando grupos x classificados nao fecha potencia de 2, o sistema
// COMPLETA para a potencia acima com os melhores (C+1)-esimos (repescagem,
// estilo "melhores terceiros" da Copa) ou, quando completar e impossivel,
// CORTA para a potencia abaixo mantendo so os melhores C-esimos.
// Funcoes puras: nada aqui toca banco; o ranking entre grupos e sempre
// derivado da classificacao ja calculada (classificacao nunca e armazenada).
import { ehPotenciaDe2, ordemChaveamento } from './tabela.js';

// Tamanho previsto de cada grupo na criacao — mesma aritmetica sequencial de
// dividirEmGrupos (os primeiros grupos ficam com a sobra).
export function tamanhosPrevistos(totalTimes, numGrupos) {
  const base = Math.floor(totalTimes / numGrupos);
  const resto = totalTimes % numGrupos;
  return Array.from({ length: numGrupos }, (_, g) => base + (g < resto ? 1 : 0));
}

const potenciaAcima = (n) => { let p = 2; while (p < n) p *= 2; return p; };
const potenciaAbaixo = (n) => { let p = 2; while (p * 2 <= n) p *= 2; return p; };

// Plano de vagas do mata-mata (RN-MC-02). tamanhos: times por grupo.
// Potencia exata nao muda nada; senao prefere COMPLETAR (repescagem) e so
// entao CORTAR. Devolve sempre um objeto — 'inviavel' nao lanca; quem valida
// (criacao) decide o que fazer.
// { modo, vagas, diretosPorGrupo, posicaoDisputa, emDisputa }
//   repescagem: posicaoDisputa = C+1, emDisputa = vagas extras
//   corte:      posicaoDisputa = C,   emDisputa = quantos C-esimos avancam
export function planoDeVagas({ numGrupos, classificados, tamanhos }) {
  const total = numGrupos * classificados;
  const menorGrupo = Math.min(...tamanhos);
  if (ehPotenciaDe2(total) && classificados <= menorGrupo) {
    return { modo: 'exata', vagas: total, diretosPorGrupo: classificados, posicaoDisputa: null, emDisputa: 0 };
  }

  // Completar: E vagas extras para os E melhores (C+1)-esimos — exige uma
  // vaga extra por grupo no maximo e que todos os grupos tenham a posicao C+1.
  const acima = potenciaAcima(total + 1);
  const extras = acima - total;
  if (extras <= numGrupos && menorGrupo >= classificados + 1) {
    return {
      modo: 'repescagem', vagas: acima, diretosPorGrupo: classificados,
      posicaoDisputa: classificados + 1, emDisputa: extras,
    };
  }

  // Cortar: os X piores C-esimos ficam de fora (precisa sobrar pelo menos um).
  const abaixo = potenciaAbaixo(total);
  const cortados = total - abaixo;
  if (abaixo >= 2 && cortados < numGrupos && menorGrupo >= classificados) {
    return {
      modo: 'corte', vagas: abaixo, diretosPorGrupo: classificados - 1,
      posicaoDisputa: classificados, emDisputa: numGrupos - cortados,
    };
  }

  return { modo: 'inviavel', vagas: null, diretosPorGrupo: null, posicaoDisputa: null, emDisputa: 0 };
}

// Sugestao para combinacao inviavel: menor mudanca em classificados (mesmos
// grupos), depois menor mudanca em grupos (mesmos classificados). Prefere
// planos sem corte (exata/repescagem) — e o que faz 5x5 sugerir 5x3 e nao 5x4.
// Devolve { numGrupos, classificados, plano } ou null.
export function sugerirCombinacao({ numGrupos, classificados, totalTimes }) {
  const viavel = (g, c, semCorte) => {
    if (g < 1 || c < 1 || totalTimes < g * 2) return null;
    const plano = planoDeVagas({ numGrupos: g, classificados: c, tamanhos: tamanhosPrevistos(totalTimes, g) });
    if (plano.modo === 'inviavel' || (semCorte && plano.modo === 'corte')) return null;
    // Mesma regra da criacao: potencia exata com todos os grupos classificando
    // inteiros nao vale como sugestao.
    if (plano.modo === 'exata' && c >= Math.floor(totalTimes / g) && totalTimes % g === 0) return null;
    return { numGrupos: g, classificados: c, plano };
  };

  for (const semCorte of [true, false]) {
    // 1) varia so os classificados, do desvio menor para o maior
    for (let d = 1; d <= 16; d++) {
      for (const c of [classificados - d, classificados + d]) {
        const s = viavel(numGrupos, c, semCorte);
        if (s) return s;
      }
    }
    // 2) varia so os grupos
    for (let d = 1; d <= 16; d++) {
      for (const g of [numGrupos - d, numGrupos + d]) {
        const s = viavel(g, classificados, semCorte);
        if (s) return s;
      }
    }
  }
  return null;
}

// Frase curta da sugestao, relativa a combinacao atual: so menciona o que muda.
export function textoSugestao(sugestao, { numGrupos, classificados }) {
  if (!sugestao) return null;
  const partes = [];
  if (sugestao.numGrupos !== numGrupos) partes.push(`${sugestao.numGrupos} grupos`);
  if (sugestao.classificados !== classificados) partes.push(`${sugestao.classificados} classificados por grupo`);
  return partes.join(' x ') || null;
}

const ordinal = (n) => `${n}º`;

// Frase unica do efeito do plano, usada no wizard, na aba Config e no card de
// gerar o mata-mata (RN-MC-06).
export function resumoDoPlano(plano, { numGrupos, classificados, tamanhos = [] } = {}) {
  if (plano.modo === 'inviavel') return '⚠️ Combinação inviável.';
  if (plano.modo === 'exata') {
    const c = plano.diretosPorGrupo;
    return `✅ Chave de ${plano.vagas}: ${c === 1 ? 'o 1º colocado' : `os ${c} primeiros`} de cada grupo se ${c === 1 ? 'classifica' : 'classificam'}.`;
  }
  const pos = ordinal(plano.posicaoDisputa);
  if (plano.modo === 'corte') {
    const fora = numGrupos - plano.emDisputa;
    return `✅ Chave de ${plano.vagas}: apenas ${plano.emDisputa === 1 ? `o melhor ${pos}` : `os ${plano.emDisputa} melhores ${pos}s`} avança${plano.emDisputa === 1 ? '' : 'm'} (${fora} fica${fora === 1 ? '' : 'm'} de fora).`;
  }
  // repescagem
  const um = plano.emDisputa === 1;
  const melhores = um ? `o melhor ${pos}` : `os ${plano.emDisputa} melhores ${pos}s`;
  const todosClassificam = plano.emDisputa === numGrupos
    && tamanhos.length > 0 && tamanhos.every((t) => t === plano.posicaoDisputa);
  if (todosClassificam) {
    return `✅ Chave de ${plano.vagas}: ${melhores} completa${um ? '' : 'm'} — equivale a classificar ${plano.posicaoDisputa} por grupo.`;
  }
  return `✅ Chave de ${plano.vagas}: ${numGrupos * plano.diretosPorGrupo} classificados diretos + ${melhores} colocado${um ? '' : 's'}.`;
}

// ---------- ranking entre grupos (RN-MC-03) ----------

// Comparar times de grupos diferentes usa os criterios do esporte em MEDIA
// POR JOGO — robusto a grupos de tamanhos diferentes. Razoes e percentuais ja
// sao normalizados: valem identicos aos da classificacao (0/0 = 0, x/0 = MAX).
// 'confronto' e 'cartoes' nao se aplicam entre grupos e sao pulados.
const porJogo = (v, pj) => (pj > 0 ? v / pj : 0);
const razao = (a, b) => (b === 0 ? (a === 0 ? 0 : Infinity) : a / b);
const pct = (a, b) => (a + b === 0 ? 0 : a / (a + b));

const VALOR_POR_CRITERIO = {
  pts: (l) => porJogo(l.pts, l.pj),
  vitorias: (l) => porJogo(l.v, l.pj),
  saldo: (l) => porJogo(l.sg, l.pj),
  gols_pro: (l) => porJogo(l.gp, l.pj),
  saldo_sets: (l) => porJogo(l.saldo_sets, l.pj),
  saldo_pontos: (l) => porJogo(l.saldo_pontos, l.pj),
  pontos_pro: (l) => porJogo(l.pp, l.pj),
  razao_sets: (l) => razao(l.sv, l.sp),
  razao_pontos: (l) => razao(l.pp, l.pc),
  pct_sets: (l) => pct(l.sv, l.sp),
  pct_pontos: (l) => pct(l.pp, l.pc),
};

// Criterios aplicaveis entre grupos, na mesma ordem da classificacao do grupo,
// sempre puxados por pontos por jogo.
export function criteriosDeMedia(criterios) {
  return ['pts', ...(criterios ?? []).filter((c) => c !== 'pts' && VALOR_POR_CRITERIO[c])];
}

export function mediaDoCriterio(linha, criterio) {
  return VALOR_POR_CRITERIO[criterio]?.(linha) ?? 0;
}

// Ordena candidatos (linhas de classificacao, de grupos diferentes) do melhor
// para o pior. Empate total: ordem alfabetica (deterministico, RN-MC-03).
export function rankearEntreGrupos(candidatos, criterios) {
  const ordem = criteriosDeMedia(criterios);
  return [...candidatos].sort((a, b) => {
    for (const c of ordem) {
      const cmp = mediaDoCriterio(b, c) - mediaDoCriterio(a, c);
      // Infinity - Infinity = NaN: dois candidatos "MAX" seguem empatados.
      if (cmp !== 0 && !Number.isNaN(cmp)) return cmp;
    }
    return a.nome.localeCompare(b.nome, 'pt-BR');
  });
}

// ---------- seeds por potes e anti-reencontro (RN-MC-04) ----------

// Monta os seeds do mata-mata com vagas extras ou corte: potes de posicao —
// todos os 1os (na ordem dos grupos), depois os 2os, ..., e os classificados
// pelo ranking entre grupos por ultimo (na ordem do ranking).
// classifPorGrupo: [[linhas do grupo A], [linhas do grupo B], ...]
// Devolve { seeds, poteDoTime (Map id->pote), repescados ([time_id]) }.
export function montarSeeds(classifPorGrupo, plano, ranking) {
  const seeds = [];
  const poteDoTime = new Map();
  for (let pos = 0; pos < plano.diretosPorGrupo; pos++) {
    for (const linhas of classifPorGrupo) {
      const linha = linhas[pos];
      if (!linha) continue;
      seeds.push(linha.time_id);
      poteDoTime.set(linha.time_id, pos + 1);
    }
  }
  const repescados = ranking.slice(0, plano.emDisputa).map((l) => l.time_id);
  for (const id of repescados) {
    seeds.push(id);
    poteDoTime.set(id, plano.diretosPorGrupo + 1);
  }
  return { seeds, poteDoTime, repescados };
}

// Confrontos da 1a fase pelo chaveamento classico por forca (1 x ultimo...),
// como pares [casa, fora]. `pares.flat()` + pareamento 'lista' reproduz em
// gerarMataMata exatamente o mesmo bracket do pareamento 'seeds'.
export function confrontosDaPrimeiraFase(seeds) {
  const ordem = ordemChaveamento(seeds.length);
  const pares = [];
  for (let c = 0; c < seeds.length / 2; c++) {
    pares.push([seeds[ordem[2 * c] - 1], seeds[ordem[2 * c + 1] - 1]]);
  }
  return pares;
}

// Desfaz reencontros de grupo na 1a fase trocando um time por outro DO MESMO
// POTE no confronto mais proximo que resolva (mantem o equilibrio do
// bracket). Quando nenhuma troca resolve, o reencontro e permitido e
// sinalizado. Devolve { pares, reencontros: [indices de confronto] }.
export function ajustarReencontros(pares, grupoDoTime, poteDoTime) {
  const ajustados = pares.map((p) => [...p]);
  const conflito = (par) => grupoDoTime.get(par[0]) != null
    && grupoDoTime.get(par[0]) === grupoDoTime.get(par[1]);

  // Passadas ate estabilizar: uma troca pode abrir espaco para a proxima.
  for (let passada = 0; passada < ajustados.length; passada++) {
    let mudou = false;
    for (let c = 0; c < ajustados.length; c++) {
      if (!conflito(ajustados[c])) continue;
      // Tenta primeiro trocar o seed mais fraco (pote maior) do confronto.
      const lados = [0, 1].sort(
        (x, y) => (poteDoTime.get(ajustados[c][y]) ?? 0) - (poteDoTime.get(ajustados[c][x]) ?? 0),
      );
      busca:
      for (let d = 1; d < ajustados.length; d++) {
        for (const v of [c - d, c + d]) {
          if (v < 0 || v >= ajustados.length) continue;
          for (const x of lados) {
            for (const y of [0, 1]) {
              if (poteDoTime.get(ajustados[c][x]) !== poteDoTime.get(ajustados[v][y])) continue;
              [ajustados[c][x], ajustados[v][y]] = [ajustados[v][y], ajustados[c][x]];
              if (!conflito(ajustados[c]) && !conflito(ajustados[v])) {
                mudou = true;
                break busca;
              }
              [ajustados[c][x], ajustados[v][y]] = [ajustados[v][y], ajustados[c][x]]; // desfaz
            }
          }
        }
      }
    }
    if (!mudou) break;
  }

  const reencontros = ajustados.map((p, c) => (conflito(p) ? c : -1)).filter((c) => c >= 0);
  return { pares: ajustados, reencontros };
}
