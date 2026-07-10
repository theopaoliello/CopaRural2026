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
import { calcularClassificacao, cartoesPorTime, CRITERIOS_VALIDOS } from './classificacao.js';

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
  const idaVoltaMata = dados.ida_volta_mata ? 1 : 0;
  const sortear = dados.sortear !== false; // padrao: sorteia a distribuicao

  if (formato === 'mata' && !ehPotenciaDe2(nomesTimes.length)) {
    throw erroValidacao('Mata-mata puro exige 2, 4, 8, 16... times.');
  }
  if (formato === 'grupos_mata') {
    const classificados = numGrupos * classificadosPorGrupo;
    if (!ehPotenciaDe2(classificados)) {
      throw erroValidacao(
        `Grupos x classificados deve resultar em 2, 4, 8, 16... (hoje: ${numGrupos} x ${classificadosPorGrupo} = ${classificados}).`,
      );
    }
    const porGrupo = Math.floor(nomesTimes.length / numGrupos);
    if (classificadosPorGrupo >= porGrupo && nomesTimes.length % numGrupos === 0) {
      throw erroValidacao('Ha grupos em que todos os times se classificariam. Ajuste a configuracao.');
    }
  }

  let criterios = dados.criterios_desempate ?? CRITERIOS_VALIDOS;
  if (!Array.isArray(criterios) || criterios.some((c) => !CRITERIOS_VALIDOS.includes(c))) {
    throw erroValidacao('Criterios de desempate invalidos.');
  }

  const slug = slugDisponivel(db, slugificar(dados.slug || `${nome} ${dados.temporada ?? ''}`));

  const info = db
    .prepare(
      `INSERT INTO campeonatos
       (conta_id, nome, temporada, modalidade, descricao, cor_tema, slug, formato,
        num_grupos, ida_volta_grupos, ida_volta_mata, classificados_por_grupo,
        pontos_vitoria, pontos_empate, criterios_desempate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      contaId,
      nome,
      textoLimitado(dados.temporada, 40, 'Temporada'),
      textoLimitado(dados.modalidade, 40, 'Modalidade') ?? 'Futebol',
      textoLimitado(dados.descricao, 2000, 'Descricao'),
      validarCorTema(dados.cor_tema ?? '#0b5c3f'),
      slug,
      formato,
      numGrupos,
      idaVoltaGrupos,
      idaVoltaMata,
      classificadosPorGrupo,
      Math.max(0, Number(dados.pontos_vitoria ?? 3)),
      Math.max(0, Number(dados.pontos_empate ?? 1)),
      JSON.stringify(criterios),
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

// ---------- classificacao de um campeonato ----------

// Calcula a classificacao da fase de grupos, agrupada por grupo (ou geral).
export function classificacaoDoCampeonato(db, campeonato) {
  const times = db.prepare('SELECT * FROM times WHERE campeonato_id = ?').all(campeonato.id);
  const jogos = db
    .prepare("SELECT * FROM jogos WHERE campeonato_id = ? AND fase = 'grupos'")
    .all(campeonato.id);
  const eventos = db
    .prepare(
      `SELECT e.* FROM eventos e JOIN jogos j ON j.id = e.jogo_id
       WHERE j.campeonato_id = ? AND j.status = 'encerrado' AND j.fase = 'grupos'`,
    )
    .all(campeonato.id);

  const opcoes = {
    pontosVitoria: campeonato.pontos_vitoria,
    pontosEmpate: campeonato.pontos_empate,
    criterios: JSON.parse(campeonato.criterios_desempate),
    cartoesPorTime: cartoesPorTime(eventos),
  };

  const grupos = db.prepare('SELECT * FROM grupos WHERE campeonato_id = ? ORDER BY nome').all(campeonato.id);
  if (!grupos.length) {
    return [{ grupo: null, linhas: calcularClassificacao(times, jogos, opcoes) }];
  }
  return grupos.map((g) => ({
    grupo: g,
    linhas: calcularClassificacao(
      times.filter((t) => t.grupo_id === g.id),
      jogos.filter((j) => j.grupo_id === g.id),
      opcoes,
    ),
  }));
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

  const porGrupo = classificacaoDoCampeonato(db, campeonato).map((g) =>
    g.linhas.slice(0, campeonato.classificados_por_grupo).map((l) => l.time_id),
  );
  const seeds = seedsDeGrupos(porGrupo, campeonato.classificados_por_grupo);

  const insJogo = db.prepare(
    `INSERT INTO jogos (campeonato_id, fase, rodada, confronto, perna, time_casa_id, time_fora_id)
     VALUES (?, 'mata', ?, ?, ?, ?, ?)`,
  );
  const jogos = gerarMataMata(seeds, { idaEVolta: !!campeonato.ida_volta_mata });
  for (const j of jogos) {
    insJogo.run(campeonato.id, j.rodada, j.confronto, j.perna, j.time_casa_id, j.time_fora_id);
  }
  return jogos.length;
}
