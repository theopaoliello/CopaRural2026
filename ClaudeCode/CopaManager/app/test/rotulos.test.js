// Rotulos de vaga do misto manual (EF Mata-mata Manual, fase C).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  textoRotulo, rotulosPadrao, validarRotulos, gruposElegiveis,
  zonasDosRotulos, resolverRotulos, rotulosDisponiveis,
  evitarReencontros, reencontrosDosRotulos,
} from '../src/rotulos.js';
import { obterDesenho } from '../src/chaveamentos.js';

const grupos = (tamanhos) => tamanhos.map((t, i) => ({ nome: 'ABCDEFG'[i], tamanho: t }));

// Classificacao falsa: cada grupo com linhas ja ordenadas.
const porGrupo = (mapa) => Object.entries(mapa).map(([nome, linhas]) => ({
  grupo: { nome: `Grupo ${nome}` },
  linhas: linhas.map((l) => ({ pj: 3, pts: 0, v: 0, sg: 0, gp: 0, ...l })),
}));

test('texto do rotulo', () => {
  assert.equal(textoRotulo({ tipo: 'grupo_posicao', grupo: 'A', posicao: 1 }), '1º do Grupo A');
  assert.equal(textoRotulo({ tipo: 'melhor_posicao', posicao: 3, ordem: 1 }), 'Melhor 3º');
  assert.equal(textoRotulo({ tipo: 'melhor_posicao', posicao: 3, ordem: 2 }), '2º melhor 3º');
  assert.equal(textoRotulo(null), 'A definir');
});

test('rotulos padrao: potes por posicao e o resto vira melhores colocados', () => {
  // 3 grupos, 7 vagas: 1os e 2os de todos + o melhor 3o.
  assert.deepEqual(rotulosPadrao(7, 3).map(textoRotulo), [
    '1º do Grupo A', '1º do Grupo B', '1º do Grupo C',
    '2º do Grupo A', '2º do Grupo B', '2º do Grupo C',
    'Melhor 3º',
  ]);
  // 2 grupos, 5 vagas: 1os e 2os + o melhor 3o.
  assert.deepEqual(rotulosPadrao(5, 2).map(textoRotulo), [
    '1º do Grupo A', '1º do Grupo B', '2º do Grupo A', '2º do Grupo B', 'Melhor 3º',
  ]);
  // 4 grupos, 6 vagas: os 1os + os dois melhores 2os.
  assert.deepEqual(rotulosPadrao(6, 4).map(textoRotulo), [
    '1º do Grupo A', '1º do Grupo B', '1º do Grupo C', '1º do Grupo D',
    'Melhor 2º', '2º melhor 2º',
  ]);
});

test('elegiveis ao ranking: quem ja classificou direto naquela posicao sai fora', () => {
  const rotulos = [
    { tipo: 'grupo_posicao', grupo: 'A', posicao: 1 },
    { tipo: 'grupo_posicao', grupo: 'B', posicao: 1 },
    { tipo: 'grupo_posicao', grupo: 'C', posicao: 1 },
    { tipo: 'grupo_posicao', grupo: 'A', posicao: 2 },
    { tipo: 'melhor_posicao', posicao: 2, ordem: 1 },
  ];
  assert.deepEqual(gruposElegiveis(rotulos, 2, ['A', 'B', 'C']), ['B', 'C']);
});

test('validacao: repetido, grupo pequeno demais e melhores sem grupo sobrando', () => {
  const g = grupos([4, 4, 4]);
  assert.ok(validarRotulos(rotulosPadrao(7, 3), { vagas: 7, grupos: g }));

  assert.throws(() => validarRotulos([
    { tipo: 'grupo_posicao', grupo: 'A', posicao: 1 },
    { tipo: 'grupo_posicao', grupo: 'A', posicao: 1 },
    { tipo: 'grupo_posicao', grupo: 'B', posicao: 1 },
  ], { vagas: 3, grupos: g }), /repetida/);

  assert.throws(() => validarRotulos([
    { tipo: 'grupo_posicao', grupo: 'A', posicao: 9 },
    { tipo: 'grupo_posicao', grupo: 'B', posicao: 1 },
    { tipo: 'grupo_posicao', grupo: 'C', posicao: 1 },
  ], { vagas: 3, grupos: g }), /nao existe 9º colocado/);

  // Dois "melhores 2os" mas so um grupo sobrando na disputa.
  assert.throws(() => validarRotulos([
    { tipo: 'grupo_posicao', grupo: 'A', posicao: 1 },
    { tipo: 'grupo_posicao', grupo: 'B', posicao: 1 },
    { tipo: 'grupo_posicao', grupo: 'C', posicao: 1 },
    { tipo: 'grupo_posicao', grupo: 'A', posicao: 2 },
    { tipo: 'grupo_posicao', grupo: 'B', posicao: 2 },
    { tipo: 'melhor_posicao', posicao: 2, ordem: 1 },
    { tipo: 'melhor_posicao', posicao: 2, ordem: 2 },
  ], { vagas: 7, grupos: g }), /apenas 1/);

  assert.throws(() => validarRotulos(rotulosPadrao(7, 3), { vagas: 6, grupos: g }), /6 vagas/);
});

