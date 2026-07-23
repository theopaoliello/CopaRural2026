// Rotulos de vaga do mata-mata no formato misto (EF Mata-mata Manual, fase C).
// No modelo Manual quem classifica NAO sai de uma conta (grupos x classificados):
// sai do que o gestor declara em cada vaga da chave — "1o do Grupo A",
// "Melhor 3o". A repescagem/corte automatica (RN-MC-02) nao se aplica aqui
// (RN-MM-11); o ranking entre grupos, sim, e reaproveitado inteiro (RN-MM-09).
// Funcoes puras: nada aqui toca banco.
import { erroValidacao } from './erros.js';
import { rankearEntreGrupos } from './melhores.js';

export const LETRAS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const ordinal = (n) => `${n}º`;

// Formatos de rotulo:
//   { tipo: 'grupo_posicao',  grupo: 'A', posicao: 1 }  -> "1º do Grupo A"
//   { tipo: 'melhor_posicao', posicao: 3, ordem: 1 }    -> "Melhor 3º"
export function textoRotulo(r) {
  if (!r) return 'A definir';
  if (r.tipo === 'grupo_posicao') return `${ordinal(r.posicao)} do Grupo ${r.grupo}`;
  return r.ordem === 1
    ? `Melhor ${ordinal(r.posicao)}`
    : `${ordinal(r.ordem)} melhor ${ordinal(r.posicao)}`;
}

export const chaveRotulo = (r) => (r.tipo === 'grupo_posicao'
  ? `g:${r.grupo}:${r.posicao}`
  : `m:${r.posicao}:${r.ordem}`);

// Distribuicao classica: potes por posicao (todos os 1os na ordem dos grupos,
// depois os 2os...), e o que sobrar vira "melhores k-esimos" da posicao
// seguinte — a mesma logica dos seeds de hoje, so que declarada. Devolve os
// rotulos na ordem das posicoes do desenho (P1..PN).
export function rotulosPadrao(vagas, numGrupos) {
  const diretos = Math.floor(vagas / numGrupos);
  const resto = vagas % numGrupos;
  const lista = [];
  for (let p = 1; p <= diretos; p++) {
    for (let g = 0; g < numGrupos; g++) {
      lista.push({ tipo: 'grupo_posicao', grupo: LETRAS[g], posicao: p });
    }
  }
  for (let k = 1; k <= resto; k++) {
    lista.push({ tipo: 'melhor_posicao', posicao: diretos + 1, ordem: k });
  }
  return lista;
}

// ---------- anti-reencontro na 1a fase ----------

// Grupo "dono" do rotulo. Melhor colocado nao tem grupo definido antes do fim
// da fase de grupos, entao nunca conta como reencontro.
const grupoDoRotulo = (r) => (r?.tipo === 'grupo_posicao' ? r.grupo : null);

// Confrontos em que DUAS vagas declaradas se encontram direto (as duas pontas
// sao entrada). E onde um reencontro de grupo pode nascer.
function paresDiretos(desenho) {
  return desenho.confrontos.map((c) => {
    const lado = (l) => desenho.slots.find(
      (s) => s.rodada === c.rodada && s.confronto === c.confronto && s.lado === l,
    );
    const casa = lado('casa');
    const fora = lado('fora');
    return casa && fora ? { rodada: c.rodada, confronto: c.confronto, posicoes: [casa.posicao, fora.posicao] } : null;
  }).filter(Boolean);
}

// Confrontos que hoje reuniriam dois times do mesmo grupo (RN-MC-04, versao
// declarada). Serve de aviso na tela — o gestor decide se quer mudar.
export function reencontrosDosRotulos(rotulos, desenho) {
  return paresDiretos(desenho)
    .filter(({ posicoes: [a, b] }) => {
      const ga = grupoDoRotulo(rotulos[a - 1]);
      return ga && ga === grupoDoRotulo(rotulos[b - 1]);
    })
    .map(({ rodada, confronto, posicoes }) => ({
      rodada, confronto, grupo: grupoDoRotulo(rotulos[posicoes[0] - 1]),
    }));
}

