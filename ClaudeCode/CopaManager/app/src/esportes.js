// Catalogo central de esportes (EF "Tipos de Campeonato" v1.0).
// O esporte e um preset estrutural escolhido UMA vez, na criacao do campeonato
// (RN-TC-01): wizard, validacao, classificacao e paginas consultam este
// catalogo — nenhum `if (esporte === ...)` espalhado pelo codigo (RN-TC-10).
//
// Fase 1 (fundacao): somente o Futebol esta disponivel; os demais aparecem no
// menu como "Em breve". As fases 2-4 completam os presets (placar por sets,
// pontos de jogo do basquete e a Pelada Epica) — os campos `placar` e `empate`
// ja registram a decisao estrutural de cada esporte para as proximas fases.
//
// A ORDEM deste array e a ordem fixa do menu do wizard (decisao de produto).
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
    rotulos: { participante: 'Time', participantes: 'Times', artilharia: 'Artilharia' },
  },
  {
    chave: 'pelada_epica',
    nome: 'Pelada Épica',
    icone: '/img/esportes/pelada_epica.png',
    disponivel: false,
    variantes: [],
    placar: 'gols',
    empate: true,
    rotulos: { participante: 'Jogador', participantes: 'Jogadores', artilharia: 'Artilharia' },
  },
  {
    chave: 'futvolei',
    nome: 'Futvôlei',
    icone: '/img/esportes/futvolei.png',
    disponivel: false,
    variantes: ['2x2', '3x3', '4x4'],
    placar: 'sets',
    empate: false,
    rotulos: { participante: 'Dupla', participantes: 'Duplas', artilharia: null },
  },
  {
    chave: 'beach_tennis',
    nome: 'Beach Tennis',
    icone: '/img/esportes/beach_tennis.png',
    disponivel: false,
    variantes: ['Duplas 2x2', 'Simples 1x1'],
    placar: 'sets',
    empate: false,
    rotulos: { participante: 'Dupla', participantes: 'Duplas', artilharia: null },
  },
  {
    chave: 'volei',
    nome: 'Vôlei',
    icone: '/img/esportes/volei.png',
    disponivel: false,
    variantes: ['Quadra 6x6', 'Praia 2x2', '4x4'],
    placar: 'sets',
    empate: false,
    rotulos: { participante: 'Time', participantes: 'Times', artilharia: null },
  },
  {
    chave: 'basquete',
    nome: 'Basquete',
    icone: '/img/esportes/basquete.png',
    disponivel: false,
    variantes: ['5x5', '3x3'],
    placar: 'pontos',
    empate: false,
    rotulos: { participante: 'Time', participantes: 'Times', artilharia: 'Cestinhas' },
  },
  {
    chave: 'peteca',
    nome: 'Peteca',
    icone: '/img/esportes/peteca.png',
    disponivel: false,
    variantes: ['Duplas 2x2', 'Individual 1x1'],
    placar: 'sets',
    empate: false,
    rotulos: { participante: 'Dupla', participantes: 'Duplas', artilharia: null },
  },
];

export const ESPORTE_PADRAO = 'futebol';

export function obterEsporte(chave) {
  return ESPORTES.find((e) => e.chave === chave) ?? null;
}
