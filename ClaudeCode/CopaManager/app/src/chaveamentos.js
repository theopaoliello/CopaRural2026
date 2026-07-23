// Catalogo de chaveamentos e motor da chave manual (EF Mata-mata Manual
// Personalizado, fase A). Aqui mora tudo o que permite uma chave com um
// numero de participantes que NAO fecha potencia de 2: 3, 5, 6, 7, 9...
//
// O modelo: toda chave e um esqueleto de potencia de 2 com FOLGAS. Folga nao
// gera jogo — o participante entra direto numa rodada posterior. Isso mantem
// intacta a propagacao ja existente do produto (o confronto c alimenta o
// confronto floor(c/2) da rodada seguinte, e confronto par ocupa o mando).
//
// Um desenho e uma ARVORE de confrontos: cada no sabe em que RODADA acontece
// e as folhas sao POSICOES DE ENTRADA (1 = P1, 2 = P2...). O filho da esquerda
// e o mandante (casa) e recebe o indice 2c; o da direita, visitante, 2c+1 —
// e e essa escolha que faz arvore, indices e mando baterem por construcao.
// Funcoes puras: nada aqui toca banco.
import { erroValidacao } from './erros.js';
import { ordemChaveamento, ehPotenciaDe2 } from './tabela.js';

// Limites da chave manual (RN-MM-02): potencias de 2 sao do modelo Padrao.
export const MIN_VAGAS = 3;
export const MAX_VAGAS = 32;

const confronto = (rodada, esquerda, direita) => ({ rodada, esquerda, direita });
const ehVaga = (no) => typeof no === 'number';

// ---------- expansao: da arvore para indices de rodada/confronto ----------

// Devolve { vagas, rodadas, jogos, confrontos, slots, aceita_disputa_terceiro }.
// `slots` diz onde cada posicao de entrada senta; `confrontos` lista os jogos
// que existem. Ambos ja em indices do esqueleto — folgas simplesmente nao
// aparecem em `confrontos`.
export function expandirDesenho(arvore) {
  if (ehVaga(arvore)) throw erroValidacao('Desenho de chaveamento invalido: a raiz precisa ser um confronto.');
  const confrontos = [];
  const slots = [];

  (function visitar(no, indice) {
    if (no.rodada < 1) throw erroValidacao('Desenho de chaveamento invalido: rodada fora de faixa.');
    confrontos.push({ rodada: no.rodada, confronto: indice });
    for (const [filho, lado, indiceFilho] of [
      [no.esquerda, 'casa', indice * 2],
      [no.direita, 'fora', indice * 2 + 1],
    ]) {
      if (ehVaga(filho)) {
        slots.push({ posicao: filho, rodada: no.rodada, confronto: indice, lado });
        continue;
      }
      // Um confronto so pode ser alimentado pela rodada imediatamente anterior:
      // pular rodada significaria um vencedor "sumindo" no meio da chave.
      if (filho.rodada !== no.rodada - 1) {
        throw erroValidacao('Desenho de chaveamento invalido: confronto alimentado por rodada nao adjacente.');
      }
      visitar(filho, indiceFilho);
    }
  }(arvore, 0));

  const posicoes = slots.map((s) => s.posicao).sort((a, b) => a - b);
  const vagas = posicoes.length;
  const esperadas = Array.from({ length: vagas }, (_, i) => i + 1);
  if (posicoes.some((p, i) => p !== esperadas[i])) {
    throw erroValidacao('Desenho de chaveamento invalido: as posicoes precisam ir de 1 a N, sem repetir.');
  }
  // Invariante da eliminacao simples: cada confronto elimina exatamente um.
  if (confrontos.length !== vagas - 1) {
    throw erroValidacao('Desenho de chaveamento invalido: uma chave de N participantes tem N-1 confrontos.');
  }

  const rodadas = arvore.rodada;
  const naPenultima = confrontos.filter((c) => c.rodada === rodadas - 1).length;
  return {
    vagas,
    rodadas,
    jogos: confrontos.length,
    // RN-MM-21: so ha 3o lugar definido com duas semifinais de verdade.
    aceita_disputa_terceiro: naPenultima === 2,
    confrontos: confrontos.sort((a, b) => a.rodada - b.rodada || a.confronto - b.confronto),
    slots: slots.sort((a, b) => a.posicao - b.posicao),
  };
}

// ---------- desenho padrao com folgas (serve para qualquer N) ----------

const potenciaAcima = (n) => { let p = 2; while (p < n) p *= 2; return p; };