// Desfaz reencontros trocando vagas do MESMO POTE (mesma posicao de grupo),
// que e o que preserva o equilibrio da chave. Quando nenhuma troca resolve, o
// reencontro fica — e sinalizado, nao escondido.
export function evitarReencontros(rotulos, desenho) {
  const lista = [...rotulos];
  const pares = paresDiretos(desenho);
  const conflita = ([a, b]) => {
    const ga = grupoDoRotulo(lista[a - 1]);
    return !!ga && ga === grupoDoRotulo(lista[b - 1]);
  };
  const mesmoPote = (x, y) => lista[x - 1].tipo === lista[y - 1].tipo
    && lista[x - 1].posicao === lista[y - 1].posicao;

  for (let passada = 0; passada < pares.length + 1; passada++) {
    const alvo = pares.find((p) => conflita(p.posicoes));
    if (!alvo) break;
    // Troca o de pote mais baixo (posicao maior): mexe menos na cabeca da chave.
    const [a, b] = alvo.posicoes;
    const trocar = lista[a - 1].posicao >= lista[b - 1].posicao ? a : b;
    let resolveu = false;
    for (let j = 1; j <= lista.length && !resolveu; j++) {
      if (j === trocar || !mesmoPote(trocar, j)) continue;
      [lista[trocar - 1], lista[j - 1]] = [lista[j - 1], lista[trocar - 1]];
      if (!pares.some((p) => conflita(p.posicoes))) resolveu = true;
      else [lista[trocar - 1], lista[j - 1]] = [lista[j - 1], lista[trocar - 1]];
    }
    if (!resolveu) break;
  }
  return lista;
}

// Grupos elegiveis ao ranking de uma posicao (RN-MM-09): os que NAO classificam
// direto naquela posicao — quem ja entrou pela porta da frente nao disputa a
// repescagem da mesma posicao.
export function gruposElegiveis(rotulos, posicao, nomesGrupos) {
  const diretos = new Set(
    rotulos.filter((r) => r.tipo === 'grupo_posicao' && r.posicao === posicao).map((r) => r.grupo),
  );
  return nomesGrupos.filter((g) => !diretos.has(g));
}

// `grupos`: [{ nome, tamanho }] na ordem A, B, C...
export function validarRotulos(rotulos, { vagas, grupos }) {
  if (!Array.isArray(rotulos) || rotulos.length !== vagas) {
    throw erroValidacao(`Informe as ${vagas} vagas do chaveamento.`);
  }
  const nomes = grupos.map((g) => g.nome);
  const tamanho = new Map(grupos.map((g) => [g.nome, g.tamanho]));
  const vistos = new Set();

  for (const r of rotulos) {
    if (!r || (r.tipo !== 'grupo_posicao' && r.tipo !== 'melhor_posicao')) {
      throw erroValidacao('Ha vaga sem rotulo valido no chaveamento.');
    }
    const posicao = Number(r.posicao);
    if (!Number.isInteger(posicao) || posicao < 1) throw erroValidacao('Posicao de classificacao invalida.');

    if (r.tipo === 'grupo_posicao') {
      if (!nomes.includes(r.grupo)) throw erroValidacao(`O grupo ${r.grupo} nao existe neste campeonato.`);
      if (posicao > tamanho.get(r.grupo)) {
        throw erroValidacao(`O Grupo ${r.grupo} tem ${tamanho.get(r.grupo)} times: nao existe ${ordinal(posicao)} colocado.`);
      }
    } else {
      const ordem = Number(r.ordem);
      if (!Number.isInteger(ordem) || ordem < 1) throw erroValidacao('Ordem do melhor colocado invalida.');
    }
    const k = chaveRotulo(r);
    if (vistos.has(k)) throw erroValidacao(`A vaga "${textoRotulo(r)}" esta repetida no chaveamento.`);
    vistos.add(k);
  }

  // Os "melhores k-esimos" precisam caber nos grupos que sobraram, e esses
  // grupos precisam ter a posicao disputada.
  const porPosicao = new Map();
  for (const r of rotulos.filter((x) => x.tipo === 'melhor_posicao')) {
    porPosicao.set(r.posicao, (porPosicao.get(r.posicao) ?? 0) + 1);
  }
  for (const [posicao, quantos] of porPosicao) {
    const elegiveis = gruposElegiveis(rotulos, posicao, nomes)
      .filter((g) => tamanho.get(g) >= posicao);
    if (quantos > elegiveis.length) {
      throw erroValidacao(
        `Nao ha ${quantos} grupo(s) disputando a vaga de melhor ${ordinal(posicao)}: apenas ${elegiveis.length} pode(m) entrar.`,
      );
    }
  }
  return rotulos;
}

// Zonas da fase de grupos derivadas dos rotulos (RN-MM-12): verde para as
// posicoes que classificam direto em TODOS os grupos; ambar para a posicao que
// ainda disputa vaga (direto em parte dos grupos, ou pelo ranking).
export function zonasDosRotulos(rotulos, nomesGrupos) {
  const contaPorPosicao = new Map();
  for (const r of rotulos.filter((x) => x.tipo === 'grupo_posicao')) {
    contaPorPosicao.set(r.posicao, (contaPorPosicao.get(r.posicao) ?? 0) + 1);
  }
  let diretos = 0;
  while (contaPorPosicao.get(diretos + 1) === nomesGrupos.length) diretos += 1;

  // A posicao em disputa e a primeira acima dos diretos que aparece de algum
  // jeito (parcialmente direta ou no ranking dos melhores).
  const posicoes = new Set([
    ...rotulos.map((r) => r.posicao),
  ]);
  let disputa = null;
  for (const p of [...posicoes].sort((a, b) => a - b)) {
    if (p > diretos) { disputa = p; break; }
  }
  return { diretosPorGrupo: diretos, posicaoDisputa: disputa };
}