test('zonas: verde ate a posicao direta em todos os grupos, ambar na disputada', () => {
  assert.deepEqual(zonasDosRotulos(rotulosPadrao(7, 3), ['A', 'B', 'C']), {
    diretosPorGrupo: 2, posicaoDisputa: 3,
  });
  assert.deepEqual(zonasDosRotulos(rotulosPadrao(6, 4), ['A', 'B', 'C', 'D']), {
    diretosPorGrupo: 1, posicaoDisputa: 2,
  });
  // Sem melhores colocados nao ha posicao em disputa.
  assert.deepEqual(zonasDosRotulos(rotulosPadrao(6, 3), ['A', 'B', 'C']), {
    diretosPorGrupo: 2, posicaoDisputa: null,
  });
});

test('resolucao: diretos pela posicao e melhores pelo ranking entre grupos', () => {
  // 2 grupos; os 3os de A e B disputam a ultima vaga. B3 tem mais pontos.
  const classificacao = porGrupo({
    A: [{ time_id: 11, nome: 'A1' }, { time_id: 12, nome: 'A2' }, { time_id: 13, nome: 'A3', pts: 3 }],
    B: [{ time_id: 21, nome: 'B1' }, { time_id: 22, nome: 'B2' }, { time_id: 23, nome: 'B3', pts: 6 }],
  });
  const times = resolverRotulos(rotulosPadrao(5, 2), classificacao, ['vitorias', 'saldo']);
  assert.deepEqual(times, [11, 21, 12, 22, 23], 'o melhor 3o e o B3');

  // Vaga que nao existe na classificacao para com mensagem clara.
  assert.throws(
    () => resolverRotulos([{ tipo: 'grupo_posicao', grupo: 'A', posicao: 9 }], classificacao, []),
    /9º do Grupo A/,
  );
});

test('anti-reencontro: o padrao de 3 grupos em chave de 7 nao cruza o mesmo grupo', () => {
  const desenho = obterDesenho(7, '7A');
  const cru = rotulosPadrao(7, 3);
  // Pote a pote, 1ºC e 2ºC caem no mesmo confronto — e o que a troca resolve.
  assert.equal(reencontrosDosRotulos(cru, desenho).length, 1);

  const ajustado = evitarReencontros(cru, desenho);
  assert.deepEqual(reencontrosDosRotulos(ajustado, desenho), []);
  // A troca acontece DENTRO do pote: os 1os continuam sendo 1os.
  assert.deepEqual(
    ajustado.map((r) => (r.tipo === 'grupo_posicao' ? r.posicao : 'M')),
    cru.map((r) => (r.tipo === 'grupo_posicao' ? r.posicao : 'M')),
  );
  assert.deepEqual(
    [...ajustado].map(textoRotulo).sort(),
    [...cru].map(textoRotulo).sort(),
    'o conjunto de vagas e o mesmo, so muda quem senta onde',
  );
});

test('anti-reencontro: melhor colocado nunca conta como reencontro', () => {
  const desenho = obterDesenho(5, '5A');
  const rotulos = evitarReencontros(rotulosPadrao(5, 2), desenho);
  // 2 grupos, 5 vagas: o melhor 3o pode ser de qualquer grupo — sem grupo
  // definido, nao ha como chamar de reencontro antes da fase terminar.
  assert.deepEqual(reencontrosDosRotulos(rotulos, desenho), []);
});

test('catalogo de rotulos oferece posicoes existentes e os melhores possiveis', () => {
  const lista = rotulosDisponiveis(grupos([3, 3]));
  const textos = lista.map((r) => r.texto);
  assert.ok(textos.includes('1º do Grupo A'));
  assert.ok(textos.includes('3º do Grupo B'));
  assert.ok(textos.includes('Melhor 2º'));
  // Com 2 grupos so cabe UM "melhor" por posicao (o outro classifica direto).
  assert.ok(!textos.includes('2º melhor 2º'));
  assert.ok(!textos.includes('4º do Grupo A'), 'grupo de 3 nao tem 4o colocado');
});
