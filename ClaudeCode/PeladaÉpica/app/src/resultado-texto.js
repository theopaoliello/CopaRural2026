// Registro de resultado por texto estruturado. Formato:
//
//   GOLS TIME CASA
//   Theo,2              -> 2 gols do Theo (quantidade opcional; sem ela, 1 gol)
//   GC,Fulano           -> gol contra: Fulano e jogador do OUTRO time
//   SR,3                -> 3 gols sem registro de jogador (SR ou SEM REGISTRO)
//   GOLS TIME VISITANTE
//   ...
//   CARTOES TIME CASA
//   A,Leo               -> cartao Amarelo do Leo
//   V,Pedro             -> cartao Vermelho do Pedro
//   CARTOES TIME VISITANTE
//   ...
//
// O placar e CALCULADO a partir dos gols informados. Nomes sao validados
// contra o elenco do time da secao (acentos e maiusculas nao importam).
import { erroValidacao } from './erros.js';

const normalizar = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();

const SECOES = new Map([
  ['GOLS TIME CASA', { tipo: 'gols', lado: 'casa' }],
  ['GOLS TIME VISITANTE', { tipo: 'gols', lado: 'fora' }],
  ['CARTOES TIME CASA', { tipo: 'cartoes', lado: 'casa' }],
  ['CARTOES TIME VISITANTE', { tipo: 'cartoes', lado: 'fora' }],
]);

// times: { casa: { id, nome, jogadores: [{id, nome}] }, fora: { ... } }
// Devolve { gols_casa, gols_fora, eventos } pronto para registrarResultado.
export function parsearResultadoTexto(texto, times) {
  const eventos = [];
  const gols = { casa: 0, fora: 0 };
  let secao = null;

  const buscarJogador = (nome, lado, numLinha) => {
    const time = times[lado];
    const alvo = normalizar(nome);
    if (!alvo) throw erroValidacao(`Linha ${numLinha}: informe o nome do jogador.`);
    const jogador = time.jogadores.find((j) => normalizar(j.nome) === alvo);
    if (!jogador) {
      throw erroValidacao(
        `Linha ${numLinha}: jogador "${String(nome).trim()}" nao encontrado no elenco de ${time.nome}.`,
      );
    }
    return jogador;
  };

  String(texto ?? '').split('\n').forEach((bruta, i) => {
    const linha = bruta.trim();
    if (!linha) return;
    const num = i + 1;

    const cabecalho = SECOES.get(normalizar(linha));
    if (cabecalho) { secao = cabecalho; return; }
    if (!secao) {
      throw erroValidacao(`Linha ${num}: comece com um titulo de secao (ex.: GOLS TIME CASA).`);
    }

    const campos = linha.split(',').map((c) => c.trim());

    if (secao.tipo === 'gols') {
      const lado = secao.lado;
      const outro = lado === 'casa' ? 'fora' : 'casa';

      // Quantidade opcional no ultimo campo ("Nome,2" | "GC,Fulano,2" | "SR,3").
      let qtd = 1;
      if (campos.length > 1 && /^\d+$/.test(campos.at(-1))) qtd = Number(campos.pop());
      if (qtd < 1) throw erroValidacao(`Linha ${num}: quantidade de gols invalida.`);

      const marcador = normalizar(campos[0]);
      let tipo = 'gol';
      let jogadorId = null;
      if (marcador === 'GC') {
        // Gol contra: o autor e do time ADVERSARIO; o gol conta para o time da secao.
        tipo = 'gol_contra';
        const nome = campos.slice(1).join(',');
        if (nome) jogadorId = buscarJogador(nome, outro, num).id;
      } else if (marcador === 'SR' || marcador === 'SEM REGISTRO') {
        jogadorId = null; // gol sem registro de autor
      } else {
        jogadorId = buscarJogador(campos.join(','), lado, num).id;
      }

      gols[lado] += qtd;
      for (let k = 0; k < qtd; k++) {
        eventos.push({ tipo, time_id: times[lado].id, jogador_id: jogadorId });
      }
    } else {
      // Cartoes: "A,Nome" (amarelo) | "V,Nome" (vermelho). Um cartao por linha.
      const tipo = { A: 'amarelo', V: 'vermelho' }[normalizar(campos[0])];
      if (!tipo) {
        throw erroValidacao(`Linha ${num}: use "A" (amarelo) ou "V" (vermelho) antes do nome. Ex.: A,Leo`);
      }
      const jogador = buscarJogador(campos.slice(1).join(','), secao.lado, num);
      eventos.push({ tipo, time_id: times[secao.lado].id, jogador_id: jogador.id });
    }
  });

  return { gols_casa: gols.casa, gols_fora: gols.fora, eventos };
}