// Chave classica por forca com folgas para os primeiros cabecas: o esqueleto
// e a menor potencia de 2 >= N e as vagas seguem a ordem de chaveamento
// (1 x ultimo, 2 x penultimo...). Com N potencia de 2 sai a chave cheia de
// hoje, confronto a confronto — e o que garante que o modelo Padrao nao muda.
export function desenhoPadrao(vagas) {
  if (!Number.isInteger(vagas) || vagas < 2) throw erroValidacao('Chave invalida: informe pelo menos 2 participantes.');
  const esqueleto = potenciaAcima(vagas);
  const ordem = ordemChaveamento(esqueleto);
  const rodadas = Math.log2(esqueleto);

  // Devolve um confronto ou — quando o adversario e folga — a propria vaga,
  // que sobe para a rodada seguinte.
  const montar = (rodada, indice) => {
    if (rodada === 1) {
      const [a, b] = [ordem[indice * 2], ordem[indice * 2 + 1]];
      const dentro = [a, b].filter((s) => s <= vagas);
      // Como a ordem casa o seed s com esqueleto+1-s, o menor dos dois e
      // sempre <= esqueleto/2 < N: nenhum confronto fica totalmente vazio.
      return dentro.length === 2 ? confronto(1, a, b) : dentro[0];
    }
    return confronto(rodada, montar(rodada - 1, indice * 2), montar(rodada - 1, indice * 2 + 1));
  };
  return montar(rodadas, 0);
}

// ---------- catalogo ----------

// Desenhos alternativos desenhados a mao (EF secao 4). O desenho "A" de cada N
// e sempre o padrao com folgas — nao esta repetido aqui, so nomeado.
const ALTERNATIVOS = {
  5: [
    {
      id: '5B',
      nome: 'Escada',
      quando: 'Uma rodada por jogo: os dois ultimos abrem e o vencedor sobe ate o lider. Premia fortemente a campanha.',
      arvore: confronto(4, confronto(3, confronto(2, confronto(1, 5, 4), 3), 2), 1),
      rodada_nomes: ['Fase 1', 'Fase 2', 'Semifinal', 'Final'],
    },
    {
      id: '5C',
      nome: 'Lider na final',
      quando: 'Quatro participantes disputam duas preliminares e uma semifinal; o lider entra direto na final.',
      arvore: confronto(3, confronto(2, confronto(1, 4, 5), confronto(1, 2, 3)), 1),
      rodada_nomes: ['Preliminares', 'Semifinal', 'Final'],
    },
  ],
  6: [
    {
      id: '6B',
      nome: 'Lider na final',
      quando: 'Um lado da chave sobe em quatro degraus enquanto o lider aguarda na decisao.',
      arvore: confronto(4, confronto(3, confronto(2, confronto(1, 5, 6), 4), confronto(2, 2, 3)), 1),
      rodada_nomes: ['Preliminar', 'Quartas', 'Semifinal', 'Final'],
    },
    {
      id: '6C',
      nome: 'Escada',
      quando: 'Cinco rodadas para cinco jogos: so faz sentido em torneio de um dia, com jogos curtos.',
      arvore: confronto(5, confronto(4, confronto(3, confronto(2, confronto(1, 5, 6), 4), 3), 2), 1),
      rodada_nomes: ['Fase 1', 'Fase 2', 'Fase 3', 'Semifinal', 'Final'],
    },
  ],
  7: [
    {
      id: '7B',
      nome: 'Preliminar dos ultimos',
      quando: 'Os dois ultimos jogam um a mais para entrar; 1o e 2o entram direto nas semifinais.',
      arvore: confronto(4,
        confronto(3, confronto(2, confronto(1, 6, 7), 5), 2),
        confronto(3, confronto(2, 3, 4), 1)),
      rodada_nomes: ['Preliminar', 'Quartas', 'Semifinais', 'Final'],
    },
    {
      id: '7C',
      nome: 'Lider na final',
      quando: 'O lider espera na decisao enquanto os outros seis disputam uma chave completa entre si.',
      arvore: confronto(4, 1,
        confronto(3, confronto(2, 2, confronto(1, 5, 6)), confronto(2, confronto(1, 4, 7), 3))),
      rodada_nomes: ['Preliminares', 'Quartas', 'Semifinal', 'Final'],
    },
  ],
  9: [
    {
      id: '9B',
      nome: 'Dois play-ins',
      quando: 'Quatro participantes brigam por duas vagas nas quartas e o 3o ganha folga ate a semifinal.',
      arvore: confronto(4,
        confronto(3, confronto(2, 1, confronto(1, 8, 9)), confronto(2, 4, 5)),
        confronto(3, confronto(2, 2, confronto(1, 6, 7)), 3)),
      rodada_nomes: ['Play-ins', 'Quartas', 'Semifinais', 'Final'],
    },
    {
      id: '9C',
      nome: 'Lider na final',
      quando: 'O 1o colocado vai direto a grande final; os outros oito jogam uma chave de 8 inteira.',
      arvore: confronto(4, 1,
        confronto(3,
          confronto(2, confronto(1, 2, 9), confronto(1, 5, 6)),
          confronto(2, confronto(1, 4, 7), confronto(1, 3, 8)))),
      rodada_nomes: ['Play-in', 'Quartas', 'Semifinal', 'Final'],
    },
  ],
};

