// Catalogo central de esportes (EF "Tipos de Campeonato" v1.0).
// O esporte e um preset estrutural escolhido UMA vez, na criacao do campeonato
// (RN-TC-01): wizard, validacao, classificacao e paginas consultam este
// catalogo — nenhum `if (esporte === ...)` espalhado pelo codigo (RN-TC-10).
//
// Dimensoes de cada preset:
// - placar: 'gols' (modelo A) | 'sets' (modelo B) | 'pontos' (modelo C)
// - empate: se um jogo pode terminar empatado na fase de liga/grupos
// - melhor_de: formatos de partida do modelo B (quantos sets fecham o jogo)
// - pontuacao: { vitoria, empate? , derrota? } ou { tipo: 'sets_bonus' }
//   (FIVB volei: vitoria no set decisivo vale menos — ver pontosDaPartidaSets)
// - criterios: ordem padrao de desempate | criterios_validos: aceitos na config
// - colunas: colunas da tabela de classificacao ([chave, rotulo, titulo])
// - rotulos: terminologia visivel (Time/Dupla, Artilharia/Cestinhas, pontos/games)
//
// Fases pendentes: basquete (fase 3) e Pelada Epica (fase 4) seguem "Em breve".
// A ORDEM deste array e a ordem fixa do menu do wizard (decisao de produto).

const COLUNAS_FUTEBOL = [
  ['pts', 'Pts', 'Pontos'], ['pj', 'PJ', 'Partidas jogadas'], ['v', 'V', 'Vitórias'],
  ['e', 'E', 'Empates'], ['d', 'D', 'Derrotas'], ['gp', 'GP', 'Gols pró'],
  ['gc', 'GC', 'Gols contra'], ['sg', 'SG', 'Saldo de gols'], ['ultimos', 'Últ. Jogos', 'Últimos jogos'],
];

const CRITERIOS_VALIDOS_SETS = [
  'vitorias', 'confronto', 'saldo_sets', 'saldo_pontos', 'razao_sets', 'razao_pontos',
  'pct_sets', 'pct_pontos',
];

