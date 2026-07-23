// Criacao e gestao de campeonatos: wizard, slug, grupos, times e geracao da tabela.
import { erroValidacao, erroConflito } from './erros.js';
import {
  gerarPontosCorridos,
  gerarMataMata,
  dividirEmGrupos,
  embaralhar,
  ehPotenciaDe2,
  seedsDeGrupos,
  aceitaDisputaTerceiro,
  jogoDisputaTerceiro,
  vencedorConfronto,
  perdedorConfronto,
  ultimaRodadaMata,
  nomeRodadaMata,
  CONFRONTO_TERCEIRO,
} from './tabela.js';
import {
  calcularClassificacao, calcularClassificacaoSets, calcularClassificacaoPontos,
  calcularRankingPelada, cartoesPorTime, CRITERIOS_VALIDOS,
} from './classificacao.js';
import { obterEsporte, ESPORTE_PADRAO } from './esportes.js';
import { validarEscalacoes, gravarEscalacoes } from './jogos.js';
import {
  planoDeVagas, sugerirCombinacao, textoSugestao, resumoDoPlano, tamanhosPrevistos,
  criteriosDeMedia, mediaDoCriterio, rankearEntreGrupos,
  montarSeeds, confrontosDaPrimeiraFase, ajustarReencontros,
} from './melhores.js';
import {
  conferirLimiteCampeonatos, conferirLimiteTimes, conferirLimiteJogadoresPelada,
} from './limites.js';
import { obterDesenho, gerarChaveManual } from './chaveamentos.js';
import {
  rotulosPadrao, validarRotulos, resolverRotulos, zonasDosRotulos,
  rotulosDisponiveis, textoRotulo, evitarReencontros, reencontrosDosRotulos,
  resumoDosRotulos, gruposElegiveis, LETRAS as LETRAS_GRUPO,
} from './rotulos.js';

const FORMATOS = ['pontos', 'mata', 'grupos_mata'];
const LETRAS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// ---------- validacao de campos livres ----------

// Campos de texto tem teto de tamanho: o JSON aceita ate 5 MB (por causa das
// imagens) e sem teto qualquer string desse porte iria parar no banco.
export function textoLimitado(valor, max, campo) {
  if (valor == null) return null;
  const texto = String(valor).trim();
  if (!texto) return null;
  if (texto.length > max) throw erroValidacao(`${campo} muito longo (limite: ${max} caracteres).`);
  return texto;
}

// Limites de nome (caracteres) para jogadores e times — enforcados no servidor
// e refletidos como maxlength nos campos do admin (public/admin.html).
export const MAX_NOME_JOGADOR = 15;
export const MAX_NOME_TIME = 30;