// Nome e descricao do desenho padrao por N (o "A" de cada tamanho).
const PADRAO_POR_VAGAS = {
  3: ['3A', 'Semifinal unica', 'Um participante espera na final. E o unico desenho possivel com 3.'],
  5: ['5A', 'Preliminar + semifinais', 'Tres folgas e um jogo preliminar entre os dois ultimos. Chave curta e equilibrada.'],
  6: ['6A', 'Quartas com 2 folgas', 'Os dois melhores esperam nas semifinais. E o formato mais usado com 6 participantes.'],
  7: ['7A', 'Quartas com 1 folga', 'Chave de 8 com um convidado a menos: so o lider folga.'],
  9: ['9A', 'Play-in + chave de 8', 'O 8o e o 9o disputam a ultima vaga; dali em diante e uma chave de 8 classica.'],
};

function desenhoCompleto({ id, nome, quando, arvore, rodada_nomes }, vagas) {
  const expandido = expandirDesenho(arvore ?? desenhoPadrao(vagas));
  if (expandido.vagas !== vagas) {
    throw erroValidacao(`Desenho ${id} declara ${expandido.vagas} vagas, mas esta no catalogo de ${vagas}.`);
  }
  return { id, nome, quando, rodada_nomes: rodada_nomes ?? null, ...expandido };
}

// Catalogo de um tamanho de chave: o padrao com folgas primeiro (recomendado),
// depois os alternativos. Potencias de 2 nao entram (RN-MM-02): chave cheia
// nao tem folga nem desenho a escolher, e e do modelo Padrao.
export function catalogoDeChaveamentos(vagas) {
  const n = Number(vagas);
  if (!Number.isInteger(n) || n < MIN_VAGAS || n > MAX_VAGAS) {
    throw erroValidacao(`A chave manual aceita de ${MIN_VAGAS} a ${MAX_VAGAS} participantes.`);
  }
  if (ehPotenciaDe2(n)) {
    throw erroValidacao(`Com ${n} participantes a chave e cheia: use o modelo Padrao, que ja monta o chaveamento.`);
  }
  const [id, nome, quando] = PADRAO_POR_VAGAS[n]
    ?? [`${n}A`, 'Padrao com folgas', 'Chave classica por forca, com folga para os primeiros colocados.'];
  return [
    { ...desenhoCompleto({ id, nome, quando }, n), recomendado: true },
    ...(ALTERNATIVOS[n] ?? []).map((d) => ({ ...desenhoCompleto(d, n), recomendado: false })),
  ];
}

export function obterDesenho(vagas, id) {
  const achado = catalogoDeChaveamentos(vagas).find((d) => d.id === id);
  if (!achado) throw erroValidacao(`Chaveamento "${id}" nao existe para ${vagas} participantes.`);
  return achado;
}

// ---------- geracao dos jogos ----------

// Monta os jogos de uma chave manual. `timesPorPosicao` traz o time de cada
// posicao de entrada, na ordem P1..PN. Confrontos alimentados por outros
// nascem sem times (as vagas se preenchem pela propagacao, como sempre).
// Mesmo formato de gerarMataMata: [{ rodada, confronto, perna, time_casa_id, time_fora_id }].
export function gerarChaveManual(desenho, timesPorPosicao, { idaEVolta = false } = {}) {
  const expandido = desenho.confrontos ? desenho : expandirDesenho(desenho);
  const times = [...timesPorPosicao];
  if (times.length !== expandido.vagas) {
    throw erroValidacao(`Este chaveamento tem ${expandido.vagas} vagas e recebi ${times.length} participantes.`);
  }
  if (times.some((t) => t == null)) throw erroValidacao('Ha vagas do chaveamento sem participante.');
  if (new Set(times).size !== times.length) throw erroValidacao('Um participante nao pode ocupar duas vagas.');

  const doSlot = new Map(
    expandido.slots.map((s) => [`${s.rodada}:${s.confronto}:${s.lado}`, times[s.posicao - 1]]),
  );
  const jogos = [];
  for (const { rodada, confronto: indice } of expandido.confrontos) {
    const casa = doSlot.get(`${rodada}:${indice}:casa`) ?? null;
    const fora = doSlot.get(`${rodada}:${indice}:fora`) ?? null;
    const pernas = idaEVolta ? 2 : 1;
    for (let p = 1; p <= pernas; p++) {
      jogos.push({
        rodada,
        confronto: indice,
        perna: p,
        // na perna 2 inverte o mando, como no mata-mata de sempre
        time_casa_id: p === 2 ? fora : casa,
        time_fora_id: p === 2 ? casa : fora,
      });
    }
  }
  return jogos;
}