export const ESPORTES = [
  {
    chave: 'futebol',
    nome: 'Futebol',
    icone: '/img/esportes/futebol.png',
    disponivel: true,
    variantes: ['Campo', 'Society', 'Futsal'],
    variante_padrao: 'Campo',
    placar: 'gols',
    empate: true,
    pontuacao: { vitoria: 3, empate: 1 },
    criterios: ['vitorias', 'saldo', 'gols_pro', 'confronto', 'cartoes'],
    criterios_validos: ['vitorias', 'saldo', 'gols_pro', 'confronto', 'cartoes'],
    colunas: COLUNAS_FUTEBOL,
    evento_individual: 'gol',
    tem_cartoes: true,
    rotulos: { participante: 'Time', participantes: 'Times', artilharia: 'Artilharia', individual: 'Gols', pontos: 'pontos' },
  },
  {
    chave: 'pelada_epica',
    nome: 'Pelada Épica',
    icone: '/img/esportes/pelada_epica.png',
    disponivel: false, // fase 4 (pede EF de detalhamento propria)
    variantes: [],
    placar: 'gols',
    empate: true,
    evento_individual: 'gol',
    rotulos: { participante: 'Jogador', participantes: 'Jogadores', artilharia: 'Artilharia', individual: 'Gols', pontos: 'pontos' },
  },
  {
    chave: 'futevolei',
    nome: 'Futevôlei',
    icone: '/img/esportes/futevolei.png',
    disponivel: true,
    variantes: ['2x2', '3x3', '4x4'],
    variante_padrao: '2x2',
    placar: 'sets',
    empate: false,
    melhor_de: { opcoes: [1, 3, 0], padrao: 1 }, // padrao amador: set unico; 0 = placar livre
    pontuacao: { vitoria: 2, derrota: 1 }, // padrao volei de praia FIVB (WO fica p/ depois)
    criterios: ['vitorias', 'saldo_sets', 'saldo_pontos', 'confronto'],
    criterios_validos: CRITERIOS_VALIDOS_SETS,
    colunas: [
      ['pts', 'Pts', 'Pontos'], ['pj', 'J', 'Jogos'], ['v', 'V', 'Vitórias'], ['d', 'D', 'Derrotas'],
      ['sv', 'SV', 'Sets vencidos'], ['sp', 'SP', 'Sets perdidos'], ['saldo_sets', 'ΔSets', 'Saldo de sets'],
      ['pp', 'PP', 'Pontos pró'], ['pc', 'PC', 'Pontos contra'], ['saldo_pontos', 'ΔPts', 'Saldo de pontos'],
    ],
    rotulos: { participante: 'Dupla', participantes: 'Duplas', artilharia: null, pontos: 'pontos' },
  },
  {
    chave: 'beach_tennis',
    nome: 'Beach Tennis',
    icone: '/img/esportes/beach_tennis.png',
    disponivel: true,
    variantes: ['Duplas 2x2', 'Simples 1x1'],
    variante_padrao: 'Duplas 2x2',
    placar: 'sets',
    empate: false,
    melhor_de: { opcoes: [1, 3, 0], padrao: 3 }, // ITF melhor de 3; pro set unico; 0 = placar livre
    pontuacao: { vitoria: 2, derrota: 1 },
    // Padrao ITF adaptado: confronto direto, % de sets, % de games.
    criterios: ['confronto', 'pct_sets', 'pct_pontos'],
    criterios_validos: CRITERIOS_VALIDOS_SETS,
    colunas: [
      ['pts', 'Pts', 'Pontos'], ['pj', 'J', 'Jogos'], ['v', 'V', 'Vitórias'], ['d', 'D', 'Derrotas'],
      ['sv', 'SV', 'Sets vencidos'], ['sp', 'SP', 'Sets perdidos'],
      ['pp', 'GV', 'Games vencidos'], ['pc', 'GP', 'Games perdidos'],
    ],
    rotulos: { participante: 'Dupla', participantes: 'Duplas', artilharia: null, pontos: 'games' },
  },
  {
    chave: 'volei',
    nome: 'Vôlei',
    icone: '/img/esportes/volei.png',
    disponivel: true,
    variantes: ['Quadra 6x6', 'Praia 2x2', '4x4'],
    variante_padrao: 'Quadra 6x6',
    placar: 'sets',
    empate: false,
    melhor_de: { opcoes: [3, 5, 0], padrao: 5 }, // FIVB melhor de 5; amador melhor de 3; 0 = placar livre
    // FIVB com bonus: vitoria sem set decisivo 3 pts; com decisivo 2; derrota no decisivo 1.
    pontuacao: { tipo: 'sets_bonus' },
    criterios: ['vitorias', 'razao_sets', 'razao_pontos', 'confronto'],
    criterios_validos: CRITERIOS_VALIDOS_SETS,
    colunas: [
      ['pts', 'Pts', 'Pontos'], ['pj', 'J', 'Jogos'], ['v', 'V', 'Vitórias'], ['d', 'D', 'Derrotas'],
      ['sv', 'SV', 'Sets vencidos'], ['sp', 'SP', 'Sets perdidos'], ['razao_sets', 'RSet', 'Razão de sets (SV÷SP)'],
      ['pp', 'PP', 'Pontos pró'], ['pc', 'PC', 'Pontos contra'],
    ],
    rotulos: { participante: 'Time', participantes: 'Times', artilharia: null, pontos: 'pontos' },
  },
  {
    chave: 'basquete',
    nome: 'Basquete',
    icone: '/img/esportes/basquete.png',
    disponivel: true,
    variantes: ['5x5', '3x3'],
    variante_padrao: '5x5',
    placar: 'pontos',
    empate: false, // RN-TC-09: prorrogacao resolve na quadra, placar sempre com vencedor
    pontuacao: { vitoria: 2, derrota: 1 }, // padrao FIBA
    // FIBA adaptado: confronto direto, saldo de pontos geral, pontos pro.
    criterios: ['confronto', 'saldo_pontos', 'pontos_pro'],
    criterios_validos: ['vitorias', 'confronto', 'saldo_pontos', 'pontos_pro'],
    colunas: [
      ['pts', 'Pts', 'Pontos'], ['pj', 'J', 'Jogos'], ['v', 'V', 'Vitórias'], ['d', 'D', 'Derrotas'],
      ['pp', 'PP', 'Pontos pró'], ['pc', 'PC', 'Pontos contra'], ['saldo_pontos', 'SP', 'Saldo de pontos'],
    ],
    evento_individual: 'pontos', // cestinhas: total simples por jogador por jogo
    rotulos: { participante: 'Time', participantes: 'Times', artilharia: 'Cestinhas', individual: 'Pontos', pontos: 'pontos' },
  },
  {
    chave: 'peteca',
    nome: 'Peteca',
    icone: '/img/esportes/peteca.png',
    disponivel: true,
    variantes: ['Duplas 2x2', 'Individual 1x1'],
    variante_padrao: 'Duplas 2x2',
    placar: 'sets',
    empate: false,
    melhor_de: { opcoes: [1, 3, 0], padrao: 3 }, // regra oficial (MG): melhor de 3 de 12; 0 = placar livre
    pontuacao: { vitoria: 2, derrota: 1 },
    criterios: ['confronto', 'saldo_sets', 'saldo_pontos'],
    criterios_validos: CRITERIOS_VALIDOS_SETS,
    colunas: [
      ['pts', 'Pts', 'Pontos'], ['pj', 'J', 'Jogos'], ['v', 'V', 'Vitórias'], ['d', 'D', 'Derrotas'],
      ['sv', 'SV', 'Sets vencidos'], ['sp', 'SP', 'Sets perdidos'], ['saldo_sets', 'Saldo', 'Saldo de sets'],
    ],
    rotulos: { participante: 'Dupla', participantes: 'Duplas', artilharia: null, pontos: 'pontos' },
  },
];

export const ESPORTE_PADRAO = 'futebol';

export function obterEsporte(chave) {
  return ESPORTES.find((e) => e.chave === chave) ?? null;
}

// Pontos de classificacao de UMA partida por sets, para vencedor e perdedor.
export function pontosDaPartidaSets(pontuacao, setsVencedor, setsPerdedor) {
  if (pontuacao?.tipo === 'sets_bonus') {
    // FIVB (volei): 3-0/3-1 => 3 x 0; 3-2 => 2 x 1 (em melhor de 3: 2-0 => 3 x 0; 2-1 => 2 x 1).
    // "Foi ao decisivo" = perdedor terminou a um set do vencedor — vale tambem
    // no formato de placar livre, onde nao ha numero fixo de sets.
    const foiAoDecisivo = setsPerdedor > 0 && setsPerdedor === setsVencedor - 1;
    return foiAoDecisivo ? { vencedor: 2, perdedor: 1 } : { vencedor: 3, perdedor: 0 };
  }
  return { vencedor: pontuacao?.vitoria ?? 2, perdedor: pontuacao?.derrota ?? 1 };
}