// Resolve os rotulos na classificacao real. `porGrupo`: [{ grupo, linhas }] ja
// calculado e ordenado. Devolve os time_id na ordem dos rotulos (P1..PN).
export function resolverRotulos(rotulos, porGrupo, criterios) {
  const linhasDoGrupo = new Map(porGrupo.map((g) => [g.grupo.nome.replace(/^Grupo\s+/i, ''), g.linhas]));
  const nomes = [...linhasDoGrupo.keys()];

  // Ranking entre grupos, calculado uma vez por posicao disputada.
  const rankingPorPosicao = new Map();
  const rankingDe = (posicao) => {
    if (!rankingPorPosicao.has(posicao)) {
      const candidatos = gruposElegiveis(rotulos, posicao, nomes)
        .map((g) => {
          const linha = linhasDoGrupo.get(g)?.[posicao - 1];
          return linha ? { ...linha, grupo_nome: g } : null;
        })
        .filter(Boolean);
      rankingPorPosicao.set(posicao, rankearEntreGrupos(candidatos, criterios));
    }
    return rankingPorPosicao.get(posicao);
  };

  return rotulos.map((r) => {
    if (r.tipo === 'grupo_posicao') {
      const linha = linhasDoGrupo.get(r.grupo)?.[r.posicao - 1];
      if (!linha) throw erroValidacao(`Nao ha ${textoRotulo(r)}: confira a configuracao do chaveamento.`);
      return linha.time_id;
    }
    const linha = rankingDe(r.posicao)[r.ordem - 1];
    if (!linha) throw erroValidacao(`Nao ha ${textoRotulo(r)}: confira a configuracao do chaveamento.`);
    return linha.time_id;
  });
}

// Frase unica do efeito dos rotulos, no lugar do resumo do plano de vagas
// (que so vale no modelo Padrao). Aparece no cabecalho da classificacao, no
// card de gerar o mata-mata e na aba Config.
export function resumoDosRotulos(rotulos, nomesGrupos) {
  const { diretosPorGrupo, posicaoDisputa } = zonasDosRotulos(rotulos, nomesGrupos);
  const diretos = diretosPorGrupo * nomesGrupos.length;
  const extras = rotulos.length - diretos;
  const chave = `✅ Chave de ${rotulos.length}`;

  if (extras === 0) {
    return `${chave}: ${diretosPorGrupo === 1 ? 'o 1º colocado' : `os ${diretosPorGrupo} primeiros`} de cada grupo se ${diretosPorGrupo === 1 ? 'classifica' : 'classificam'}.`;
  }
  const melhores = rotulos.filter(
    (r) => r.tipo === 'melhor_posicao' && r.posicao === posicaoDisputa,
  ).length;
  const base = diretos > 0 ? `${diretos} classificado${diretos === 1 ? '' : 's'} direto${diretos === 1 ? '' : 's'}` : null;

  // Caso comum: os diretos de todos os grupos + os melhores da posicao seguinte.
  if (melhores === extras) {
    const pos = `${posicaoDisputa}º`;
    const texto = melhores === 1 ? `o melhor ${pos} colocado` : `os ${melhores} melhores ${pos}s colocados`;
    return base ? `${chave}: ${base} + ${texto}.` : `${chave}: ${texto}.`;
  }
  // Rotulos montados a dedo: descreve sem inventar regra.
  return `${chave}: ${base ? `${base} e mais ` : ''}${extras} vaga${extras === 1 ? '' : 's'} definida${extras === 1 ? '' : 's'} no chaveamento.`;
}

// Catalogo de rotulos que o gestor pode escolher na aba Chaveamento.
export function rotulosDisponiveis(grupos) {
  const maior = Math.max(0, ...grupos.map((g) => g.tamanho));
  const lista = [];
  for (let p = 1; p <= maior; p++) {
    for (const g of grupos) {
      if (g.tamanho >= p) lista.push({ tipo: 'grupo_posicao', grupo: g.nome, posicao: p });
    }
    // "Melhor pº" so faz sentido havendo mais de um grupo com a posicao.
    const comPosicao = grupos.filter((g) => g.tamanho >= p).length;
    for (let k = 1; k < Math.max(comPosicao, 1); k++) {
      lista.push({ tipo: 'melhor_posicao', posicao: p, ordem: k });
    }
  }
  return lista.map((r) => ({ ...r, chave: chaveRotulo(r), texto: textoRotulo(r) }));
}