// A cor do tema vai para contexto CSS na pagina publica: so aceita hex.
export function validarCorTema(valor) {
  const cor = String(valor ?? '').trim();
  if (!/^#[0-9a-fA-F]{3,8}$/.test(cor)) throw erroValidacao('Cor do tema invalida. Use hexadecimal, ex.: #0b5c3f.');
  return cor;
}

// ---------- slug ----------

export function slugificar(texto) {
  return String(texto)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'campeonato';
}

export function slugDisponivel(db, base) {
  let slug = base;
  for (let i = 2; ; i++) {
    const existe = db.prepare('SELECT id FROM campeonatos WHERE slug = ?').get(slug);
    if (!existe) return slug;
    slug = `${base}-${i}`;
  }
}

// ---------- criacao (wizard) ----------

export function criarCampeonato(db, contaId, dados) {
  // Limite de campeonatos simultaneos da conta (RN-GC-02): vale para todos os
  // formatos, inclusive a Pelada Epica (o dispatch acontece logo abaixo).
  conferirLimiteCampeonatos(db, contaId);

  const nome = textoLimitado(dados.nome, 120, 'Nome do campeonato');
  if (!nome) throw erroValidacao('Informe o nome do campeonato.');

  // Esporte ausente = futebol (compatibilidade com a API pre-multiesporte).
  const esporte = obterEsporte(dados.esporte ?? ESPORTE_PADRAO);
  if (!esporte) throw erroValidacao('Esporte invalido.');
  if (!esporte.disponivel) throw erroValidacao(`${esporte.nome} ainda nao esta disponivel. Em breve!`);

  // Ranking individual (Pelada Epica): estrutura propria, sem tabela gerada.
  if (esporte.ranking === 'individual') return criarPeladaEpica(db, contaId, dados, esporte, nome);

  const formato = dados.formato;
  if (!FORMATOS.includes(formato)) throw erroValidacao('Formato invalido.');

  const nomesTimes = (dados.times ?? []).map((t) => String(t?.nome ?? t ?? '').trim()).filter(Boolean);
  if (nomesTimes.some((n) => n.length > MAX_NOME_TIME)) {
    throw erroValidacao(`Nome de time muito longo (limite: ${MAX_NOME_TIME} caracteres).`);
  }
  const nomesUnicos = new Set(nomesTimes.map((n) => n.toLowerCase()));
  if (nomesUnicos.size !== nomesTimes.length) throw erroValidacao('Ha times com nomes repetidos.');
  if (nomesTimes.length < 2) throw erroValidacao('Cadastre pelo menos 2 times.');
  conferirLimiteTimes(db, contaId, nomesTimes.length);

  const numGrupos = formato === 'grupos_mata' ? Math.max(1, Number(dados.num_grupos ?? 1)) : 1;
  const classificadosPorGrupo = Math.max(1, Number(dados.classificados_por_grupo ?? 2));
  const idaVoltaGrupos = dados.ida_volta_grupos ? 1 : 0;
  // Mata-mata de ida e volta e exclusividade do futebol (RN-TC-05).
  const idaVoltaMata = esporte.chave === 'futebol' && dados.ida_volta_mata ? 1 : 0;

  // Esportes de sets: quantos sets fecham a partida (do preset ou escolhido).
  let melhorDe = null;
  if (esporte.placar === 'sets') {
    melhorDe = Number(dados.melhor_de ?? esporte.melhor_de.padrao);
    if (!esporte.melhor_de.opcoes.includes(melhorDe)) {
      throw erroValidacao(`Formato de partida invalido. Opcoes: ${esporte.melhor_de.opcoes.map((n) => `melhor de ${n}`).join(', ')}.`);
    }
  }
  const sortear = dados.sortear !== false; // padrao: sorteia a distribuicao

  // Disputa de 3o lugar (RN-MM-21): exige duas semifinais de verdade, ou seja,
  // uma chave de 4 ou mais. Na fase de grupos a chave so nasce depois — o que
  // da para conferir aqui e o tamanho previsto dela (plano de vagas).
  const disputaTerceiro = formato !== 'pontos' && !!dados.disputa_terceiro;
  if (disputaTerceiro && formato === 'mata' && nomesTimes.length < 4) {
    throw erroValidacao('Nao ha como disputar o 3o lugar numa chave de 2 times.');
  }

  // Modelo do mata-mata (RN-MM-01/02): a divisao e pelo numero de participantes,
  // sem sobreposicao — potencia de 2 e chave cheia (Padrao); fora dela, a chave
  // so existe com folgas (Manual Personalizado, com desenho do catalogo).
  let mataModelo = 'padrao';
  let desenhoManual = null;
  let rotulosManual = null;
  if (formato === 'mata' && !ehPotenciaDe2(nomesTimes.length)) {
    if (dados.mata_modelo === 'padrao') {
      throw erroValidacao('Mata-mata Padrao exige 2, 4, 8, 16... times. Com outro numero, use o Manual Personalizado.');
    }
    mataModelo = 'manual';
    desenhoManual = obterDesenho(nomesTimes.length, dados.mata_desenho ?? `${nomesTimes.length}A`);
    if (disputaTerceiro && !desenhoManual.aceita_disputa_terceiro) {
      throw erroValidacao(`O chaveamento ${desenhoManual.id} nao comporta disputa de 3o lugar: a fase anterior a final tem um confronto so.`);
    }
  } else if (formato === 'grupos_mata' && dados.mata_modelo === 'manual') {
    // Misto manual (fase C): o gestor declara QUANTAS vagas o mata tem e qual
    // o desenho; quem ocupa cada uma vira rotulo ("1o do Grupo A"), editavel
    // ate a geracao. Nada de repescagem/corte automaticos (RN-MM-11).
    mataModelo = 'manual';
    const vagas = Math.trunc(Number(dados.mata_vagas));
    desenhoManual = obterDesenho(vagas, dados.mata_desenho ?? `${vagas}A`);
    if (vagas > nomesTimes.length) {
      throw erroValidacao(`O mata-mata teria ${vagas} vagas para ${nomesTimes.length} times cadastrados.`);
    }
    if (disputaTerceiro && !desenhoManual.aceita_disputa_terceiro) {
      throw erroValidacao(`O chaveamento ${desenhoManual.id} nao comporta disputa de 3o lugar: a fase anterior a final tem um confronto so.`);
    }
    const tamanhos = tamanhosPrevistos(nomesTimes.length, numGrupos);
    // O padrao ja sai sem reencontro de grupo na 1a fase (decisao da EF 10):
    // sugestao, nao imposicao — o gestor pode reordenar depois.
    rotulosManual = validarRotulos(
      dados.mata_rotulos ?? evitarReencontros(rotulosPadrao(vagas, numGrupos), desenhoManual),
      { vagas, grupos: tamanhos.map((t, g) => ({ nome: LETRAS_GRUPO[g], tamanho: t })) },
    );
  } else if (dados.mata_modelo === 'manual') {
    throw erroValidacao(`Com ${nomesTimes.length} times a chave e cheia: o modelo Padrao ja monta o chaveamento (e as posicoes podem ser ajustadas na aba Chaveamento).`);
  }
  if (formato === 'grupos_mata' && mataModelo !== 'manual') {
    // Melhores Colocados (RN-MC-02/06): potencia exata segue como sempre;
    // fora dela, o plano completa (repescagem) ou corta. So rejeita quando
    // nem completar nem cortar fecham uma chave — com sugestao de ajuste.
    const plano = planoDeVagas({
      numGrupos,
      classificados: classificadosPorGrupo,
      tamanhos: tamanhosPrevistos(nomesTimes.length, numGrupos),
    });
    if (plano.modo === 'inviavel') {
      const sugestao = textoSugestao(
        sugerirCombinacao({ numGrupos, classificados: classificadosPorGrupo, totalTimes: nomesTimes.length }),
        { numGrupos, classificados: classificadosPorGrupo },
      );
      throw erroValidacao(
        `Nao ha chave de mata-mata viavel para ${numGrupos} grupo(s) x ${classificadosPorGrupo} classificado(s).`
        + (sugestao ? ` Sugestao: ${sugestao}.` : ''),
      );
    }
    const porGrupo = Math.floor(nomesTimes.length / numGrupos);
    if (plano.modo === 'exata' && classificadosPorGrupo >= porGrupo && nomesTimes.length % numGrupos === 0) {
      throw erroValidacao('Ha grupos em que todos os times se classificariam. Ajuste a configuracao.');
    }
    if (disputaTerceiro && plano.vagas < 4) {
      throw erroValidacao('Nao ha como disputar o 3o lugar numa chave de 2 times.');
    }
  }

  // O preset do esporte define os padroes; o organizador pode ajustar (RN-TC-02).
  const criteriosValidos = esporte.criterios_validos ?? CRITERIOS_VALIDOS;
  let criterios = dados.criterios_desempate ?? esporte.criterios ?? criteriosValidos;
  if (!Array.isArray(criterios) || criterios.some((c) => !criteriosValidos.includes(c))) {
    throw erroValidacao('Criterios de desempate invalidos.');
  }

  const slug = slugDisponivel(db, slugificar(dados.slug || `${nome} ${dados.temporada ?? ''}`));

  // No misto manual quem classifica sao os rotulos; a coluna guarda o valor
  // DERIVADO (quantos entram direto em todos os grupos) para as telas que ja
  // exibem "N grupos x C classificados" continuarem verdadeiras.
  const classificadosGravados = rotulosManual
    ? Math.max(1, zonasDosRotulos(rotulosManual, Array.from({ length: numGrupos }, (_, g) => LETRAS_GRUPO[g])).diretosPorGrupo)
    : classificadosPorGrupo;

  const info = db
    .prepare(
      `INSERT INTO campeonatos
       (conta_id, nome, temporada, esporte, modalidade, descricao, cor_tema, slug, formato,
        num_grupos, ida_volta_grupos, ida_volta_mata, classificados_por_grupo,
        pontos_vitoria, pontos_empate, criterios_desempate, melhor_de, disputa_terceiro,
        mata_modelo, mata_chave)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      contaId,
      nome,
      textoLimitado(dados.temporada, 40, 'Temporada'),
      esporte.chave,
      textoLimitado(dados.modalidade, 40, 'Variante') ?? esporte.variante_padrao ?? esporte.nome,
      textoLimitado(dados.descricao, 2000, 'Descricao'),
      validarCorTema(dados.cor_tema ?? '#0b5c3f'),
      slug,
      formato,
      numGrupos,
      idaVoltaGrupos,
      idaVoltaMata,
      classificadosGravados,
      Math.max(0, Number(dados.pontos_vitoria ?? esporte.pontuacao?.vitoria ?? 3)),
      Math.max(0, Number(dados.pontos_empate ?? esporte.pontuacao?.empate ?? 1)),
      JSON.stringify(criterios),
      melhorDe,
      disputaTerceiro ? 1 : 0,
      mataModelo,
      desenhoManual
        ? JSON.stringify({
          desenho: desenhoManual.id,
          vagas: desenhoManual.vagas,
          ...(rotulosManual ? { rotulos: rotulosManual } : {}),
        })
        : null,
    );
  const campeonatoId = Number(info.lastInsertRowid);

  // Times (ordem sorteada ou a informada no wizard).
  const ordem = sortear ? embaralhar(nomesTimes) : nomesTimes;
  const insTime = db.prepare('INSERT INTO times (campeonato_id, grupo_id, nome) VALUES (?, ?, ?)');
  const insJogo = db.prepare(
    `INSERT INTO jogos (campeonato_id, fase, rodada, confronto, perna, grupo_id, time_casa_id, time_fora_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  if (formato === 'mata') {
    const ids = ordem.map((n) => Number(insTime.run(campeonatoId, null, n).lastInsertRowid));
    // Padrao: pareamento pela lista — sem sorteio, a ordem digitada monta o
    // chaveamento (1o x 2o, 3o x 4o...); com sorteio, a lista ja vem
    // embaralhada. Manual: a lista ocupa as posicoes P1..PN do desenho.
    const jogos = desenhoManual
      ? gerarChaveManual(desenhoManual, ids, { idaEVolta: !!idaVoltaMata })
      : gerarMataMata(ids, { idaEVolta: !!idaVoltaMata, pareamento: 'lista' });
    const disputa = disputaTerceiro ? jogoDisputaTerceiro(jogos) : null;
    for (const j of disputa ? [...jogos, disputa] : jogos) {
      insJogo.run(campeonatoId, 'mata', j.rodada, j.confronto, j.perna, null, j.time_casa_id, j.time_fora_id);
    }
  } else if (formato === 'pontos') {
    const ids = ordem.map((n) => Number(insTime.run(campeonatoId, null, n).lastInsertRowid));
    for (const j of gerarPontosCorridos(ids, { idaEVolta: !!idaVoltaGrupos })) {
      insJogo.run(campeonatoId, 'grupos', j.rodada, null, 1, null, j.time_casa_id, j.time_fora_id);
    }
  } else {
    // grupos_mata: cria grupos, distribui times e gera a fase de grupos.
    // O mata-mata e gerado depois, quando a fase de grupos terminar.
    const gruposDeNomes = dividirEmGrupos(ordem, numGrupos);
    const insGrupo = db.prepare('INSERT INTO grupos (campeonato_id, nome) VALUES (?, ?)');
    gruposDeNomes.forEach((nomes, g) => {
      const grupoId = Number(insGrupo.run(campeonatoId, `Grupo ${LETRAS[g]}`).lastInsertRowid);
      const ids = nomes.map((n) => Number(insTime.run(campeonatoId, grupoId, n).lastInsertRowid));
      for (const j of gerarPontosCorridos(ids, { idaEVolta: !!idaVoltaGrupos })) {
        insJogo.run(campeonatoId, 'grupos', j.rodada, null, 1, grupoId, j.time_casa_id, j.time_fora_id);
      }
    });
  }

  return db.prepare('SELECT * FROM campeonatos WHERE id = ?').get(campeonatoId);
}

// ---------- Pelada Epica (ranking individual, EF v1.0) ----------

// Linhas de jogador do wizard: "Nome" ou "Nome (G)" (goleiro).
function parsearJogadores(linhas, tipo) {
  return (linhas ?? [])
    .map((l) => String(l ?? '').trim())
    .filter(Boolean)
    .map((linha) => {
      const goleiro = /\(g\)\s*$/i.test(linha);
      const nome = linha.replace(/\s*\(g\)\s*$/i, '').trim();
      if (!nome) throw erroValidacao('Jogador sem nome na lista.');
      if (nome.length > MAX_NOME_JOGADOR) throw erroValidacao(`Nome de jogador muito longo (limite: ${MAX_NOME_JOGADOR} caracteres).`);
      return { nome, tipo, goleiro: goleiro ? 1 : 0 };
    });
}

// Config de premiacao e rebaixamento da pelada (RN-PE-06), usada na criacao e
// na edicao (aba Config). `base` traz os valores atuais para edicao parcial;
// na criacao fica vazio e valem os padroes.
export function validarPremiacaoRebaixamento(dados, base = {}) {
  const premiacao = dados.premiacao ?? base.premiacao ?? 'primeiro';
  if (!['primeiro', 'top3'].includes(premiacao)) throw erroValidacao('Premiacao invalida.');
  let modo = dados.rebaixamento_modo !== undefined ? dados.rebaixamento_modo : (base.rebaixamento_modo ?? null);
  if (modo === 'nenhum' || modo === '') modo = null;
  if (modo != null && !['colocados', 'pontuacoes'].includes(modo)) {
    throw erroValidacao('Modo de rebaixamento invalido.');
  }
  const qtd = modo ? Number(dados.rebaixamento_qtd ?? base.rebaixamento_qtd) : null;
  if (modo && (!Number.isInteger(qtd) || qtd < 1)) {
    throw erroValidacao('Informe a quantidade do rebaixamento.');
  }
  return {
    premiacao,
    premia_artilheiro: (dados.premia_artilheiro ?? base.premia_artilheiro) ? 1 : 0,
    rebaixamento_modo: modo,
    rebaixamento_qtd: qtd,
  };
}

function criarPeladaEpica(db, contaId, dados, esporte, nome) {
  // Divisoes com nome fixo (RN-PE-04): reutilizadas em todos os jogos.
  const divisoes = (dados.times ?? []).map((t) => String(t?.nome ?? t ?? '').trim()).filter(Boolean);
  if (divisoes.length < 2) throw erroValidacao('Informe pelo menos 2 nomes de times/divisoes.');
  if (divisoes.some((n) => n.length > MAX_NOME_TIME)) throw erroValidacao(`Nome de time muito longo (limite: ${MAX_NOME_TIME} caracteres).`);
  if (new Set(divisoes.map((n) => n.toLowerCase())).size !== divisoes.length) {
    throw erroValidacao('Ha times com nomes repetidos.');
  }
  conferirLimiteTimes(db, contaId, divisoes.length);

  const jogosTemporada = Number(dados.jogos_temporada);
  if (!Number.isInteger(jogosTemporada) || jogosTemporada < 1) {
    throw erroValidacao('Informe a quantidade de jogos da temporada.');
  }

  const jogadores = [
    ...parsearJogadores(dados.jogadores_fixos, 'fixo'),
    ...parsearJogadores(dados.jogadores_suplentes, 'suplente'),
  ];
  if (jogadores.filter((j) => j.tipo === 'fixo').length < 2) {
    throw erroValidacao('Cadastre pelo menos 2 jogadores fixos.');
  }
  if (new Set(jogadores.map((j) => j.nome.toLowerCase())).size !== jogadores.length) {
    throw erroValidacao('Ha jogadores com nomes repetidos.');
  }
  // RN-GC-07: jogadores da pelada pertencem ao campeonato — teto por campeonato.
  conferirLimiteJogadoresPelada(db, contaId, jogadores.length, divisoes.length);

  // Desempate (RN-PE-11): criterio principal Gols ou Presenca; flag prioriza goleiro.
  let criterios = dados.criterios_desempate;
  if (criterios === undefined) {
    const principal = dados.criterio_desempate ?? 'gols';
    if (!['gols', 'presencas'].includes(principal)) throw erroValidacao('Criterio de desempate invalido.');
    criterios = [
      ...(dados.prioriza_goleiro ? ['goleiro'] : []),
      principal,
      principal === 'gols' ? 'presencas' : 'gols',
    ];
  }
  if (!Array.isArray(criterios) || criterios.some((c) => !esporte.criterios_validos.includes(c))) {
    throw erroValidacao('Criterios de desempate invalidos.');
  }

  const premios = validarPremiacaoRebaixamento(dados);

  const slug = slugDisponivel(db, slugificar(dados.slug || `${nome} ${dados.temporada ?? ''}`));
  const info = db
    .prepare(
      `INSERT INTO campeonatos
       (conta_id, nome, temporada, esporte, modalidade, descricao, cor_tema, slug, formato,
        pontos_vitoria, pontos_empate, criterios_desempate, jogos_temporada, pontos_presenca,
        premiacao, premia_artilheiro, rebaixamento_modo, rebaixamento_qtd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pontos', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      contaId,
      nome,
      textoLimitado(dados.temporada, 40, 'Temporada'),
      esporte.chave,
      esporte.nome,
      textoLimitado(dados.descricao, 2000, 'Descricao'),
      validarCorTema(dados.cor_tema ?? '#0b5c3f'),
      slug,
      Math.max(0, Number(dados.pontos_vitoria ?? esporte.pontuacao.vitoria)),
      Math.max(0, Number(dados.pontos_empate ?? esporte.pontuacao.empate)),
      JSON.stringify(criterios),
      jogosTemporada,
      dados.ponto_presenca === false ? 0 : 1, // flag da criacao (padrao ligada)
      premios.premiacao,
      premios.premia_artilheiro,
      premios.rebaixamento_modo,
      premios.rebaixamento_qtd,
    );
  const campeonatoId = Number(info.lastInsertRowid);

  const insTime = db.prepare('INSERT INTO times (campeonato_id, grupo_id, nome) VALUES (?, NULL, ?)');
  for (const n of divisoes) insTime.run(campeonatoId, n);
  const insJogador = db.prepare(
    'INSERT INTO jogadores (campeonato_id, nome, tipo, goleiro) VALUES (?, ?, ?, ?)',
  );
  for (const j of jogadores) insJogador.run(campeonatoId, j.nome, j.tipo, j.goleiro);

  // Nenhum jogo e gerado: os jogos da temporada sao criados ao longo dela.
  return db.prepare('SELECT * FROM campeonatos WHERE id = ?').get(campeonatoId);
}

// Cria um jogo avulso da temporada (so Pelada Epica; nos demais esportes a
// tabela e gerada na criacao). `dados.escalacoes` opcional: a confirmacao do
// sorteio cria o jogo ja com os times do dia preenchidos (EF 7.2 passo 4).
export function criarJogoAvulso(db, campeonato, dados) {
  const esporte = obterEsporte(campeonato.esporte);
  if (esporte?.ranking !== 'individual') {
    throw erroValidacao('A tabela deste campeonato e gerada automaticamente.');
  }
  const times = db.prepare('SELECT * FROM times WHERE campeonato_id = ? ORDER BY id').all(campeonato.id);
  const casa = dados.time_casa_id != null ? Number(dados.time_casa_id) : times[0]?.id;
  const fora = dados.time_fora_id != null ? Number(dados.time_fora_id) : times[1]?.id;
  if (!times.some((t) => t.id === casa) || !times.some((t) => t.id === fora) || casa === fora) {
    throw erroValidacao('Escolha dois times diferentes deste campeonato.');
  }
  // Valida a escalacao ANTES de inserir, para nao deixar jogo pela metade.
  const timeDoJogador = dados.escalacoes?.length
    ? validarEscalacoes(db, { time_casa_id: casa, time_fora_id: fora, campeonato_id: campeonato.id }, dados.escalacoes)
    : null;
  const rodada = (db
    .prepare('SELECT MAX(rodada) AS n FROM jogos WHERE campeonato_id = ?')
    .get(campeonato.id).n ?? 0) + 1;
  const info = db
    .prepare(
      `INSERT INTO jogos (campeonato_id, fase, rodada, perna, time_casa_id, time_fora_id, data, local)
       VALUES (?, 'grupos', ?, 1, ?, ?, ?, ?)`,
    )
    .run(
      campeonato.id, rodada, casa, fora,
      textoLimitado(dados.data, 40, 'Data'),
      textoLimitado(dados.local, 200, 'Local'),
    );
  const jogo = db.prepare('SELECT * FROM jogos WHERE id = ?').get(Number(info.lastInsertRowid));
  if (timeDoJogador) gravarEscalacoes(db, jogo.id, timeDoJogador);
  return jogo;
}

// ---------- classificacao de um campeonato ----------

// Calcula a classificacao da fase de grupos, agrupada por grupo (ou geral),
// no modelo de placar do esporte (gols ou sets).
export function classificacaoDoCampeonato(db, campeonato) {
  const esporte = obterEsporte(campeonato.esporte) ?? obterEsporte(ESPORTE_PADRAO);

  // Pelada Epica: ranking individual, sem grupos.
  if (esporte.ranking === 'individual') {
    const jogadores = db.prepare('SELECT * FROM jogadores WHERE campeonato_id = ?').all(campeonato.id);
    const jogosPelada = db.prepare('SELECT * FROM jogos WHERE campeonato_id = ?').all(campeonato.id);
    const escalacoes = db
      .prepare(
        `SELECT e.* FROM escalacoes e JOIN jogos j ON j.id = e.jogo_id
         WHERE j.campeonato_id = ? AND j.status = 'encerrado'`,
      )
      .all(campeonato.id);
    const eventosPelada = db
      .prepare(
        `SELECT e.* FROM eventos e JOIN jogos j ON j.id = e.jogo_id
         WHERE j.campeonato_id = ? AND j.status = 'encerrado'`,
      )
      .all(campeonato.id);
    const linhas = calcularRankingPelada(jogadores, jogosPelada, escalacoes, eventosPelada, {
      pontosVitoria: campeonato.pontos_vitoria,
      pontosEmpate: campeonato.pontos_empate,
      pontosPresenca: campeonato.pontos_presenca ?? 1,
      criterios: JSON.parse(campeonato.criterios_desempate),
    });
    aplicarZonasPelada(linhas, campeonato);
    return [{ grupo: null, linhas }];
  }

  const times = db.prepare('SELECT * FROM times WHERE campeonato_id = ?').all(campeonato.id);
  const jogos = db
    .prepare("SELECT * FROM jogos WHERE campeonato_id = ? AND fase = 'grupos'")
    .all(campeonato.id);
  const criterios = JSON.parse(campeonato.criterios_desempate);

  let calcular;
  if (esporte.placar === 'sets') {
    const sets = db
      .prepare(
        `SELECT s.* FROM sets s JOIN jogos j ON j.id = s.jogo_id
         WHERE j.campeonato_id = ? AND j.status = 'encerrado' AND j.fase = 'grupos'`,
      )
      .all(campeonato.id);
    const opcoes = { pontuacao: esporte.pontuacao, criterios };
    calcular = (ts, js) => calcularClassificacaoSets(ts, js, sets, opcoes);
  } else if (esporte.placar === 'pontos') {
    const opcoes = { pontuacao: esporte.pontuacao, criterios };
    calcular = (ts, js) => calcularClassificacaoPontos(ts, js, opcoes);
  } else {
    const eventos = db
      .prepare(
        `SELECT e.* FROM eventos e JOIN jogos j ON j.id = e.jogo_id
         WHERE j.campeonato_id = ? AND j.status = 'encerrado' AND j.fase = 'grupos'`,
      )
      .all(campeonato.id);
    const opcoes = {
      pontosVitoria: campeonato.pontos_vitoria,
      pontosEmpate: campeonato.pontos_empate,
      criterios,
      cartoesPorTime: cartoesPorTime(eventos),
    };
    calcular = (ts, js) => calcularClassificacao(ts, js, opcoes);
  }

  const grupos = db.prepare('SELECT * FROM grupos WHERE campeonato_id = ? ORDER BY nome').all(campeonato.id);
  if (!grupos.length) {
    return [{ grupo: null, linhas: calcular(times, jogos) }];
  }
  const resultado = grupos.map((g) => ({
    grupo: g,
    linhas: calcular(
      times.filter((t) => t.grupo_id === g.id),
      jogos.filter((j) => j.grupo_id === g.id),
    ),
  }));
  if (campeonato.formato === 'grupos_mata') aplicarZonasGrupos(resultado, campeonato);
  return resultado;
}

// Zonas visuais da fase de grupos (Melhores Colocados, EF 5.2): verde nos
// classificados diretos e ambar na posicao em disputa quando ha repescagem ou
// corte. Como na pelada, so marca grupos que ja tem resultado.
export function aplicarZonasGrupos(classificacao, campeonato) {
  // Modelo manual (RN-MM-12): as zonas saem dos rotulos, nao do plano de vagas.
  if (campeonato.mata_modelo === 'manual' && campeonato.mata_chave) {
    const { rotulos } = JSON.parse(campeonato.mata_chave);
    if (!rotulos) return;
    const zonas = zonasDosRotulos(rotulos, classificacao.map((g) => nomeCurtoDoGrupo(g.grupo)));
    for (const { linhas } of classificacao) {
      if (!linhas.some((l) => l.pj > 0)) continue;
      for (const l of linhas.slice(0, zonas.diretosPorGrupo)) l.zona = 'classifica';
      const emDisputa = zonas.posicaoDisputa && linhas[zonas.posicaoDisputa - 1];
      if (emDisputa && !emDisputa.zona) emDisputa.zona = 'disputa';
    }
    return;
  }
  const plano = planoDeVagas({
    numGrupos: classificacao.length,
    classificados: campeonato.classificados_por_grupo,
    tamanhos: classificacao.map((g) => g.linhas.length),
  });
  if (plano.modo === 'inviavel') return;
  for (const { linhas } of classificacao) {
    if (!linhas.some((l) => l.pj > 0)) continue;
    for (const l of linhas.slice(0, plano.diretosPorGrupo)) l.zona = 'classifica';
    const emDisputa = plano.modo !== 'exata' && linhas[plano.diretosPorGrupo];
    if (emDisputa) emDisputa.zona = 'disputa';
  }
}

// Zonas visuais do ranking da pelada (fase 4b, RN-PE-06): premiacao no topo
// (medalhas) e zona de rebaixamento na base. So marca depois do 1o resultado.
export function aplicarZonasPelada(linhas, campeonato) {
  if (!linhas.some((l) => l.pj > 0)) return;
  const nPremiados = Math.min(campeonato.premiacao === 'top3' ? 3 : 1, linhas.length);
  linhas.slice(0, nPremiados).forEach((l, i) => { l.zona = 'premiacao'; l.medalha = i + 1; });

  if (!campeonato.rebaixamento_modo || !campeonato.rebaixamento_qtd) return;
  if (campeonato.rebaixamento_modo === 'colocados') {
    // Ultimas N posicoes do ranking ja desempatado.
    for (const l of linhas.slice(Math.max(0, linhas.length - campeonato.rebaixamento_qtd))) {
      if (!l.zona) l.zona = 'rebaixamento';
    }
  } else {
    // 'pontuacoes': os N menores valores DISTINTOS de pontos, empates incluidos.
    const menores = new Set(
      [...new Set(linhas.map((l) => l.pts))].sort((a, b) => a - b).slice(0, campeonato.rebaixamento_qtd),
    );
    for (const l of linhas) {
      if (!l.zona && menores.has(l.pts)) l.zona = 'rebaixamento';
    }
  }
}

// Os grupos nascem como "Grupo A"; os rotulos falam so a letra.
const nomeCurtoDoGrupo = (grupo) => String(grupo?.nome ?? '').replace(/^Grupo\s+/i, '');

// ---------- melhores colocados: plano de vagas e ranking entre grupos ----------

// Plano de vagas + ranking entre grupos derivados da classificacao ja
// calculada (nada e armazenado). Base comum do payload `vagas` e da geracao
// do mata-mata.
function analiseDeVagas(campeonato, classificacao) {
  const porGrupo = classificacao.filter((g) => g.grupo);
  if (!porGrupo.length) return null;
  const plano = planoDeVagas({
    numGrupos: porGrupo.length,
    classificados: campeonato.classificados_por_grupo,
    tamanhos: porGrupo.map((g) => g.linhas.length),
  });
  let ranking = [];
  if (plano.modo === 'repescagem' || plano.modo === 'corte') {
    const candidatos = porGrupo
      .map((g) => {
        const linha = g.linhas[plano.posicaoDisputa - 1];
        return linha ? { ...linha, grupo_id: g.grupo.id, grupo_nome: g.grupo.nome } : null;
      })
      .filter(Boolean);
    ranking = rankearEntreGrupos(candidatos, JSON.parse(campeonato.criterios_desempate));
  }
  return { porGrupo, plano, ranking };
}

// Reencontros de mesmo grupo na 1a fase de um mata JA GERADO (RN-MC-04).
function reencontrosNoMata(db, campeonatoId) {
  const grupoDoTime = new Map(
    db.prepare('SELECT id, grupo_id FROM times WHERE campeonato_id = ?').all(campeonatoId)
      .map((t) => [t.id, t.grupo_id]),
  );
  return db
    .prepare(
      `SELECT confronto, time_casa_id, time_fora_id FROM jogos
       WHERE campeonato_id = ? AND fase = 'mata' AND rodada = 1 AND perna = 1`,
    )
    .all(campeonatoId)
    .filter((j) => j.time_casa_id != null && j.time_fora_id != null
      && grupoDoTime.get(j.time_casa_id) === grupoDoTime.get(j.time_fora_id))
    .map((j) => j.confronto);
}

// Bloco `vagas` do modelo manual (fase C): mesma forma do payload de Melhores
// Colocados — para as telas nao saberem a diferenca — mas com a chave, a
// posicao em disputa e o ranking saindo dos ROTULOS declarados.
function vagasDosRotulos(db, campeonato, classificacao) {
  const porGrupo = classificacao.filter((g) => g.grupo);
  const { rotulos, vagas } = JSON.parse(campeonato.mata_chave);
  if (!porGrupo.length || !rotulos) return null;

  const nomes = porGrupo.map((g) => nomeCurtoDoGrupo(g.grupo));
  const { diretosPorGrupo, posicaoDisputa } = zonasDosRotulos(rotulos, nomes);
  const emDisputa = rotulos.filter(
    (r) => r.tipo === 'melhor_posicao' && r.posicao === posicaoDisputa,
  ).length;

  // Ranking entre grupos so existe quando ha vaga decidida por comparacao.
  const criterios = JSON.parse(campeonato.criterios_desempate);
  let ranking = [];
  let criteriosMedia = [];
  if (emDisputa > 0) {
    const candidatos = gruposElegiveis(rotulos, posicaoDisputa, nomes)
      .map((nome) => {
        const g = porGrupo.find((x) => nomeCurtoDoGrupo(x.grupo) === nome);
        const linha = g?.linhas[posicaoDisputa - 1];
        return linha ? { ...linha, grupo_id: g.grupo.id, grupo_nome: g.grupo.nome } : null;
      })
      .filter(Boolean);
    ranking = rankearEntreGrupos(candidatos, criterios);
    criteriosMedia = criteriosDeMedia(criterios);
  }

  const tamanhos = porGrupo.map((g) => g.linhas.length);
  return {
    modo: 'manual',
    chave: vagas,
    diretos_por_grupo: diretosPorGrupo,
    total_diretos: diretosPorGrupo * nomes.length,
    posicao_disputa: posicaoDisputa,
    em_disputa: emDisputa,
    resumo: resumoDosRotulos(rotulos, nomes),
    grupos_desiguais: new Set(tamanhos).size > 1,
    criterios_media: criteriosMedia,
    ranking: ranking.map((l, i) => ({
      time_id: l.time_id,
      nome: l.nome,
      grupo_id: l.grupo_id,
      grupo_nome: l.grupo_nome,
      pj: l.pj,
      medias: Object.fromEntries(criteriosMedia.map((c) => {
        const v = mediaDoCriterio(l, c);
        return [c, v === Infinity ? null : Math.round(v * 1000) / 1000];
      })),
      classifica: i < emDisputa,
    })),
    repescados: ranking.slice(0, emDisputa).map((l) => l.time_id),
    reencontros: reencontrosNoMata(db, campeonato.id),
  };
}

// Bloco derivado `vagas` dos payloads do admin e da pagina publica (EF 7):
// modo, posicao em disputa, resumo e o ranking entre grupos ao vivo.
// Recebe a classificacao ja calculada para nao computar duas vezes.
export function vagasDoCampeonato(db, campeonato, classificacao) {
  if (campeonato.formato !== 'grupos_mata') return null;
  // Modelo manual: quem manda sao os rotulos, nao o plano de vagas. Sem este
  // desvio o payload descreveria uma chave que nao e a do campeonato.
  if (campeonato.mata_modelo === 'manual' && campeonato.mata_chave) {
    return vagasDosRotulos(db, campeonato, classificacao);
  }
  const analise = analiseDeVagas(campeonato, classificacao);
  if (!analise) return null;
  const { porGrupo, plano, ranking } = analise;
  const numGrupos = porGrupo.length;
  const classificados = campeonato.classificados_por_grupo;
  const tamanhos = porGrupo.map((g) => g.linhas.length);
  const criteriosMedia = plano.modo === 'repescagem' || plano.modo === 'corte'
    ? criteriosDeMedia(JSON.parse(campeonato.criterios_desempate))
    : [];

  // Reencontros de mesmo grupo na 1a fase de um mata ja gerado (RN-MC-04).
  const primeiraFase = db
    .prepare(
      `SELECT confronto, time_casa_id, time_fora_id FROM jogos
       WHERE campeonato_id = ? AND fase = 'mata' AND rodada = 1 AND perna = 1`,
    )
    .all(campeonato.id);
  const grupoDoTime = new Map(
    db.prepare('SELECT id, grupo_id FROM times WHERE campeonato_id = ?').all(campeonato.id)
      .map((t) => [t.id, t.grupo_id]),
  );
  const reencontros = primeiraFase
    .filter((j) => j.time_casa_id != null && j.time_fora_id != null
      && grupoDoTime.get(j.time_casa_id) === grupoDoTime.get(j.time_fora_id))
    .map((j) => j.confronto);

  return {
    modo: plano.modo,
    chave: plano.vagas,
    diretos_por_grupo: plano.diretosPorGrupo,
    total_diretos: plano.diretosPorGrupo == null ? null : plano.diretosPorGrupo * numGrupos,
    posicao_disputa: plano.posicaoDisputa,
    em_disputa: plano.emDisputa,
    resumo: resumoDoPlano(plano, { numGrupos, classificados, tamanhos }),
    grupos_desiguais: new Set(tamanhos).size > 1,
    criterios_media: criteriosMedia,
    // Infinity (razao "MAX") nao sobrevive a JSON: vira null e a UI mostra MAX.
    ranking: ranking.map((l, i) => ({
      time_id: l.time_id,
      nome: l.nome,
      grupo_id: l.grupo_id,
      grupo_nome: l.grupo_nome,
      pj: l.pj,
      medias: Object.fromEntries(criteriosMedia.map((c) => {
        const v = mediaDoCriterio(l, c);
        return [c, v === Infinity ? null : Math.round(v * 1000) / 1000];
      })),
      classifica: i < plano.emDisputa,
    })),
    repescados: ranking.slice(0, plano.emDisputa).map((l) => l.time_id),
    reencontros,
  };
}

// ---------- geracao do mata-mata (formato grupos_mata) ----------

export function gerarMataDoCampeonato(db, campeonato) {
  if (campeonato.formato !== 'grupos_mata') {
    throw erroValidacao('Este campeonato nao tem fase de grupos + mata-mata.');
  }
  const jaTem = db
    .prepare("SELECT COUNT(*) AS n FROM jogos WHERE campeonato_id = ? AND fase = 'mata'")
    .get(campeonato.id).n;
  if (jaTem) throw erroConflito('O mata-mata deste campeonato ja foi gerado.');

  const pendentes = db
    .prepare("SELECT COUNT(*) AS n FROM jogos WHERE campeonato_id = ? AND fase = 'grupos' AND status != 'encerrado'")
    .get(campeonato.id).n;
  if (pendentes) {
    throw erroValidacao(`Ainda ha ${pendentes} jogo(s) da fase de grupos sem resultado.`);
  }

  const classificacao = classificacaoDoCampeonato(db, campeonato);

  // Modelo manual (RN-MM-08/09): os rotulos declarados definem quem entra, e
  // em que vaga. Nada de plano de vagas — a chave ja tem tamanho e desenho.
  if (campeonato.mata_modelo === 'manual') {
    const meta = JSON.parse(campeonato.mata_chave);
    const desenho = obterDesenho(meta.vagas, meta.desenho);
    const times = resolverRotulos(
      meta.rotulos, classificacao.filter((g) => g.grupo), JSON.parse(campeonato.criterios_desempate),
    );
    const jogosManual = gerarChaveManual(desenho, times, { idaEVolta: !!campeonato.ida_volta_mata });
    return inserirJogosDoMata(db, campeonato, jogosManual);
  }

  const analise = analiseDeVagas(campeonato, classificacao);
  let jogos;
  if (!analise || analise.plano.modo === 'exata') {
    // Potencia exata: caminho original, intocado.
    const porGrupo = classificacao.map((g) =>
      g.linhas.slice(0, campeonato.classificados_por_grupo).map((l) => l.time_id),
    );
    const seeds = seedsDeGrupos(porGrupo, campeonato.classificados_por_grupo);
    jogos = gerarMataMata(seeds, { idaEVolta: !!campeonato.ida_volta_mata });
  } else if (analise.plano.modo === 'inviavel') {
    // Barrado na criacao; so acontece se os grupos mudarem por fora.
    throw erroValidacao('A configuracao de grupos e classificados nao fecha uma chave de mata-mata.');
  } else {
    // Repescagem ou corte (RN-MC-04): seeds por potes de posicao, repescados
    // por ultimo, e reencontros de grupo desfeitos por troca dentro do pote.
    const { porGrupo, plano, ranking } = analise;
    const { seeds, poteDoTime } = montarSeeds(porGrupo.map((g) => g.linhas), plano, ranking);
    const grupoDoTime = new Map(
      db.prepare('SELECT id, grupo_id FROM times WHERE campeonato_id = ?').all(campeonato.id)
        .map((t) => [t.id, t.grupo_id]),
    );
    const { pares } = ajustarReencontros(confrontosDaPrimeiraFase(seeds), grupoDoTime, poteDoTime);
    jogos = gerarMataMata(pares.flat(), { idaEVolta: !!campeonato.ida_volta_mata, pareamento: 'lista' });
  }

  return inserirJogosDoMata(db, campeonato, jogos);
}

// Grava a chave gerada, acrescentando a disputa de 3o lugar quando marcada
// (RN-MM-21/22): ela entra vazia — os perdedores chegam pela propagacao.
function inserirJogosDoMata(db, campeonato, jogos) {
  const disputa = campeonato.disputa_terceiro ? jogoDisputaTerceiro(jogos) : null;
  const todos = disputa ? [...jogos, disputa] : jogos;
  const insJogo = db.prepare(
    `INSERT INTO jogos (campeonato_id, fase, rodada, confronto, perna, time_casa_id, time_fora_id)
     VALUES (?, 'mata', ?, ?, ?, ?, ?)`,
  );
  for (const j of todos) {
    insJogo.run(campeonato.id, j.rodada, j.confronto, j.perna, j.time_casa_id, j.time_fora_id);
  }
  return todos.length;
}

// ---------- disputa de 3o lugar: liga/desliga (RN-MM-24) ----------

const jogosDoMata = (db, campeonatoId) => db
  .prepare("SELECT * FROM jogos WHERE campeonato_id = ? AND fase = 'mata' ORDER BY rodada, confronto, perna")
  .all(campeonatoId);

// Liga ou desliga a disputa de 3o. Antes do mata gerado so muda a flag; com o
// mata na mesa, cria (ou apaga) o jogo. Ligar depois das semifinais decididas
// ja traz os perdedores para as vagas — o organizador nao precisa esperar.
export function definirDisputaTerceiro(db, campeonato, ligar) {
  if (campeonato.formato === 'pontos') {
    throw erroValidacao('Este campeonato nao tem mata-mata.');
  }
  const alvo = ligar ? 1 : 0;
  const jogos = jogosDoMata(db, campeonato.id);
  const ultima = ultimaRodadaMata(jogos);
  const existente = jogos.filter((j) => j.rodada === ultima && j.confronto === CONFRONTO_TERCEIRO);

  if (existente.some((j) => j.status === 'encerrado')) {
    throw erroConflito('A disputa de 3o lugar ja tem resultado. Apague o resultado antes de mudar esta opcao.');
  }

  if (!ligar) {
    if (existente.length) {
      db.prepare("DELETE FROM jogos WHERE campeonato_id = ? AND fase = 'mata' AND rodada = ? AND confronto = ?")
        .run(campeonato.id, ultima, CONFRONTO_TERCEIRO);
    }
  } else if (jogos.length && !existente.length) {
    const chave = jogos.filter((j) => !(j.rodada === ultima && j.confronto === CONFRONTO_TERCEIRO));
    if (!aceitaDisputaTerceiro(chave)) {
      throw erroValidacao('Esta chave nao comporta disputa de 3o lugar: a fase anterior a final precisa ter dois confrontos.');
    }
    const novo = jogoDisputaTerceiro(chave);
    const id = Number(db
      .prepare(
        `INSERT INTO jogos (campeonato_id, fase, rodada, confronto, perna, time_casa_id, time_fora_id)
         VALUES (?, 'mata', ?, ?, ?, NULL, NULL)`,
      )
      .run(campeonato.id, novo.rodada, novo.confronto, novo.perna).lastInsertRowid);

    // Semifinais ja decididas preenchem as vagas na hora.
    for (const confronto of [0, 1]) {
      const pernas = chave.filter((j) => j.rodada === ultima - 1 && j.confronto === confronto);
      const perdedor = perdedorConfronto(pernas, vencedorConfronto(pernas));
      if (!perdedor) continue;
      const coluna = confronto % 2 === 0 ? 'time_casa_id' : 'time_fora_id';
      db.prepare(`UPDATE jogos SET ${coluna} = ? WHERE id = ?`).run(perdedor, id);
    }
  }

  db.prepare('UPDATE campeonatos SET disputa_terceiro = ? WHERE id = ?').run(alvo, campeonato.id);
  return db.prepare('SELECT * FROM campeonatos WHERE id = ?').get(campeonato.id);
}

// ---------- aba Chaveamento: ver e reposicionar (RN-MM-05/06/16) ----------

// Grupos do campeonato com o tamanho de cada um (base da validacao de rotulos).
function gruposComTamanho(db, campeonatoId) {
  return db
    .prepare(
      `SELECT g.nome, COUNT(t.id) AS tamanho FROM grupos g
       LEFT JOIN times t ON t.grupo_id = g.id
       WHERE g.campeonato_id = ? GROUP BY g.id ORDER BY g.nome`,
    )
    .all(campeonatoId)
    .map((g) => ({ nome: String(g.nome).replace(/^Grupo\s+/i, ''), tamanho: g.tamanho }));
}

// Chave do misto manual ANTES da geracao: desenho + rotulos + previa ao vivo
// (EF 5.4). A previa e so informativa — as vagas so se confirmam com a fase de
// grupos encerrada (RN-MM-13).
function chaveDeRotulos(db, campeonato, meta) {
  const desenho = obterDesenho(meta.vagas, meta.desenho);
  const classificacao = classificacaoDoCampeonato(db, campeonato).filter((g) => g.grupo);
  const criterios = JSON.parse(campeonato.criterios_desempate);
  const nomeDoTime = new Map(
    db.prepare('SELECT id, nome FROM times WHERE campeonato_id = ?').all(campeonato.id).map((t) => [t.id, t.nome]),
  );

  // A previa so vale quando ha jogo encerrado; e nunca derruba a tela.
  let previa = [];
  if (classificacao.some((g) => g.linhas.some((l) => l.pj > 0))) {
    try { previa = resolverRotulos(meta.rotulos, classificacao, criterios); } catch { previa = []; }
  }

  const rodadas = [];
  for (const c of desenho.confrontos) {
    let r = rodadas.find((x) => x.rodada === c.rodada);
    if (!r) { r = { rodada: c.rodada, nome: null, confrontos: [] }; rodadas.push(r); }
    r.confrontos.push({ confronto: c.confronto, disputa_terceiro: false, time_casa_id: null, time_fora_id: null });
  }
  for (const r of rodadas) r.nome = nomeRodadaMata(r.rodada, desenho.rodadas, r.confrontos.length);

  const slots = desenho.slots.map((s, i) => ({
    rodada: s.rodada,
    confronto: s.confronto,
    lado: s.lado,
    posicao: s.posicao,
    time_id: null,
    rotulo: meta.rotulos[s.posicao - 1],
    rotulo_texto: textoRotulo(meta.rotulos[s.posicao - 1]),
    previa_time_id: previa[s.posicao - 1] ?? null,
    previa_nome: previa[s.posicao - 1] ? nomeDoTime.get(previa[s.posicao - 1]) : null,
  }));

  const pendentes = db
    .prepare("SELECT COUNT(*) AS n FROM jogos WHERE campeonato_id = ? AND fase = 'grupos' AND status != 'encerrado'")
    .get(campeonato.id).n;

  return {
    modelo: 'manual',
    desenho: desenho.id,
    gerado: false,
    editavel: true,
    vagas: desenho.vagas,
    rodadas,
    slots,
    rotulos_disponiveis: rotulosDisponiveis(gruposComTamanho(db, campeonato.id)),
    grupos_pendentes: pendentes,
    // Aviso, nao trava: o gestor pode querer o reencontro (RN-MC-04).
    reencontros: reencontrosDosRotulos(meta.rotulos, desenho),
  };
}

// Estado da chave para a aba Chaveamento, nos DOIS modelos (na v1.2 o ajuste
// de posicoes vale tambem no Padrao). Tudo derivado dos proprios jogos: as
// vagas de entrada sao os lados preenchidos antes de qualquer resultado —
// o resto da chave se preenche por propagacao.
export function chaveamentoDoCampeonato(db, campeonato) {
  const pernas = db
    .prepare("SELECT * FROM jogos WHERE campeonato_id = ? AND fase = 'mata' ORDER BY rodada, confronto, perna")
    .all(campeonato.id);
  const meta = campeonato.mata_chave ? JSON.parse(campeonato.mata_chave) : null;
  const base = { modelo: campeonato.mata_modelo ?? 'padrao', desenho: meta?.desenho ?? null };
  if (!pernas.length) {
    // Misto manual antes de gerar o mata (RN-MM-08): a chave ja existe como
    // desenho + rotulos, e a previa mostra quem ocuparia cada vaga hoje.
    if (meta?.rotulos) return chaveDeRotulos(db, campeonato, meta);
    return { ...base, gerado: false, editavel: false, rodadas: [], slots: [] };
  }

  const ultima = ultimaRodadaMata(pernas);
  const ehDisputa = (j) => j.rodada === ultima && j.confronto === CONFRONTO_TERCEIRO;
  // RN-MM-06: qualquer resultado no mata congela desenho e posicoes.
  const editavel = pernas.every((j) => j.status !== 'encerrado');

  const rodadas = [];
  for (const j of pernas.filter((p) => p.perna === 1)) {
    let r = rodadas.find((x) => x.rodada === j.rodada);
    if (!r) {
      r = { rodada: j.rodada, nome: null, confrontos: [] };
      rodadas.push(r);
    }
    r.confrontos.push({
      confronto: j.confronto,
      disputa_terceiro: ehDisputa(j),
      time_casa_id: j.time_casa_id,
      time_fora_id: j.time_fora_id,
    });
  }
  for (const r of rodadas) {
    const daChave = r.confrontos.filter((c) => !c.disputa_terceiro).length;
    r.nome = nomeRodadaMata(r.rodada, ultima, daChave);
  }

  // Vagas de entrada: ESTRUTURAL, nao "o que esta preenchido". Um lado e vaga
  // de entrada quando nao existe confronto alimentando-o na rodada anterior
  // (folga ou 1a rodada) — regra que continua valendo depois que a propagacao
  // ja encheu as fases seguintes. A disputa de 3o fica fora: ela nao pertence
  // a arvore da chave, e alimentada pelos perdedores.
  const existe = new Set();
  for (const r of rodadas) {
    for (const c of r.confrontos.filter((x) => !x.disputa_terceiro)) existe.add(`${r.rodada}:${c.confronto}`);
  }
  const slots = [];
  for (const r of rodadas) {
    for (const c of r.confrontos.filter((x) => !x.disputa_terceiro)) {
      for (const [lado, alimentador, time] of [
        ['casa', c.confronto * 2, c.time_casa_id],
        ['fora', c.confronto * 2 + 1, c.time_fora_id],
      ]) {
        if (existe.has(`${r.rodada - 1}:${alimentador}`)) continue;
        slots.push({ rodada: r.rodada, confronto: c.confronto, lado, time_id: time });
      }
    }
  }
  return { ...base, gerado: true, editavel, rodadas, slots };
}

// Ponto unico de gravacao da aba Chaveamento: antes de o mata existir, o que
// se edita sao os ROTULOS (misto manual); depois, as POSICOES dos times.
export function salvarChaveamento(db, campeonato, corpo) {
  const meta = campeonato.mata_chave ? JSON.parse(campeonato.mata_chave) : null;
  const jaGerado = db
    .prepare("SELECT COUNT(*) AS n FROM jogos WHERE campeonato_id = ? AND fase = 'mata'")
    .get(campeonato.id).n > 0;
  if (!jaGerado && meta?.rotulos) return salvarRotulosChave(db, campeonato, corpo?.slots, meta);
  return salvarPosicoesChave(db, campeonato, corpo?.slots);
}

// Regrava os rotulos das vagas (RN-MM-08/10). O corpo traz as vagas com o
// rotulo de cada uma; a validacao e a mesma da criacao.
function salvarRotulosChave(db, campeonato, slots, meta) {
  const desenho = obterDesenho(meta.vagas, meta.desenho);
  if (!Array.isArray(slots) || slots.length !== desenho.vagas) {
    throw erroValidacao(`Informe as ${desenho.vagas} vagas do chaveamento.`);
  }
  const porPosicao = new Map();
  for (const s of slots) {
    const posicao = Number(s.posicao);
    const vaga = desenho.slots.find((x) => x.posicao === posicao);
    if (!vaga) throw erroValidacao('Ha vaga que nao pertence a este chaveamento.');
    if (porPosicao.has(posicao)) throw erroValidacao('Ha vaga repetida.');
    porPosicao.set(posicao, s.rotulo);
  }
  const rotulos = desenho.slots.map((s) => porPosicao.get(s.posicao));
  validarRotulos(rotulos, { vagas: desenho.vagas, grupos: gruposComTamanho(db, campeonato.id) });

  db.prepare('UPDATE campeonatos SET mata_chave = ?, classificados_por_grupo = ? WHERE id = ?').run(
    JSON.stringify({ ...meta, rotulos }),
    Math.max(1, zonasDosRotulos(rotulos, gruposComTamanho(db, campeonato.id).map((g) => g.nome)).diretosPorGrupo),
    campeonato.id,
  );
  return chaveamentoDoCampeonato(db, db.prepare('SELECT * FROM campeonatos WHERE id = ?').get(campeonato.id));
}

// Regrava as posicoes da chave (RN-MM-05/16): o corpo traz TODAS as vagas de
// entrada, com os mesmos participantes em qualquer ordem — trocar dois times
// de lugar e inverter o mando de um confronto sao a mesma operacao.
function salvarPosicoesChave(db, campeonato, slotsNovos) {
  const atual = chaveamentoDoCampeonato(db, campeonato);
  if (!atual.gerado) throw erroValidacao('O mata-mata deste campeonato ainda nao foi gerado.');
  if (!atual.editavel) {
    throw erroConflito('A chave ja tem resultado lancado e esta congelada. Apague os resultados do mata-mata para reposicionar.');
  }

  const chaveSlot = (s) => `${s.rodada}:${s.confronto}:${s.lado}`;
  const vagas = new Set(atual.slots.map(chaveSlot));
  if (!Array.isArray(slotsNovos) || slotsNovos.length !== vagas.size) {
    throw erroValidacao(`Informe as ${vagas.size} posicoes da chave.`);
  }
  const vistos = new Set();
  for (const s of slotsNovos) {
    const k = chaveSlot(s);
    if (!vagas.has(k)) throw erroValidacao('Ha posicao que nao pertence a esta chave.');
    if (vistos.has(k)) throw erroValidacao('Ha posicao repetida.');
    vistos.add(k);
  }
  const turma = (ts) => [...ts].sort((a, b) => a - b).join(',');
  if (turma(atual.slots.map((s) => s.time_id)) !== turma(slotsNovos.map((s) => Number(s.time_id)))) {
    throw erroValidacao('Use exatamente os participantes atuais da chave, sem repetir nem trocar de time.');
  }

  const pernas = db
    .prepare("SELECT * FROM jogos WHERE campeonato_id = ? AND fase = 'mata'")
    .all(campeonato.id);
  for (const s of slotsNovos) {
    for (const p of pernas.filter((j) => j.rodada === s.rodada && j.confronto === s.confronto)) {
      // Perna 1 respeita o lado; perna 2 inverte o mando (regra de sempre).
      const coluna = (p.perna === 1) === (s.lado === 'casa') ? 'time_casa_id' : 'time_fora_id';
      db.prepare(`UPDATE jogos SET ${coluna} = ? WHERE id = ?`).run(Number(s.time_id), p.id);
    }
  }
  return chaveamentoDoCampeonato(db, campeonato);
}
