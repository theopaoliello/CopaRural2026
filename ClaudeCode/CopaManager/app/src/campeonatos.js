// Criacao e gestao de campeonatos: wizard, slug, grupos, times e geracao da tabela.
import { erroValidacao, erroConflito } from './erros.js';
import {
  gerarPontosCorridos,
  gerarMataMata,
  dividirEmGrupos,
  embaralhar,
  ehPotenciaDe2,
  seedsDeGrupos,
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
  if (nomesTimes.some((n) => n.length > 80)) {
    throw erroValidacao('Nome de time muito longo (limite: 80 caracteres).');
  }
  const nomesUnicos = new Set(nomesTimes.map((n) => n.toLowerCase()));
  if (nomesUnicos.size !== nomesTimes.length) throw erroValidacao('Ha times com nomes repetidos.');
  if (nomesTimes.length < 2) throw erroValidacao('Cadastre pelo menos 2 times.');

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

  if (formato === 'mata' && !ehPotenciaDe2(nomesTimes.length)) {
    throw erroValidacao('Mata-mata puro exige 2, 4, 8, 16... times.');
  }
  if (formato === 'grupos_mata') {
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
  }

  // O preset do esporte define os padroes; o organizador pode ajustar (RN-TC-02).
  const criteriosValidos = esporte.criterios_validos ?? CRITERIOS_VALIDOS;
  let criterios = dados.criterios_desempate ?? esporte.criterios ?? criteriosValidos;
  if (!Array.isArray(criterios) || criterios.some((c) => !criteriosValidos.includes(c))) {
    throw erroValidacao('Criterios de desempate invalidos.');
  }

  const slug = slugDisponivel(db, slugificar(dados.slug || `${nome} ${dados.temporada ?? ''}`));

  const info = db
    .prepare(
      `INSERT INTO campeonatos
       (conta_id, nome, temporada, esporte, modalidade, descricao, cor_tema, slug, formato,
        num_grupos, ida_volta_grupos, ida_volta_mata, classificados_por_grupo,
        pontos_vitoria, pontos_empate, criterios_desempate, melhor_de)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      classificadosPorGrupo,
      Math.max(0, Number(dados.pontos_vitoria ?? esporte.pontuacao?.vitoria ?? 3)),
      Math.max(0, Number(dados.pontos_empate ?? esporte.pontuacao?.empate ?? 1)),
      JSON.stringify(criterios),
      melhorDe,
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
    // Pareamento pela lista: sem sorteio, a ordem digitada monta o chaveamento
    // (1o x 2o, 3o x 4o...); com sorteio, a lista ja vem embaralhada.
    for (const j of gerarMataMata(ids, { idaEVolta: !!idaVoltaMata, pareamento: 'lista' })) {
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
      if (nome.length > 80) throw erroValidacao('Nome de jogador muito longo (limite: 80 caracteres).');
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
  if (divisoes.some((n) => n.length > 80)) throw erroValidacao('Nome de time muito longo (limite: 80 caracteres).');
  if (new Set(divisoes.map((n) => n.toLowerCase())).size !== divisoes.length) {
    throw erroValidacao('Ha times com nomes repetidos.');
  }

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

// Bloco derivado `vagas` dos payloads do admin e da pagina publica (EF 7):
// modo, posicao em disputa, resumo e o ranking entre grupos ao vivo.
// Recebe a classificacao ja calculada para nao computar duas vezes.
export function vagasDoCampeonato(db, campeonato, classificacao) {
  if (campeonato.formato !== 'grupos_mata') return null;
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

  const insJogo = db.prepare(
    `INSERT INTO jogos (campeonato_id, fase, rodada, confronto, perna, time_casa_id, time_fora_id)
     VALUES (?, 'mata', ?, ?, ?, ?, ?)`,
  );
  for (const j of jogos) {
    insJogo.run(campeonato.id, j.rodada, j.confronto, j.perna, j.time_casa_id, j.time_fora_id);
  }
  return jogos.length;
}
