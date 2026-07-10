// Rotas da API: autenticacao, administracao (sempre validando posse) e publica.
import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import {
  registrarConta, autenticar, criarSessao, encerrarSessao, hashSenha,
  lerCookie, cookieDeSessao, cookieDeSaida, exigirLogin, NOME_COOKIE,
} from '../src/auth.js';
import {
  campeonatoDaConta, timeDaConta, jogadorDaConta, jogoDaConta, bannerDaConta,
} from '../src/posse.js';
import {
  criarCampeonato, classificacaoDoCampeonato, gerarMataDoCampeonato, slugificar, slugDisponivel,
} from '../src/campeonatos.js';
import { registrarResultado, apagarResultado } from '../src/jogos.js';
import { inserirLoteJogadores } from '../src/jogadores.js';
import { parsearResultadoTexto } from '../src/resultado-texto.js';
import { salvarImagem, apagarImagem } from '../src/uploads.js';
import { dadosPublicos } from '../src/publico.js';
import { erroValidacao, erroConflito, erroProibido, erroNaoEncontrado } from '../src/erros.js';
import { CRITERIOS_VALIDOS } from '../src/classificacao.js';

const MAX_BANNERS = 5;

export function montarRotas(db) {
  const rotas = Router();
  const logado = exigirLogin(db);

  // ---------- autenticacao ----------

  rotas.post('/auth/registrar', (req, res) => {
    const conta = registrarConta(db, req.body ?? {});
    res.append('Set-Cookie', cookieDeSessao(criarSessao(db, conta.id)));
    res.status(201).json(conta);
  });

  rotas.post('/auth/login', (req, res) => {
    const conta = autenticar(db, req.body ?? {});
    res.append('Set-Cookie', cookieDeSessao(criarSessao(db, conta.id)));
    res.json(conta);
  });

  rotas.post('/auth/sair', (req, res) => {
    encerrarSessao(db, lerCookie(req, NOME_COOKIE));
    res.append('Set-Cookie', cookieDeSaida());
    res.json({ ok: true });
  });

  // Conta efetiva + flags do master: `master` diz se quem logou e master;
  // `tenant` aparece quando o master ESCOLHEU uma conta para gerenciar —
  // inclusive a propria (senao o painel nao teria como sair da tela de selecao).
  rotas.get('/auth/eu', logado, (req, res) => {
    res.json({
      id: req.conta.id,
      nome: req.conta.nome,
      email: req.conta.email,
      master: req.contaReal.papel === 'master',
      tenant: req.tenantEscolhido
        ? {
            id: req.conta.id,
            nome: req.conta.nome,
            email: req.conta.email,
            proprio: req.conta.id === req.contaReal.id,
          }
        : null,
    });
  });

  // ---------- master (administracao da plataforma) ----------

  const mestre = (req, _res, next) =>
    req.contaReal.papel === 'master' ? next() : next(erroProibido('Apenas o usuario master.'));

  // Lista todas as contas com contagens, para o master escolher o tenant.
  rotas.get('/master/contas', logado, mestre, (req, res) => {
    res.json(
      db
        .prepare(
          `SELECT c.id, c.nome, c.email, c.papel, c.criado_em,
             (SELECT COUNT(*) FROM campeonatos x WHERE x.conta_id = c.id) AS n_campeonatos
           FROM contas c ORDER BY c.nome`,
        )
        .all(),
    );
  });

  // Passa a gerenciar o conteudo da conta escolhida (gravado na sessao).
  rotas.post('/master/entrar', logado, mestre, (req, res) => {
    const alvo = db.prepare('SELECT id, nome, email FROM contas WHERE id = ?').get(Number(req.body?.conta_id));
    if (!alvo) throw erroNaoEncontrado('Conta nao encontrada.');
    db.prepare('UPDATE sessoes SET conta_efetiva_id = ? WHERE token = ?').run(
      alvo.id,
      lerCookie(req, NOME_COOKIE),
    );
    res.json({ ok: true, tenant: alvo });
  });

  // Volta a operar como a propria conta master.
  rotas.post('/master/voltar', logado, mestre, (req, res) => {
    db.prepare('UPDATE sessoes SET conta_efetiva_id = NULL WHERE token = ?').run(
      lerCookie(req, NOME_COOKIE),
    );
    res.json({ ok: true });
  });

  // ---------- master: manutencao de contas ----------

  const contaAlvo = (id) => {
    const alvo = db.prepare('SELECT id, nome, email, papel FROM contas WHERE id = ?').get(Number(id));
    if (!alvo) throw erroNaoEncontrado('Conta nao encontrada.');
    return alvo;
  };

  // Editar nome, e-mail e papel (promover/rebaixar master).
  rotas.patch('/master/contas/:id', logado, mestre, (req, res) => {
    const alvo = contaAlvo(req.params.id);
    const b = req.body ?? {};
    const nome = b.nome !== undefined ? String(b.nome).trim() : alvo.nome;
    if (!nome) throw erroValidacao('O nome nao pode ficar vazio.');
    let email = alvo.email;
    if (b.email !== undefined) {
      email = String(b.email).trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw erroValidacao('E-mail invalido.');
      const outro = db.prepare('SELECT id FROM contas WHERE email = ? AND id != ?').get(email, alvo.id);
      if (outro) throw erroConflito('Ja existe outra conta com este e-mail.');
    }
    let papel = alvo.papel;
    if (b.papel !== undefined) {
      if (!['organizador', 'master'].includes(b.papel)) throw erroValidacao('Papel invalido.');
      if (alvo.id === req.contaReal.id && b.papel !== 'master') {
        throw erroValidacao('Voce nao pode rebaixar a si mesmo.');
      }
      papel = b.papel;
    }
    db.prepare('UPDATE contas SET nome = ?, email = ?, papel = ? WHERE id = ?').run(nome, email, papel, alvo.id);
    res.json(contaAlvo(alvo.id));
  });

  // Reset de senha: gera uma senha temporaria (exibida UMA vez) e derruba as sessoes.
  rotas.post('/master/contas/:id/resetar-senha', logado, mestre, (req, res) => {
    const alvo = contaAlvo(req.params.id);
    const senhaTemporaria = randomBytes(8).toString('base64url').slice(0, 10);
    db.prepare('UPDATE contas SET senha_hash = ? WHERE id = ?').run(hashSenha(senhaTemporaria), alvo.id);
    db.prepare('DELETE FROM sessoes WHERE conta_id = ?').run(alvo.id);
    res.json({ ok: true, senha_temporaria: senhaTemporaria });
  });

  // Derruba todas as sessoes da conta (logout forcado em todos os aparelhos).
  rotas.post('/master/contas/:id/encerrar-sessoes', logado, mestre, (req, res) => {
    const alvo = contaAlvo(req.params.id);
    const info = db.prepare('DELETE FROM sessoes WHERE conta_id = ?').run(alvo.id);
    res.json({ ok: true, sessoes_encerradas: Number(info.changes) });
  });

  // Exclui a conta e TODO o conteudo dela (campeonatos, times, jogos, banners).
  // Contas master precisam ser rebaixadas antes — evita excluir a si mesmo.
  rotas.delete('/master/contas/:id', logado, mestre, (req, res) => {
    const alvo = contaAlvo(req.params.id);
    if (alvo.papel === 'master') {
      throw erroValidacao('Rebaixe esta conta master para organizador antes de exclui-la.');
    }
    // Melhor esforco: remove as imagens do disco antes do CASCADE apagar as linhas.
    const imagens = [
      ...db.prepare('SELECT logo AS c FROM campeonatos WHERE conta_id = ? AND logo IS NOT NULL').all(alvo.id),
      ...db.prepare(
        `SELECT t.escudo AS c FROM times t JOIN campeonatos x ON x.id = t.campeonato_id
         WHERE x.conta_id = ? AND t.escudo IS NOT NULL`,
      ).all(alvo.id),
      ...db.prepare(
        `SELECT t.foto AS c FROM times t JOIN campeonatos x ON x.id = t.campeonato_id
         WHERE x.conta_id = ? AND t.foto IS NOT NULL`,
      ).all(alvo.id),
      ...db.prepare(
        `SELECT j.sumula AS c FROM jogos j JOIN campeonatos x ON x.id = j.campeonato_id
         WHERE x.conta_id = ? AND j.sumula IS NOT NULL`,
      ).all(alvo.id),
      ...db.prepare(
        `SELECT b.imagem AS c FROM banners b JOIN campeonatos x ON x.id = b.campeonato_id
         WHERE x.conta_id = ?`,
      ).all(alvo.id),
    ];
    for (const { c } of imagens) apagarImagem(c);
    db.prepare('DELETE FROM contas WHERE id = ?').run(alvo.id);
    res.json({ ok: true });
  });

  // ---------- campeonatos (admin) ----------

  rotas.get('/campeonatos', logado, (req, res) => {
    const lista = db
      .prepare(
        `SELECT c.*,
           (SELECT COUNT(*) FROM times t WHERE t.campeonato_id = c.id) AS n_times,
           (SELECT COUNT(*) FROM jogos j WHERE j.campeonato_id = c.id) AS n_jogos,
           (SELECT COUNT(*) FROM jogos j WHERE j.campeonato_id = c.id AND j.status = 'encerrado') AS n_encerrados
         FROM campeonatos c WHERE c.conta_id = ? ORDER BY c.criado_em DESC`,
      )
      .all(req.conta.id);
    res.json(lista);
  });

  rotas.post('/campeonatos', logado, (req, res) => {
    res.status(201).json(criarCampeonato(db, req.conta.id, req.body ?? {}));
  });

  // Detalhe completo para o painel: times, jogadores, jogos, eventos, banners.
  rotas.get('/campeonatos/:id', logado, (req, res) => {
    const c = campeonatoDaConta(db, req.conta.id, req.params.id);
    res.json({
      campeonato: c,
      grupos: db.prepare('SELECT * FROM grupos WHERE campeonato_id = ? ORDER BY nome').all(c.id),
      times: db.prepare('SELECT * FROM times WHERE campeonato_id = ? ORDER BY nome').all(c.id),
      jogadores: db
        .prepare(
          `SELECT j.* FROM jogadores j JOIN times t ON t.id = j.time_id
           WHERE t.campeonato_id = ? ORDER BY j.nome`,
        )
        .all(c.id),
      jogos: db
        .prepare('SELECT * FROM jogos WHERE campeonato_id = ? ORDER BY fase, rodada, confronto, perna, id')
        .all(c.id),
      eventos: db
        .prepare('SELECT e.* FROM eventos e JOIN jogos j ON j.id = e.jogo_id WHERE j.campeonato_id = ?')
        .all(c.id),
      banners: db.prepare('SELECT * FROM banners WHERE campeonato_id = ? ORDER BY ordem, id').all(c.id),
      classificacao: classificacaoDoCampeonato(db, c),
    });
  });

  rotas.patch('/campeonatos/:id', logado, (req, res) => {
    const c = campeonatoDaConta(db, req.conta.id, req.params.id);
    const b = req.body ?? {};
    const nome = b.nome !== undefined ? String(b.nome).trim() : c.nome;
    if (!nome) throw erroValidacao('O nome nao pode ficar vazio.');
    let slug = c.slug;
    if (b.slug !== undefined && slugificar(b.slug) !== c.slug) {
      slug = slugDisponivel(db, slugificar(b.slug));
    }
    let criterios = c.criterios_desempate;
    if (b.criterios_desempate !== undefined) {
      if (!Array.isArray(b.criterios_desempate) || b.criterios_desempate.some((x) => !CRITERIOS_VALIDOS.includes(x))) {
        throw erroValidacao('Criterios de desempate invalidos.');
      }
      criterios = JSON.stringify(b.criterios_desempate);
    }
    db.prepare(
      `UPDATE campeonatos SET nome = ?, temporada = ?, modalidade = ?, descricao = ?, cor_tema = ?,
       slug = ?, criterios_desempate = ?, publicado = ?, status = ? WHERE id = ?`,
    ).run(
      nome,
      b.temporada !== undefined ? (b.temporada ? String(b.temporada) : null) : c.temporada,
      b.modalidade !== undefined ? String(b.modalidade) : c.modalidade,
      b.descricao !== undefined ? (b.descricao ? String(b.descricao) : null) : c.descricao,
      b.cor_tema !== undefined ? String(b.cor_tema) : c.cor_tema,
      slug,
      criterios,
      b.publicado !== undefined ? (b.publicado ? 1 : 0) : c.publicado,
      b.status !== undefined && ['ativo', 'arquivado'].includes(b.status) ? b.status : c.status,
      c.id,
    );
    res.json(db.prepare('SELECT * FROM campeonatos WHERE id = ?').get(c.id));
  });

  rotas.delete('/campeonatos/:id', logado, (req, res) => {
    const c = campeonatoDaConta(db, req.conta.id, req.params.id);
    db.prepare('DELETE FROM campeonatos WHERE id = ?').run(c.id);
    res.json({ ok: true });
  });

  rotas.post('/campeonatos/:id/logo', logado, (req, res) => {
    const c = campeonatoDaConta(db, req.conta.id, req.params.id);
    const caminho = salvarImagem(req.body?.imagem, 'logo');
    apagarImagem(c.logo);
    db.prepare('UPDATE campeonatos SET logo = ? WHERE id = ?').run(caminho, c.id);
    res.json({ logo: caminho });
  });

  rotas.post('/campeonatos/:id/gerar-mata', logado, (req, res) => {
    const c = campeonatoDaConta(db, req.conta.id, req.params.id);
    const n = gerarMataDoCampeonato(db, c);
    res.status(201).json({ jogos_criados: n });
  });

  // ---------- times e jogadores (admin) ----------

  rotas.post('/campeonatos/:id/times', logado, (req, res) => {
    const c = campeonatoDaConta(db, req.conta.id, req.params.id);
    // Times so podem ser adicionados antes da tabela ter jogos (senao a tabela ja gerada fica furada).
    const temJogos = db.prepare('SELECT COUNT(*) AS n FROM jogos WHERE campeonato_id = ?').get(c.id).n;
    if (temJogos) {
      throw erroConflito('A tabela ja foi gerada; nao e possivel adicionar times a este campeonato.');
    }
    const nome = String(req.body?.nome ?? '').trim();
    if (!nome) throw erroValidacao('Informe o nome do time.');
    const info = db
      .prepare('INSERT INTO times (campeonato_id, grupo_id, nome) VALUES (?, ?, ?)')
      .run(c.id, req.body?.grupo_id ?? null, nome);
    res.status(201).json(db.prepare('SELECT * FROM times WHERE id = ?').get(Number(info.lastInsertRowid)));
  });

  rotas.patch('/times/:id', logado, (req, res) => {
    const t = timeDaConta(db, req.conta.id, req.params.id);
    const nome = req.body?.nome !== undefined ? String(req.body.nome).trim() : t.nome;
    if (!nome) throw erroValidacao('O nome do time nao pode ficar vazio.');
    db.prepare('UPDATE times SET nome = ? WHERE id = ?').run(nome, t.id);
    res.json(db.prepare('SELECT * FROM times WHERE id = ?').get(t.id));
  });

  rotas.post('/times/:id/escudo', logado, (req, res) => {
    const t = timeDaConta(db, req.conta.id, req.params.id);
    const caminho = salvarImagem(req.body?.imagem, 'escudo');
    apagarImagem(t.escudo);
    db.prepare('UPDATE times SET escudo = ? WHERE id = ?').run(caminho, t.id);
    res.json({ escudo: caminho });
  });

  rotas.post('/times/:id/foto', logado, (req, res) => {
    const t = timeDaConta(db, req.conta.id, req.params.id);
    const caminho = salvarImagem(req.body?.imagem, 'foto');
    apagarImagem(t.foto);
    db.prepare('UPDATE times SET foto = ? WHERE id = ?').run(caminho, t.id);
    res.json({ foto: caminho });
  });

  rotas.post('/times/:id/jogadores', logado, (req, res) => {
    const t = timeDaConta(db, req.conta.id, req.params.id);
    const nome = String(req.body?.nome ?? '').trim();
    if (!nome) throw erroValidacao('Informe o nome do jogador.');
    const numero = req.body?.numero != null && req.body.numero !== '' ? Number(req.body.numero) : null;
    const info = db
      .prepare('INSERT INTO jogadores (time_id, nome, numero) VALUES (?, ?, ?)')
      .run(t.id, nome, numero);
    res.status(201).json(db.prepare('SELECT * FROM jogadores WHERE id = ?').get(Number(info.lastInsertRowid)));
  });

  // Cadastro em lote: texto com um jogador por linha ("nome,numero", numero opcional).
  rotas.post('/times/:id/jogadores/lote', logado, (req, res) => {
    const t = timeDaConta(db, req.conta.id, req.params.id);
    res.status(201).json(inserirLoteJogadores(db, t.id, req.body?.texto));
  });

  rotas.patch('/jogadores/:id', logado, (req, res) => {
    const j = jogadorDaConta(db, req.conta.id, req.params.id);
    const nome = req.body?.nome !== undefined ? String(req.body.nome).trim() : j.nome;
    if (!nome) throw erroValidacao('O nome do jogador nao pode ficar vazio.');
    const numero =
      req.body?.numero !== undefined
        ? (req.body.numero != null && req.body.numero !== '' ? Number(req.body.numero) : null)
        : j.numero;
    db.prepare('UPDATE jogadores SET nome = ?, numero = ? WHERE id = ?').run(nome, numero, j.id);
    res.json(db.prepare('SELECT * FROM jogadores WHERE id = ?').get(j.id));
  });

  rotas.delete('/jogadores/:id', logado, (req, res) => {
    const j = jogadorDaConta(db, req.conta.id, req.params.id);
    // Eventos historicos ficam com jogador nulo (gols "sem autor"), nao somem.
    db.prepare('DELETE FROM jogadores WHERE id = ?').run(j.id);
    res.json({ ok: true });
  });

  // ---------- jogos e resultados (admin) ----------

  rotas.patch('/jogos/:id/agenda', logado, (req, res) => {
    const j = jogoDaConta(db, req.conta.id, req.params.id);
    db.prepare('UPDATE jogos SET data = ?, local = ?, obs = ? WHERE id = ?').run(
      req.body?.data !== undefined ? (req.body.data ? String(req.body.data) : null) : j.data,
      req.body?.local !== undefined ? (req.body.local ? String(req.body.local) : null) : j.local,
      req.body?.obs !== undefined ? (req.body.obs ? String(req.body.obs) : null) : j.obs,
      j.id,
    );
    res.json(db.prepare('SELECT * FROM jogos WHERE id = ?').get(j.id));
  });

  rotas.post('/jogos/:id/resultado', logado, (req, res) => {
    const j = jogoDaConta(db, req.conta.id, req.params.id);
    res.json(registrarResultado(db, j, req.body ?? {}));
  });

  // Resultado por texto estruturado (GOLS/CARTOES TIME CASA/VISITANTE).
  // O placar e calculado automaticamente a partir dos gols do texto.
  rotas.post('/jogos/:id/resultado-texto', logado, (req, res) => {
    const j = jogoDaConta(db, req.conta.id, req.params.id);
    if (!j.time_casa_id || !j.time_fora_id) {
      throw erroValidacao('Este jogo ainda nao tem os dois times definidos.');
    }
    const carregarTime = (id) => ({
      ...db.prepare('SELECT id, nome FROM times WHERE id = ?').get(id),
      jogadores: db.prepare('SELECT id, nome FROM jogadores WHERE time_id = ?').all(id),
    });
    const parseado = parsearResultadoTexto(req.body?.texto, {
      casa: carregarTime(j.time_casa_id),
      fora: carregarTime(j.time_fora_id),
    });
    res.json(registrarResultado(db, j, {
      ...parseado,
      penaltis_casa: req.body?.penaltis_casa,
      penaltis_fora: req.body?.penaltis_fora,
    }));
  });

  rotas.delete('/jogos/:id/resultado', logado, (req, res) => {
    const j = jogoDaConta(db, req.conta.id, req.params.id);
    apagarResultado(db, j);
    res.json({ ok: true });
  });

  rotas.post('/jogos/:id/sumula', logado, (req, res) => {
    const j = jogoDaConta(db, req.conta.id, req.params.id);
    const caminho = salvarImagem(req.body?.imagem, 'sumula');
    apagarImagem(j.sumula);
    db.prepare('UPDATE jogos SET sumula = ? WHERE id = ?').run(caminho, j.id);
    res.json({ sumula: caminho });
  });

  rotas.delete('/jogos/:id/sumula', logado, (req, res) => {
    const j = jogoDaConta(db, req.conta.id, req.params.id);
    apagarImagem(j.sumula);
    db.prepare('UPDATE jogos SET sumula = NULL WHERE id = ?').run(j.id);
    res.json({ ok: true });
  });

  // ---------- banners (admin, maximo 5 por campeonato) ----------

  rotas.post('/campeonatos/:id/banners', logado, (req, res) => {
    const c = campeonatoDaConta(db, req.conta.id, req.params.id);
    const n = db.prepare('SELECT COUNT(*) AS n FROM banners WHERE campeonato_id = ?').get(c.id).n;
    if (n >= MAX_BANNERS) throw erroConflito(`Limite de ${MAX_BANNERS} banners por campeonato.`);
    const caminho = salvarImagem(req.body?.imagem, 'banner');
    const info = db
      .prepare('INSERT INTO banners (campeonato_id, imagem, link, ordem) VALUES (?, ?, ?, ?)')
      .run(c.id, caminho, req.body?.link ? String(req.body.link) : null, n);
    res.status(201).json(db.prepare('SELECT * FROM banners WHERE id = ?').get(Number(info.lastInsertRowid)));
  });

  rotas.patch('/banners/:id', logado, (req, res) => {
    const b = bannerDaConta(db, req.conta.id, req.params.id);
    db.prepare('UPDATE banners SET link = ?, ordem = ?, ativo = ? WHERE id = ?').run(
      req.body?.link !== undefined ? (req.body.link ? String(req.body.link) : null) : b.link,
      req.body?.ordem !== undefined ? Number(req.body.ordem) : b.ordem,
      req.body?.ativo !== undefined ? (req.body.ativo ? 1 : 0) : b.ativo,
      b.id,
    );
    res.json(db.prepare('SELECT * FROM banners WHERE id = ?').get(b.id));
  });

  rotas.delete('/banners/:id', logado, (req, res) => {
    const b = bannerDaConta(db, req.conta.id, req.params.id);
    apagarImagem(b.imagem);
    db.prepare('DELETE FROM banners WHERE id = ?').run(b.id);
    res.json({ ok: true });
  });

  // ---------- publico ----------

  rotas.get('/publico/:slug', (req, res) => {
    res.json(dadosPublicos(db, req.params.slug));
  });

  return rotas;
}
