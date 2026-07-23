// Rotas da API: autenticacao, administracao (sempre validando posse) e publica.
import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import {
  registrarConta, autenticar, criarSessao, encerrarSessao, hashSenha, conferirSenha,
  criarTokenVerificacao, confirmarEmail, contaViaGoogle,
  criarTokenRecuperacao, redefinirSenha,
  lerCookie, cookieDeSessao, cookieDeSaida, exigirLogin, contaDaSessao, NOME_COOKIE,
} from '../src/auth.js';
import { enviarEmail } from '../src/email.js';
import { googleConfigurado, urlDeAutorizacao, perfilDoCodigo } from '../src/google.js';
import {
  bannerDaConta,
  campeonatoComAcesso, timeComAcesso, jogadorComAcesso, jogoComAcesso,
  vinculoDoCampeonato, FLAG_DA_SECAO,
} from '../src/posse.js';
import {
  criarCampeonato, classificacaoDoCampeonato, gerarMataDoCampeonato, criarJogoAvulso,
  slugificar, slugDisponivel, textoLimitado, validarCorTema, validarPremiacaoRebaixamento,
  vagasDoCampeonato, definirDisputaTerceiro, chaveamentoDoCampeonato, salvarChaveamento,
  MAX_NOME_JOGADOR, MAX_NOME_TIME,
} from '../src/campeonatos.js';
import {
  planoDeVagas, sugerirCombinacao, textoSugestao, resumoDoPlano, tamanhosPrevistos,
} from '../src/melhores.js';
import { catalogoDeChaveamentos } from '../src/chaveamentos.js';
import { criarLimitador } from '../src/ratelimit.js';
import { registrarResultado, apagarResultado } from '../src/jogos.js';
import { matrizEntrosamento, sortearTimes } from '../src/sorteio.js';
import { inserirLoteJogadores, parsearLoteJogadores } from '../src/jogadores.js';
import {
  TIPOS_CONTA, limitesDaConta,
  conferirLimiteTimes, conferirLimiteJogadoresTime, conferirLimiteJogadoresPelada,
} from '../src/limites.js';
import { parsearResultadoTexto } from '../src/resultado-texto.js';
import { salvarImagem, apagarImagem } from '../src/uploads.js';
import { dadosPublicos } from '../src/publico.js';
import { seguir, deixarDeSeguir, estadoDeSeguir, listarSeguidos } from '../src/seguidores.js';
import {
  estadoEncerramento, sugerirPodio, encerrarCampeonato, reabrirCampeonato,
} from '../src/encerramento.js';
import {
  listarConectaveis, elencoParaConexao, solicitarConexao, minhasConexoes,
  removerConexaoDoAtleta, filaDoCampeonato, decidirConexao, aprovarTodasConexoes,
  revogarConexao, contarPendentes,
} from '../src/conexoes.js';
import { perfilDoAtleta, congelarEstatisticas, congelarConexao } from '../src/perfil.js';
import { notificacoesDaConta } from '../src/notificacoes.js';
import { erroValidacao, erroConflito, erroProibido, erroNaoEncontrado } from '../src/erros.js';
import { CRITERIOS_VALIDOS } from '../src/classificacao.js';
import { ESPORTES, obterEsporte } from '../src/esportes.js';

const MAX_BANNERS = 5;

// Links de banner aparecem como <a href> na pagina publica: apenas http(s),
// senao um organizador poderia plantar javascript: para os visitantes.
function validarLink(valor) {
  if (valor == null || valor === '') return null;
  const texto = String(valor).trim();
  if (texto.length > 500) throw erroValidacao('Link muito longo (limite: 500 caracteres).');
  let url;
  try {
    url = new URL(texto);
  } catch {
    throw erroValidacao('Link invalido. Use um endereco completo, ex.: https://exemplo.com');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw erroValidacao('Link invalido. Apenas enderecos http:// ou https://.');
  }
  return texto;
}

export function montarRotas(db, { limites = {} } = {}) {
  const rotas = Router();
  const logado = exigirLogin(db);

  // ---------- autenticacao ----------

  // Janela deslizante por IP: forca bruta de senha e criacao de contas em massa.
  const limiteLogin = criarLimitador({ max: 10, janelaMs: 10 * 60_000, ...limites.login });
  const limiteRegistro = criarLimitador({ max: 10, janelaMs: 60 * 60_000, ...limites.registro });
  const limiteReenvio = criarLimitador({ max: 5, janelaMs: 15 * 60_000, ...limites.reenvio });
  // Confirmacao tem limitador proprio: e a superficie de adivinhacao de token.
  const limiteConfirmacao = criarLimitador({ max: 10, janelaMs: 10 * 60_000, ...limites.confirmacao });
  // Esqueci minha senha: pedido (envio de e-mail) e redefinicao (adivinhacao de
  // token) tem orcamentos separados por IP (RN-ES-01).
  const limiteRecuperacao = criarLimitador({ max: 5, janelaMs: 15 * 60_000, ...limites.recuperacao });
  const limiteRedefinicao = criarLimitador({ max: 10, janelaMs: 10 * 60_000, ...limites.redefinicao });
  // Convites de colaborador disparam e-mail: limite por IP (RN-CO-12).
  const limiteConvite = criarLimitador({ max: 30, janelaMs: 60 * 60_000, ...limites.convite });
  // Seguir/deixar de seguir: evita inflar contadores de forma automatizada.
  const limiteSeguir = criarLimitador({ max: 60, janelaMs: 10 * 60_000, ...limites.seguir });
  // Solicitacoes de conexao de atleta (RN-AT-22): anti-spam na fila do dono.
  const limiteConexao = criarLimitador({ max: 20, janelaMs: 60 * 60_000, ...limites.conexao });

  // Login OPCIONAL: popula req.conta se houver sessao valida, mas nunca barra
  // o anonimo. Usado pelo estado do botao "Seguir" na pagina publica (RN-SG-06).
  const talvezLogado = (req, _res, next) => {
    const sessao = contaDaSessao(db, lerCookie(req, NOME_COOKIE));
    if (sessao) {
      req.conta = sessao.efetiva;
      req.contaReal = sessao.real;
    }
    next();
  };

  // Base dos links enviados por e-mail e do redirect do Google. Em producao,
  // defina URL_PUBLICA=https://copamanager.com.br; sem ela, usa o host da requisicao.
  const urlBase = (req) => process.env.URL_PUBLICA ?? `${req.protocol}://${req.get('host')}`;

  async function enviarEmailVerificacao(req, conta) {
    const token = criarTokenVerificacao(db, conta.id);
    const link = `${urlBase(req)}/verificar.html?token=${token}`;
    await enviarEmail({
      para: conta.email,
      assunto: 'Confirme seu e-mail — Copa Manager',
      texto:
        `Olá, ${conta.nome}!\n\nConfirme seu e-mail para ativar sua conta no Copa Manager:\n${link}\n\n` +
        'O link vale por 24 horas. Se você não criou esta conta, ignore este e-mail.',
      html:
        `<p>Olá, <strong>${conta.nome}</strong>!</p>` +
        '<p>Confirme seu e-mail para ativar sua conta no Copa Manager:</p>' +
        `<p><a href="${link}" style="background:#0b5c3f;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none">Confirmar meu e-mail</a></p>` +
        `<p>Ou copie este endereço no navegador:<br>${link}</p>` +
        '<p style="color:#777">O link vale por 24 horas. Se você não criou esta conta, ignore este e-mail.</p>',
    });
  }

  // Cadastro NAO cria sessao: o painel so abre depois da confirmacao do e-mail.
  rotas.post('/auth/registrar', limiteRegistro.middleware, async (req, res) => {
    const conta = registrarConta(db, req.body ?? {});
    await enviarEmailVerificacao(req, conta);
    res.status(201).json({ precisaVerificar: true, email: conta.email });
  });

  rotas.post('/auth/login', limiteLogin.middleware, (req, res) => {
    const conta = autenticar(db, req.body ?? {});
    if (!conta.email_verificado) {
      return res.status(403).json({
        erro: 'EmailNaoVerificado',
        mensagem: 'Confirme seu e-mail antes de entrar. Procure o link na sua caixa de entrada (ou spam).',
      });
    }
    delete conta.email_verificado;
    res.append('Set-Cookie', cookieDeSessao(criarSessao(db, conta.id)));
    res.json(conta);
  });

  // Consome o token do link enviado por e-mail e ja abre a sessao.
  rotas.post('/auth/confirmar-email', limiteConfirmacao.middleware, (req, res) => {
    const conta = confirmarEmail(db, req.body?.token);
    res.append('Set-Cookie', cookieDeSessao(criarSessao(db, conta.id)));
    res.json({ ok: true, nome: conta.nome });
  });

  // Resposta unica com ou sem conta: nao revela quais e-mails estao cadastrados.
  rotas.post('/auth/reenviar-verificacao', limiteReenvio.middleware, async (req, res) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const conta = db
      .prepare('SELECT id, nome, email FROM contas WHERE email = ? AND email_verificado = 0')
      .get(email);
    if (conta) await enviarEmailVerificacao(req, conta);
    res.json({ ok: true });
  });

  // ---------- esqueci minha senha ----------

  async function enviarEmailRecuperacao(req, conta) {
    const token = criarTokenRecuperacao(db, conta.id);
    const link = `${urlBase(req)}/redefinir.html?token=${token}`;
    await enviarEmail({
      para: conta.email,
      assunto: 'Redefinir sua senha — Copa Manager',
      texto:
        `Olá, ${conta.nome}!\n\nRecebemos um pedido para redefinir a senha da sua conta no Copa Manager. ` +
        `Crie uma nova senha por aqui:\n${link}\n\n` +
        'O link vale por 1 hora e só pode ser usado uma vez. Se você não pediu isso, ignore este e-mail — sua senha continua a mesma.',
      html:
        `<p>Olá, <strong>${conta.nome}</strong>!</p>` +
        '<p>Recebemos um pedido para redefinir a senha da sua conta no Copa Manager.</p>' +
        `<p><a href="${link}" style="background:#0b5c3f;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none">Criar nova senha</a></p>` +
        `<p>Ou copie este endereço no navegador:<br>${link}</p>` +
        '<p style="color:#777">O link vale por 1 hora e só pode ser usado uma vez. Se você não pediu isso, ignore este e-mail — sua senha continua a mesma.</p>',
    });
  }

  // Conta que so usa o Google (sem senha local): e-mail informativo, sem token.
  async function enviarEmailSenhaGoogle(conta) {
    await enviarEmail({
      para: conta.email,
      assunto: 'Redefinir sua senha — Copa Manager',
      texto:
        `Olá, ${conta.nome}!\n\nVocê pediu para redefinir a senha, mas sua conta no Copa Manager usa o ` +
        'Login com Google — ela não tem uma senha para trocar. Para entrar, use o botão "Entrar com Google" na tela de login.\n\n' +
        'Se você não pediu isso, pode ignorar este e-mail.',
      html:
        `<p>Olá, <strong>${conta.nome}</strong>!</p>` +
        '<p>Você pediu para redefinir a senha, mas sua conta no Copa Manager usa o <strong>Login com Google</strong> — ' +
        'ela não tem uma senha para trocar. Para entrar, use o botão "Entrar com Google" na tela de login.</p>' +
        '<p style="color:#777">Se você não pediu isso, pode ignorar este e-mail.</p>',
    });
  }

  // Resposta unica com ou sem conta (RN-ES-01/07): nao revela quais e-mails
  // existem. Conta com senha recebe o link; conta so-Google recebe informativo.
  rotas.post('/auth/esqueci-senha', limiteRecuperacao.middleware, async (req, res) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const conta = db.prepare('SELECT id, nome, email, senha_hash FROM contas WHERE email = ?').get(email);
    if (conta) {
      if (conta.senha_hash.includes(':')) await enviarEmailRecuperacao(req, conta);
      else await enviarEmailSenhaGoogle(conta);
    }
    res.json({ ok: true });
  });

  // Consome o token, grava a senha nova e ja abre uma sessao (RN-ES-05).
  rotas.post('/auth/redefinir-senha', limiteRedefinicao.middleware, (req, res) => {
    const conta = redefinirSenha(db, req.body?.token, req.body?.senha);
    res.append('Set-Cookie', cookieDeSessao(criarSessao(db, conta.id)));
    res.json({ ok: true, nome: conta.nome });
  });

  // ---------- login com Google (Authorization Code, server-side) ----------

  // O front usa para decidir se mostra o botao "Entrar com Google".
  rotas.get('/auth/config', (_req, res) => {
    res.json({ google: googleConfigurado() });
  });

  const cookieOauth = (valor, maxAge) =>
    `oauth_state=${valor}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` +
    (process.env.COOKIE_SEGURO ? '; Secure' : '');

  rotas.get('/auth/google', limiteLogin.middleware, (req, res) => {
    if (!googleConfigurado()) throw erroNaoEncontrado('Login com Google nao esta configurado.');
    const state = randomBytes(16).toString('hex'); // anti-CSRF do fluxo OAuth
    res.append('Set-Cookie', cookieOauth(state, 600));
    res.redirect(urlDeAutorizacao({ redirectUri: `${urlBase(req)}/api/auth/google/callback`, state }));
  });

  rotas.get('/auth/google/callback', async (req, res) => {
    try {
      const { code, state } = req.query;
      if (!code || !state || state !== lerCookie(req, 'oauth_state')) {
        throw erroValidacao('Sessao do login com Google expirou. Tente de novo.');
      }
      res.append('Set-Cookie', cookieOauth('', 0));
      const perfil = await perfilDoCodigo({
        code: String(code),
        redirectUri: `${urlBase(req)}/api/auth/google/callback`,
      });
      const conta = contaViaGoogle(db, perfil);
      res.append('Set-Cookie', cookieDeSessao(criarSessao(db, conta.id)));
      res.redirect('/admin');
    } catch (e) {
      // Erro vira query string na tela de login; detalhes so no log do servidor.
      console.error('[google] callback falhou:', e.message);
      res.redirect('/?google=erro');
    }
  });

  // LGPD (art. 18): o titular exclui a propria conta e todos os dados dela
  // (campeonatos, times, jogadores, jogos... caem pelo ON DELETE CASCADE).
  // Confirmacao: senha da conta; contas Google (sem senha) digitam o e-mail.
  rotas.delete('/auth/minha-conta', logado, (req, res) => {
    const conta = db.prepare('SELECT * FROM contas WHERE id = ?').get(req.contaReal.id);
    if (conta.papel === 'master') {
      throw erroProibido('Conta master nao pode se excluir pelo painel (remova o papel antes).');
    }
    const confirmacao = String(req.body?.confirmacao ?? '');
    const ok = conta.senha_hash.includes(':')
      ? conferirSenha(confirmacao.slice(0, 200), conta.senha_hash)
      : confirmacao.trim().toLowerCase() === conta.email;
    if (!ok) {
      throw erroValidacao(
        conta.senha_hash.includes(':')
          ? 'Senha incorreta.'
          : 'Digite o e-mail da conta para confirmar a exclusao.',
      );
    }
    // RN-AT-09: os campeonatos desta conta vao cair em CASCADE — congela antes
    // o historico dos OUTROS atletas conectados a eles. Os snapshots do
    // proprio titular somem junto com a conta (RN-AT-19 do perfil, LGPD).
    for (const { id } of db.prepare('SELECT id FROM campeonatos WHERE conta_id = ?').all(conta.id)) {
      congelarEstatisticas(db, id);
    }
    db.prepare('DELETE FROM contas WHERE id = ?').run(conta.id);
    res.append('Set-Cookie', cookieDeSaida());
    res.json({ ok: true });
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
    const contas = db
      .prepare(
        `SELECT c.id, c.nome, c.email, c.papel, c.criado_em, c.ultimo_login,
           c.tipo, c.max_campeonatos, c.max_times, c.max_jogadores_time, c.banners_liberados,
           (SELECT COUNT(*) FROM campeonatos x WHERE x.conta_id = c.id) AS n_campeonatos
         FROM contas c ORDER BY c.nome`,
      )
      .all();
    // limite efetivo de campeonatos (override > tipo), para o painel exibir N/L
    res.json(contas.map((c) => ({
      ...c,
      limite_campeonatos: c.max_campeonatos ?? TIPOS_CONTA[c.tipo] ?? TIPOS_CONTA.padrao,
    })));
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
    const alvo = db
      .prepare(
        `SELECT id, nome, email, papel, tipo, max_campeonatos, max_times, max_jogadores_time, banners_liberados
         FROM contas WHERE id = ?`,
      )
      .get(Number(id));
    if (!alvo) throw erroNaoEncontrado('Conta nao encontrada.');
    return alvo;
  };

  // Override de limite vindo do painel: vazio/null limpa (volta ao padrao do
  // tipo/global); senao inteiro >= 1 (RN-GC-10).
  const validarOverride = (valor, campo) => {
    if (valor == null || valor === '') return null;
    const n = Number(valor);
    if (!Number.isInteger(n) || n < 1) throw erroValidacao(`${campo} deve ser um numero inteiro maior que zero (ou vazio para usar o padrao).`);
    return n;
  };

  // Editar nome, e-mail, papel (promover/rebaixar master), tipo e limites.
  rotas.patch('/master/contas/:id', logado, mestre, (req, res) => {
    const alvo = contaAlvo(req.params.id);
    const b = req.body ?? {};
    const nome = b.nome !== undefined ? textoLimitado(b.nome, 80, 'Nome') : alvo.nome;
    if (!nome) throw erroValidacao('O nome nao pode ficar vazio.');
    let email = alvo.email;
    if (b.email !== undefined) {
      email = String(b.email).trim().toLowerCase();
      if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw erroValidacao('E-mail invalido.');
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
    // Gestao de Contas (RN-GC-01/04/05/10): tipo e overrides por conta.
    let tipo = alvo.tipo;
    if (b.tipo !== undefined) {
      if (TIPOS_CONTA[b.tipo] == null) throw erroValidacao('Tipo de conta invalido.');
      tipo = b.tipo;
    }
    const maxCampeonatos = b.max_campeonatos !== undefined
      ? validarOverride(b.max_campeonatos, 'Limite de campeonatos') : alvo.max_campeonatos;
    const maxTimes = b.max_times !== undefined
      ? validarOverride(b.max_times, 'Limite de times') : alvo.max_times;
    const maxJogadoresTime = b.max_jogadores_time !== undefined
      ? validarOverride(b.max_jogadores_time, 'Limite de jogadores por time') : alvo.max_jogadores_time;
    // RN-BA-01: master liga/desliga a secao Banners por conta.
    const bannersLiberados = b.banners_liberados !== undefined
      ? (b.banners_liberados ? 1 : 0) : alvo.banners_liberados;

    db.prepare(
      `UPDATE contas SET nome = ?, email = ?, papel = ?, tipo = ?,
         max_campeonatos = ?, max_times = ?, max_jogadores_time = ?, banners_liberados = ? WHERE id = ?`,
    ).run(nome, email, papel, tipo, maxCampeonatos, maxTimes, maxJogadoresTime, bannersLiberados, alvo.id);
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
    // RN-AT-09: congela o historico dos atletas conectados aos campeonatos
    // desta conta antes de o CASCADE apagar tudo (mesma regra da rota LGPD).
    for (const { id } of db.prepare('SELECT id FROM campeonatos WHERE conta_id = ?').all(alvo.id)) {
      congelarEstatisticas(db, id);
    }
    db.prepare('DELETE FROM contas WHERE id = ?').run(alvo.id);
    res.json({ ok: true });
  });

  // ---------- catalogo de esportes ----------

  // Catalogo estatico (sem dados de usuario): alimenta o menu do wizard.
  rotas.get('/esportes', (_req, res) => {
    res.json(ESPORTES.map(
      ({ chave, nome, icone, disponivel, variantes, variante_padrao, placar, empate, ranking, melhor_de, rotulos, colunas }) =>
        ({ chave, nome, icone, disponivel, variantes, variante_padrao, placar, empate, ranking, melhor_de, rotulos, colunas }),
    ));
  });

  // Resumo ao vivo do wizard (Melhores Colocados, RN-MC-06): mesmo motor da
  // validacao do servidor — o cliente nao duplica a regra.
  rotas.get('/vagas-preview', logado, (req, res) => {
    const numGrupos = Math.max(1, Math.trunc(Number(req.query.grupos) || 1));
    const classificados = Math.max(1, Math.trunc(Number(req.query.classificados) || 2));
    const totalTimes = Math.max(0, Math.trunc(Number(req.query.times) || 0));
    // Sem times digitados ainda, assume grupos grandes o bastante.
    const tamanhos = totalTimes > 0
      ? tamanhosPrevistos(totalTimes, numGrupos)
      : Array(numGrupos).fill(Infinity);
    const plano = planoDeVagas({ numGrupos, classificados, tamanhos });
    let sugestao = null;
    if (plano.modo === 'inviavel') {
      sugestao = textoSugestao(
        sugerirCombinacao({
          numGrupos, classificados, totalTimes: totalTimes || numGrupos * (classificados + 2),
        }),
        { numGrupos, classificados },
      );
    }
    res.json({
      modo: plano.modo,
      chave: plano.vagas,
      posicao_disputa: plano.posicaoDisputa,
      em_disputa: plano.emDisputa,
      resumo: resumoDoPlano(plano, { numGrupos, classificados, tamanhos: totalTimes > 0 ? tamanhos : [] }),
      sugestao,
      grupos_desiguais: totalTimes > 0 && new Set(tamanhos).size > 1,
      aviso: totalTimes > 0 && totalTimes < numGrupos * 2
        ? `Cadastre pelo menos ${numGrupos * 2} times (2 por grupo).`
        : null,
    });
  });

  // Catalogo de chaveamentos de um tamanho de chave (RN-MM-04): alimenta a
  // galeria do wizard e o desenhador. So descreve estrutura — nada de banco.
  rotas.get('/chaveamentos', logado, (req, res) => {
    res.json(catalogoDeChaveamentos(req.query.vagas));
  });

  // ---------- campeonatos (admin) ----------

  // Consumo e tetos da conta efetiva (RN-GC-12): alimenta o contador "2/3"
  // da tela Meus campeonatos. A fonte da verdade segue sendo a validacao
  // do servidor na criacao.
  rotas.get('/conta/limites', logado, (req, res) => {
    const limites = limitesDaConta(db, req.conta.id);
    const usados = db
      .prepare('SELECT COUNT(*) AS n FROM campeonatos WHERE conta_id = ?')
      .get(req.conta.id).n;
    res.json({ ...limites, usados });
  });

  rotas.get('/campeonatos', logado, (req, res) => {
    const contagens = `
      (SELECT COUNT(*) FROM times t WHERE t.campeonato_id = c.id) AS n_times,
      (SELECT COUNT(*) FROM jogos j WHERE j.campeonato_id = c.id) AS n_jogos,
      (SELECT COUNT(*) FROM jogos j WHERE j.campeonato_id = c.id AND j.status = 'encerrado') AS n_encerrados`;
    // n_seguidores so vai para os campeonatos PROPRIOS: a contagem e visivel
    // apenas ao dono (RN-SG, secao 7) — colaboradores e seguidores nao a veem.
    const proprios = db
      .prepare(
        `SELECT c.*, ${contagens}, 0 AS compartilhado, NULL AS dono_nome,
                (SELECT COUNT(*) FROM seguidores s WHERE s.campeonato_id = c.id) AS n_seguidores
         FROM campeonatos c WHERE c.conta_id = ? ORDER BY c.criado_em DESC`,
      )
      .all(req.conta.id);
    // Compartilhados comigo (RN-CO-07): campeonatos de outras contas onde a conta
    // e colaborador ativo. Nao contam no limite; marcados para a lista separar.
    const compartilhados = db
      .prepare(
        `SELECT c.*, ${contagens}, 1 AS compartilhado, dono.nome AS dono_nome
         FROM colaboradores col
         JOIN campeonatos c ON c.id = col.campeonato_id
         JOIN contas dono ON dono.id = c.conta_id
         WHERE col.conta_id = ? ORDER BY c.criado_em DESC`,
      )
      .all(req.conta.id);
    res.json([...proprios, ...compartilhados]);
  });

  rotas.post('/campeonatos', logado, (req, res) => {
    res.status(201).json(criarCampeonato(db, req.conta.id, req.body ?? {}));
  });

  // Detalhe completo para o painel: times, jogadores, jogos, eventos, banners.
  // Acessivel pelo dono ou por colaborador ativo (leitura); o bloco meu_acesso
  // dirige quais abas o painel mostra (RN-CO-04).
  rotas.get('/campeonatos/:id', logado, (req, res) => {
    const c = campeonatoComAcesso(db, req.conta.id, req.params.id, null);
    const v = vinculoDoCampeonato(db, req.conta.id, c);
    const ehDono = v.tipo === 'dono';
    const flag = (s) => ehDono || !!v.col?.[FLAG_DA_SECAO[s]];
    // Config e Banners sao sempre dono-only (RN-CO-05).
    const meuAcesso = {
      dono: ehDono,
      jogos: flag('jogos'), times: flag('times'), regras: flag('regras'), sorteio: flag('sorteio'),
      banners: ehDono, config: ehDono,
    };
    // Banners so interessa ao dono; master (tenant) ve sempre para poder remover.
    const bannersLiberados = !ehDono ? 0
      : (req.contaReal.papel === 'master'
        ? 1
        : (db.prepare('SELECT banners_liberados FROM contas WHERE id = ?').get(req.conta.id)?.banners_liberados ?? 0));
    const classificacao = classificacaoDoCampeonato(db, c);
    res.json({
      campeonato: c,
      grupos: db.prepare('SELECT * FROM grupos WHERE campeonato_id = ? ORDER BY nome').all(c.id),
      times: db.prepare('SELECT * FROM times WHERE campeonato_id = ? ORDER BY nome').all(c.id),
      jogadores: db
        .prepare(
          `SELECT j.* FROM jogadores j LEFT JOIN times t ON t.id = j.time_id
           WHERE COALESCE(j.campeonato_id, t.campeonato_id) = ? ORDER BY j.nome`,
        )
        .all(c.id),
      escalacoes: db
        .prepare('SELECT e.* FROM escalacoes e JOIN jogos j ON j.id = e.jogo_id WHERE j.campeonato_id = ?')
        .all(c.id),
      jogos: db
        .prepare('SELECT * FROM jogos WHERE campeonato_id = ? ORDER BY fase, rodada, confronto, perna, id')
        .all(c.id),
      eventos: db
        .prepare('SELECT e.* FROM eventos e JOIN jogos j ON j.id = e.jogo_id WHERE j.campeonato_id = ?')
        .all(c.id),
      sets: db
        .prepare('SELECT s.* FROM sets s JOIN jogos j ON j.id = s.jogo_id WHERE j.campeonato_id = ? ORDER BY s.jogo_id, s.numero')
        .all(c.id),
      // Colaborador nao gere banners: recebe lista vazia (RN-CO-05).
      banners: ehDono ? db.prepare('SELECT * FROM banners WHERE campeonato_id = ? ORDER BY ordem, id').all(c.id) : [],
      banners_liberados: bannersLiberados,
      meu_acesso: meuAcesso,
      // Badge da aba Atletas (fase B): pendentes so interessam ao dono.
      n_conexoes_pendentes: ehDono ? contarPendentes(db, c.id) : 0,
      classificacao,
      vagas: vagasDoCampeonato(db, c, classificacao),
    });
  });

  rotas.patch('/campeonatos/:id', logado, (req, res) => {
    const c = campeonatoComAcesso(db, req.conta.id, req.params.id, 'dono');
    const b = req.body ?? {};
    const nome = b.nome !== undefined ? textoLimitado(b.nome, 120, 'Nome do campeonato') : c.nome;
    if (!nome) throw erroValidacao('O nome nao pode ficar vazio.');
    let slug = c.slug;
    if (b.slug !== undefined && slugificar(b.slug) !== c.slug) {
      slug = slugDisponivel(db, slugificar(b.slug));
    }
    let criterios = c.criterios_desempate;
    if (b.criterios_desempate !== undefined) {
      const validos = obterEsporte(c.esporte)?.criterios_validos ?? CRITERIOS_VALIDOS;
      if (!Array.isArray(b.criterios_desempate) || b.criterios_desempate.some((x) => !validos.includes(x))) {
        throw erroValidacao('Criterios de desempate invalidos.');
      }
      criterios = JSON.stringify(b.criterios_desempate);
    }
    // Disputa de 3o lugar (RN-MM-24): muda a estrutura do mata-mata, entao sai
    // da UPDATE geral e passa pela funcao que cria/apaga o jogo.
    if (b.disputa_terceiro !== undefined && !!b.disputa_terceiro !== !!c.disputa_terceiro) {
      definirDisputaTerceiro(db, c, !!b.disputa_terceiro);
    }
    // Premiacao e rebaixamento so existem na pelada (fase 4b: config editavel).
    let premios = {
      premiacao: c.premiacao, premia_artilheiro: c.premia_artilheiro,
      rebaixamento_modo: c.rebaixamento_modo, rebaixamento_qtd: c.rebaixamento_qtd,
    };
    if (obterEsporte(c.esporte)?.ranking === 'individual') {
      premios = validarPremiacaoRebaixamento(b, premios);
    }
    db.prepare(
      `UPDATE campeonatos SET nome = ?, temporada = ?, modalidade = ?, descricao = ?, cor_tema = ?,
       slug = ?, criterios_desempate = ?, regras = ?, publicado = ?, status = ?,
       premiacao = ?, premia_artilheiro = ?, rebaixamento_modo = ?, rebaixamento_qtd = ?,
       aceita_conexoes = ? WHERE id = ?`,
    ).run(
      nome,
      b.temporada !== undefined ? textoLimitado(b.temporada, 40, 'Temporada') : c.temporada,
      b.modalidade !== undefined ? (textoLimitado(b.modalidade, 40, 'Modalidade') ?? c.modalidade) : c.modalidade,
      b.descricao !== undefined ? textoLimitado(b.descricao, 2000, 'Descricao') : c.descricao,
      b.cor_tema !== undefined ? validarCorTema(b.cor_tema) : c.cor_tema,
      slug,
      criterios,
      b.regras !== undefined ? textoLimitado(b.regras, 10000, 'Regras') : c.regras,
      b.publicado !== undefined ? (b.publicado ? 1 : 0) : c.publicado,
      b.status !== undefined && ['ativo', 'arquivado'].includes(b.status) ? b.status : c.status,
      premios.premiacao,
      premios.premia_artilheiro,
      premios.rebaixamento_modo,
      premios.rebaixamento_qtd,
      // RN-AT-19: dono liga/desliga as conexoes de atleta na copa dele.
      b.aceita_conexoes !== undefined ? (b.aceita_conexoes ? 1 : 0) : c.aceita_conexoes,
      c.id,
    );
    res.json(db.prepare('SELECT * FROM campeonatos WHERE id = ?').get(c.id));
  });

  rotas.delete('/campeonatos/:id', logado, (req, res) => {
    const c = campeonatoComAcesso(db, req.conta.id, req.params.id, 'dono');
    // RN-AT-09: congela ANTES do DELETE (o CASCADE nao da gancho) — o
    // historico dos atletas conectados nunca e apagado pela exclusao da copa.
    congelarEstatisticas(db, c.id);
    db.prepare('DELETE FROM campeonatos WHERE id = ?').run(c.id);
    res.json({ ok: true });
  });

  rotas.post('/campeonatos/:id/logo', logado, (req, res) => {
    const c = campeonatoComAcesso(db, req.conta.id, req.params.id, 'dono');
    const caminho = salvarImagem(req.body?.imagem, 'logo');
    apagarImagem(c.logo);
    db.prepare('UPDATE campeonatos SET logo = ? WHERE id = ?').run(caminho, c.id);
    res.json({ logo: caminho });
  });

  // Rota dedicada de Regras (RN-CO-03): separada da Config para o colaborador
  // com a flag Regras salvar sem precisar do PATCH geral (dono-only).
  rotas.patch('/campeonatos/:id/regras', logado, (req, res) => {
    const c = campeonatoComAcesso(db, req.conta.id, req.params.id, 'regras');
    const regras = req.body?.regras !== undefined ? textoLimitado(req.body.regras, 10000, 'Regras') : c.regras;
    db.prepare('UPDATE campeonatos SET regras = ? WHERE id = ?').run(regras, c.id);
    res.json({ regras });
  });

  // ---------- Pelada Epica: jogos avulsos e jogadores do campeonato ----------

  rotas.post('/campeonatos/:id/jogos', logado, (req, res) => {
    // Jogo avulso (flag Jogos) OU confirmacao do sorteio (flag Sorteio).
    const c = campeonatoComAcesso(db, req.conta.id, req.params.id, ['jogos', 'sorteio']);
    res.status(201).json(criarJogoAvulso(db, c, req.body ?? {}));
  });

  // ---------- Pelada Epica: sorteio de times (EF secao 7) ----------

  function campeonatoPelada(req) {
    const c = campeonatoComAcesso(db, req.conta.id, req.params.id, 'sorteio');
    if (obterEsporte(c.esporte)?.ranking !== 'individual') {
      throw erroValidacao('O sorteio de times e um recurso da Pelada Epica.');
    }
    return c;
  }
  function dadosDaMatriz(c) {
    const jogadores = db
      .prepare("SELECT * FROM jogadores WHERE campeonato_id = ? AND ativo = 1 ORDER BY tipo = 'suplente', nome COLLATE NOCASE")
      .all(c.id);
    const fixos = jogadores.filter((j) => j.tipo === 'fixo');
    const jogos = db.prepare('SELECT id, status FROM jogos WHERE campeonato_id = ?').all(c.id);
    const escalacoes = db
      .prepare('SELECT e.* FROM escalacoes e JOIN jogos j ON j.id = e.jogo_id WHERE j.campeonato_id = ?')
      .all(c.id);
    return { jogadores, fixos, matriz: matrizEntrosamento(fixos, jogos, escalacoes) };
  }

  // Dados da tela: jogadores ativos, matriz de entrosamento (fixos) e divisoes.
  rotas.get('/campeonatos/:id/sorteio', logado, (req, res) => {
    const c = campeonatoPelada(req);
    const { jogadores, fixos, matriz } = dadosDaMatriz(c);
    res.json({
      jogadores: jogadores.map((j) => ({ id: j.id, nome: j.nome, tipo: j.tipo, goleiro: j.goleiro })),
      fixos: fixos.map((j) => j.id),
      matriz,
      times: db.prepare('SELECT id, nome FROM times WHERE campeonato_id = ? ORDER BY id').all(c.id),
    });
  });

  // Proposta de times do dia: nada e gravado (a confirmacao usa POST .../jogos
  // com as escalacoes). body: { presentes: [ids], premium, time_casa_id?, time_fora_id? }
  rotas.post('/campeonatos/:id/sorteio', logado, (req, res) => {
    const c = campeonatoPelada(req);
    const b = req.body ?? {};
    const times = db.prepare('SELECT id, nome FROM times WHERE campeonato_id = ? ORDER BY id').all(c.id);
    const casa = times.find((t) => t.id === (b.time_casa_id != null ? Number(b.time_casa_id) : times[0]?.id));
    const fora = times.find((t) => t.id === (b.time_fora_id != null ? Number(b.time_fora_id) : times[1]?.id));
    if (!casa || !fora || casa.id === fora.id) throw erroValidacao('Escolha dois times diferentes deste campeonato.');

    const { jogadores, fixos, matriz } = dadosDaMatriz(c);
    const porId = new Map(jogadores.map((j) => [j.id, j]));
    const idsPresentes = [...new Set((Array.isArray(b.presentes) ? b.presentes : []).map(Number))];
    const presentes = idsPresentes.map((id) => {
      const j = porId.get(id);
      if (!j) throw erroValidacao('Ha presenca marcada para um jogador que nao esta ativo neste campeonato.');
      return j;
    });
    if (presentes.length < 2) throw erroValidacao('Marque pelo menos 2 presentes para sortear.');

    const proposta = sortearTimes({
      times: [casa, fora], presentes, fixos, matriz, premium: b.premium !== false,
    });
    res.json({
      premium: b.premium !== false,
      times: proposta.map((t) => ({
        time_id: t.time_id,
        nome: (t.time_id === casa.id ? casa : fora).nome,
        jogadores: t.jogadores.map((j) => ({ id: j.id, nome: j.nome, tipo: j.tipo, goleiro: j.goleiro })),
      })),
    });
  });

  // Apagar um jogo so faz sentido onde os jogos sao criados um a um.
  rotas.delete('/jogos/:id', logado, (req, res) => {
    const j = jogoComAcesso(db, req.conta.id, req.params.id, 'jogos');
    const c = db.prepare('SELECT esporte FROM campeonatos WHERE id = ?').get(j.campeonato_id);
    if (obterEsporte(c?.esporte)?.ranking !== 'individual') {
      throw erroValidacao('A tabela deste campeonato e gerada automaticamente e nao permite apagar jogos.');
    }
    db.prepare('DELETE FROM jogos WHERE id = ?').run(j.id); // eventos/escalacoes caem em cascata
    res.json({ ok: true });
  });

  rotas.post('/campeonatos/:id/jogadores', logado, (req, res) => {
    const c = campeonatoComAcesso(db, req.conta.id, req.params.id, 'times');
    if (obterEsporte(c.esporte)?.ranking !== 'individual') {
      throw erroValidacao('Neste esporte o jogador e cadastrado dentro de um time.');
    }
    const nome = textoLimitado(req.body?.nome, MAX_NOME_JOGADOR, 'Nome do jogador');
    if (!nome) throw erroValidacao('Informe o nome do jogador.');
    const tipo = req.body?.tipo ?? 'fixo';
    if (!['fixo', 'suplente'].includes(tipo)) throw erroValidacao('Tipo de jogador invalido.');
    // RN-GC-07: teto por campeonato na pelada (jogadores nao tem time fixo).
    const existentes = db.prepare('SELECT COUNT(*) AS n FROM jogadores WHERE campeonato_id = ?').get(c.id).n;
    const nTimes = db.prepare('SELECT COUNT(*) AS n FROM times WHERE campeonato_id = ?').get(c.id).n;
    conferirLimiteJogadoresPelada(db, c.conta_id, existentes + 1, nTimes);
    const info = db
      .prepare('INSERT INTO jogadores (campeonato_id, nome, tipo, goleiro) VALUES (?, ?, ?, ?)')
      .run(c.id, nome, tipo, req.body?.goleiro ? 1 : 0);
    res.status(201).json(db.prepare('SELECT * FROM jogadores WHERE id = ?').get(Number(info.lastInsertRowid)));
  });

  // ---------- aba Chaveamento (EF Mata-mata Manual, fase B) ----------

  // Estado da chave: desenho, vagas de entrada e se ainda e editavel. Leitura
  // vale para qualquer pessoa com acesso ao campeonato.
  rotas.get('/campeonatos/:id/chaveamento', logado, (req, res) => {
    const c = campeonatoComAcesso(db, req.conta.id, req.params.id);
    res.json(chaveamentoDoCampeonato(db, c));
  });

  // Reposicionar (ou declarar as vagas) e estrutural, como gerar o mata:
  // so o dono (RN-CO-05).
  rotas.put('/campeonatos/:id/chaveamento', logado, (req, res) => {
    const c = campeonatoComAcesso(db, req.conta.id, req.params.id, 'dono');
    res.json(salvarChaveamento(db, c, req.body ?? {}));
  });

  rotas.post('/campeonatos/:id/gerar-mata', logado, (req, res) => {
    // Gerar o mata-mata e estrutural/irreversivel: so o dono (RN-CO-05).
    const c = campeonatoComAcesso(db, req.conta.id, req.params.id, 'dono');
    const n = gerarMataDoCampeonato(db, c);
    res.status(201).json({ jogos_criados: n });
  });

  // ---------- encerramento com podio (EF Perfil do Atleta, fase A) ----------

  // Estado + sugestao do podio para o card de Config e o dialogo de exclusao
  // (EF 3.5). Encerrar e uma decisao sobre o desfecho da copa: so o dono.
  rotas.get('/campeonatos/:id/encerramento', logado, (req, res) => {
    const c = campeonatoComAcesso(db, req.conta.id, req.params.id, 'dono');
    const estado = estadoEncerramento(db, c);
    res.json({ ...estado, sugestao: estado.encerrado ? null : sugerirPodio(db, c) });
  });

  // Encerra com o podio declarado (RN-AT-13). body: { primeiro, segundo, terceiro }
  rotas.post('/campeonatos/:id/encerrar', logado, (req, res) => {
    const c = campeonatoComAcesso(db, req.conta.id, req.params.id, 'dono');
    res.json(encerrarCampeonato(db, c, req.body ?? {}));
  });

  // Reabre para correcoes (RN-AT-12): o podio sera declarado de novo.
  rotas.post('/campeonatos/:id/reabrir', logado, (req, res) => {
    const c = campeonatoComAcesso(db, req.conta.id, req.params.id, 'dono');
    res.json(reabrirCampeonato(db, c));
  });

  // ---------- conexoes de atleta (EF Perfil do Atleta, fase B) ----------

  // Lado do ATLETA: "Me conectar a Copa". Exige login (e-mail confirmado por
  // construcao: sessao so existe apos confirmar) e seguir a copa (RN-AT-02).
  rotas.get('/atleta/conectaveis', logado, (req, res) => {
    res.json(listarConectaveis(db, req.conta.id));
  });

  rotas.get('/atleta/copa/:slug/elenco', logado, (req, res) => {
    res.json(elencoParaConexao(db, req.conta.id, req.params.slug));
  });

  rotas.get('/atleta/conexoes', logado, (req, res) => {
    res.json(minhasConexoes(db, req.conta.id));
  });

  // body: { slug, jogador_id? , time_id? (copas 2x2/1x1), observacao? }
  rotas.post('/atleta/conexoes', limiteConexao.middleware, logado, (req, res) => {
    res.status(201).json(solicitarConexao(db, req.conta.id, req.body ?? {}));
  });

  // Cancela a solicitacao ou desconecta (RN-AT-06) — so a propria conta.
  rotas.delete('/atleta/conexoes/:id', logado, (req, res) => {
    res.json(removerConexaoDoAtleta(db, req.conta.id, req.params.id));
  });

  // Painel do Atleta (fase C): estatisticas ao vivo das copas conectadas,
  // uma linha por copa com totais + quebra por ano. Privado (RN-AT-18): cada
  // conta so ve o proprio perfil — o id vem da sessao, nunca da URL.
  rotas.get('/atleta/perfil', logado, (req, res) => {
    res.json(perfilDoAtleta(db, req.conta.id));
  });

  // Lado do DONO: fila de solicitacoes + conectados. Decidir quem e quem no
  // historico da copa e exclusivo do dono (RN-AT-05) — colaborador nao ve.
  rotas.get('/campeonatos/:id/conexoes', logado, (req, res) => {
    const c = campeonatoComAcesso(db, req.conta.id, req.params.id, 'dono');
    res.json(filaDoCampeonato(db, c));
  });

  // body: { acao: 'aprovar' | 'recusar' }
  rotas.post('/campeonatos/:id/conexoes/:cid/decidir', logado, (req, res) => {
    const c = campeonatoComAcesso(db, req.conta.id, req.params.id, 'dono');
    res.json(decidirConexao(db, c, req.params.cid, req.body?.acao, req.conta.id));
  });

  // Aprovar todas as pendentes de uma vez (EF Notificacoes, fase C / RN-NT-10).
  rotas.post('/campeonatos/:id/conexoes/aprovar-todas', logado, (req, res) => {
    const c = campeonatoComAcesso(db, req.conta.id, req.params.id, 'dono');
    res.json(aprovarTodasConexoes(db, c, req.conta.id));
  });

  rotas.delete('/campeonatos/:id/conexoes/:cid', logado, (req, res) => {
    const c = campeonatoComAcesso(db, req.conta.id, req.params.id, 'dono');
    res.json(revogarConexao(db, c, req.params.cid));
  });

  // ---------- central de notificacoes (EF Notificacoes, fase B) ----------

  // Notificacoes da conta logada (derivadas, RN-NT-08). No MVP: solicitacoes de
  // conexao pendentes agrupadas por copa do dono (RN-NT-06). O estado de "lido"
  // e do cliente (localStorage, RN-NT-09) — nao ha rota de "marcar como lido".
  rotas.get('/notificacoes', logado, (req, res) => {
    res.json(notificacoesDaConta(db, req.conta.id));
  });

  // ---------- times e jogadores (admin) ----------

  rotas.post('/campeonatos/:id/times', logado, (req, res) => {
    const c = campeonatoComAcesso(db, req.conta.id, req.params.id, 'times');
    // Times so podem ser adicionados antes da tabela ter jogos (senao a tabela ja gerada fica furada).
    const temJogos = db.prepare('SELECT COUNT(*) AS n FROM jogos WHERE campeonato_id = ?').get(c.id).n;
    if (temJogos) {
      throw erroConflito('A tabela ja foi gerada; nao e possivel adicionar times a este campeonato.');
    }
    const nome = textoLimitado(req.body?.nome, MAX_NOME_TIME, 'Nome do time');
    if (!nome) throw erroValidacao('Informe o nome do time.');
    const existentes = db.prepare('SELECT COUNT(*) AS n FROM times WHERE campeonato_id = ?').get(c.id).n;
    conferirLimiteTimes(db, c.conta_id, existentes + 1);
    const info = db
      .prepare('INSERT INTO times (campeonato_id, grupo_id, nome) VALUES (?, ?, ?)')
      .run(c.id, req.body?.grupo_id ?? null, nome);
    res.status(201).json(db.prepare('SELECT * FROM times WHERE id = ?').get(Number(info.lastInsertRowid)));
  });

  rotas.patch('/times/:id', logado, (req, res) => {
    const t = timeComAcesso(db, req.conta.id, req.params.id, 'times');
    const nome = req.body?.nome !== undefined ? textoLimitado(req.body.nome, MAX_NOME_TIME, 'Nome do time') : t.nome;
    if (!nome) throw erroValidacao('O nome do time nao pode ficar vazio.');
    db.prepare('UPDATE times SET nome = ? WHERE id = ?').run(nome, t.id);
    res.json(db.prepare('SELECT * FROM times WHERE id = ?').get(t.id));
  });

  rotas.post('/times/:id/escudo', logado, (req, res) => {
    const t = timeComAcesso(db, req.conta.id, req.params.id, 'times');
    const caminho = salvarImagem(req.body?.imagem, 'escudo');
    apagarImagem(t.escudo);
    db.prepare('UPDATE times SET escudo = ? WHERE id = ?').run(caminho, t.id);
    res.json({ escudo: caminho });
  });

  rotas.post('/times/:id/foto', logado, (req, res) => {
    const t = timeComAcesso(db, req.conta.id, req.params.id, 'times');
    const caminho = salvarImagem(req.body?.imagem, 'foto');
    apagarImagem(t.foto);
    db.prepare('UPDATE times SET foto = ? WHERE id = ?').run(caminho, t.id);
    res.json({ foto: caminho });
  });

  // Limite de jogadores por time (RN-GC-06/08): sempre pela conta DONA do
  // campeonato do time (nao por quem esta operando).
  const conferirJogadoresDoTime = (time, adicionando) => {
    const donaId = db.prepare('SELECT conta_id FROM campeonatos WHERE id = ?').get(time.campeonato_id).conta_id;
    const existentes = db.prepare('SELECT COUNT(*) AS n FROM jogadores WHERE time_id = ?').get(time.id).n;
    conferirLimiteJogadoresTime(db, donaId, existentes + adicionando);
  };

  rotas.post('/times/:id/jogadores', logado, (req, res) => {
    const t = timeComAcesso(db, req.conta.id, req.params.id, 'times');
    const nome = textoLimitado(req.body?.nome, MAX_NOME_JOGADOR, 'Nome do jogador');
    if (!nome) throw erroValidacao('Informe o nome do jogador.');
    conferirJogadoresDoTime(t, 1);
    const numero = req.body?.numero != null && req.body.numero !== '' ? Number(req.body.numero) : null;
    const info = db
      .prepare('INSERT INTO jogadores (time_id, nome, numero) VALUES (?, ?, ?)')
      .run(t.id, nome, numero);
    res.status(201).json(db.prepare('SELECT * FROM jogadores WHERE id = ?').get(Number(info.lastInsertRowid)));
  });

  // Cadastro em lote: texto com um jogador por linha ("nome,numero", numero opcional).
  rotas.post('/times/:id/jogadores/lote', logado, (req, res) => {
    const t = timeComAcesso(db, req.conta.id, req.params.id, 'times');
    const texto = String(req.body?.texto ?? '');
    if (texto.length > 20_000) throw erroValidacao('Texto do lote muito longo (limite: 20 mil caracteres).');
    // Tudo ou nada (RN-GC-06): valida o total resultante antes de inserir.
    conferirJogadoresDoTime(t, parsearLoteJogadores(texto).length);
    res.status(201).json(inserirLoteJogadores(db, t.id, texto));
  });

  rotas.patch('/jogadores/:id', logado, (req, res) => {
    const j = jogadorComAcesso(db, req.conta.id, req.params.id, 'times');
    const nome = req.body?.nome !== undefined ? textoLimitado(req.body.nome, MAX_NOME_JOGADOR, 'Nome do jogador') : j.nome;
    if (!nome) throw erroValidacao('O nome do jogador nao pode ficar vazio.');
    const numero =
      req.body?.numero !== undefined
        ? (req.body.numero != null && req.body.numero !== '' ? Number(req.body.numero) : null)
        : j.numero;
    // Pelada Epica: promover/rebaixar tipo, marcar goleiro e inativar (RN-PE-10).
    const tipo = req.body?.tipo !== undefined ? req.body.tipo : j.tipo;
    if (!['fixo', 'suplente'].includes(tipo)) throw erroValidacao('Tipo de jogador invalido.');
    const goleiro = req.body?.goleiro !== undefined ? (req.body.goleiro ? 1 : 0) : j.goleiro;
    const ativo = req.body?.ativo !== undefined ? (req.body.ativo ? 1 : 0) : j.ativo;
    db.prepare('UPDATE jogadores SET nome = ?, numero = ?, tipo = ?, goleiro = ?, ativo = ? WHERE id = ?')
      .run(nome, numero, tipo, goleiro, ativo, j.id);
    res.json(db.prepare('SELECT * FROM jogadores WHERE id = ?').get(j.id));
  });

  rotas.delete('/jogadores/:id', logado, (req, res) => {
    const j = jogadorComAcesso(db, req.conta.id, req.params.id, 'times');
    // EF 5.1: excluir o jogador derruba a conexao do atleta em cascata — o
    // historico dele congela ANTES para nao sumir junto.
    const cx = db
      .prepare("SELECT id FROM conexoes_atleta WHERE jogador_id = ? AND status = 'aprovada'")
      .get(j.id);
    if (cx) congelarConexao(db, cx.id);
    // Eventos historicos ficam com jogador nulo (gols "sem autor"), nao somem.
    db.prepare('DELETE FROM jogadores WHERE id = ?').run(j.id);
    res.json({ ok: true });
  });

  // ---------- jogos e resultados (admin) ----------

  rotas.patch('/jogos/:id/agenda', logado, (req, res) => {
    const j = jogoComAcesso(db, req.conta.id, req.params.id, 'jogos');
    db.prepare('UPDATE jogos SET data = ?, local = ?, obs = ? WHERE id = ?').run(
      req.body?.data !== undefined ? textoLimitado(req.body.data, 40, 'Data') : j.data,
      req.body?.local !== undefined ? textoLimitado(req.body.local, 200, 'Local') : j.local,
      req.body?.obs !== undefined ? textoLimitado(req.body.obs, 1000, 'Observacoes') : j.obs,
      j.id,
    );
    res.json(db.prepare('SELECT * FROM jogos WHERE id = ?').get(j.id));
  });

  rotas.post('/jogos/:id/resultado', logado, (req, res) => {
    const j = jogoComAcesso(db, req.conta.id, req.params.id, 'jogos');
    res.json(registrarResultado(db, j, req.body ?? {}));
  });

  // Resultado por texto estruturado (GOLS/CARTOES TIME CASA/VISITANTE).
  // O placar e calculado automaticamente a partir dos gols do texto.
  rotas.post('/jogos/:id/resultado-texto', logado, (req, res) => {
    const j = jogoComAcesso(db, req.conta.id, req.params.id, 'jogos');
    if (!j.time_casa_id || !j.time_fora_id) {
      throw erroValidacao('Este jogo ainda nao tem os dois times definidos.');
    }
    // A sumula de texto descreve gols e cartoes: so faz sentido no modelo A.
    const camp = db.prepare('SELECT esporte FROM campeonatos WHERE id = ?').get(j.campeonato_id);
    if (obterEsporte(camp?.esporte)?.placar === 'sets') {
      throw erroValidacao('Este esporte usa placar por sets: lance o resultado pelas parciais.');
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
    const j = jogoComAcesso(db, req.conta.id, req.params.id, 'jogos');
    apagarResultado(db, j);
    res.json({ ok: true });
  });

  rotas.post('/jogos/:id/sumula', logado, (req, res) => {
    const j = jogoComAcesso(db, req.conta.id, req.params.id, 'jogos');
    const caminho = salvarImagem(req.body?.imagem, 'sumula');
    apagarImagem(j.sumula);
    db.prepare('UPDATE jogos SET sumula = ? WHERE id = ?').run(caminho, j.id);
    res.json({ sumula: caminho });
  });

  rotas.delete('/jogos/:id/sumula', logado, (req, res) => {
    const j = jogoComAcesso(db, req.conta.id, req.params.id, 'jogos');
    apagarImagem(j.sumula);
    db.prepare('UPDATE jogos SET sumula = NULL WHERE id = ?').run(j.id);
    res.json({ ok: true });
  });

  // ---------- banners (admin, maximo 5 por campeonato) ----------

  // RN-BA-03: a gestao de banners exige a flag da conta DONA ligada. Como a
  // posse ja validou o recurso contra req.conta.id, a dona e req.conta.id. O
  // master (mesmo em modo tenant) passa sempre: e o caminho de remover banners
  // de uma conta com o recurso revogado (RN-BA-04).
  const exigirBannersLiberados = (req) => {
    if (req.contaReal.papel === 'master') return;
    const conta = db.prepare('SELECT banners_liberados FROM contas WHERE id = ?').get(req.conta.id);
    if (!conta?.banners_liberados) {
      throw erroProibido('O recurso de banners nao esta habilitado para esta conta. Fale com o suporte.');
    }
  };

  rotas.post('/campeonatos/:id/banners', logado, (req, res) => {
    const c = campeonatoComAcesso(db, req.conta.id, req.params.id, 'dono');
    exigirBannersLiberados(req);
    const n = db.prepare('SELECT COUNT(*) AS n FROM banners WHERE campeonato_id = ?').get(c.id).n;
    if (n >= MAX_BANNERS) throw erroConflito(`Limite de ${MAX_BANNERS} banners por campeonato.`);
    const link = validarLink(req.body?.link);
    const caminho = salvarImagem(req.body?.imagem, 'banner');
    const info = db
      .prepare('INSERT INTO banners (campeonato_id, imagem, link, ordem) VALUES (?, ?, ?, ?)')
      .run(c.id, caminho, link, n);
    res.status(201).json(db.prepare('SELECT * FROM banners WHERE id = ?').get(Number(info.lastInsertRowid)));
  });

  rotas.patch('/banners/:id', logado, (req, res) => {
    const b = bannerDaConta(db, req.conta.id, req.params.id);
    exigirBannersLiberados(req);
    db.prepare('UPDATE banners SET link = ?, ordem = ?, ativo = ? WHERE id = ?').run(
      req.body?.link !== undefined ? validarLink(req.body.link) : b.link,
      req.body?.ordem !== undefined ? Number(req.body.ordem) : b.ordem,
      req.body?.ativo !== undefined ? (req.body.ativo ? 1 : 0) : b.ativo,
      b.id,
    );
    res.json(db.prepare('SELECT * FROM banners WHERE id = ?').get(b.id));
  });

  rotas.delete('/banners/:id', logado, (req, res) => {
    const b = bannerDaConta(db, req.conta.id, req.params.id);
    exigirBannersLiberados(req);
    apagarImagem(b.imagem);
    db.prepare('DELETE FROM banners WHERE id = ?').run(b.id);
    res.json({ ok: true });
  });

  // ---------- banner especial (banners globais do master, RN-BE) ----------

  const MAX_BANNERS_GLOBAIS = 3;

  rotas.get('/master/banners-globais', logado, mestre, (_req, res) => {
    res.json(db.prepare('SELECT * FROM banners_globais ORDER BY ordem, id').all());
  });

  rotas.post('/master/banners-globais', logado, mestre, (req, res) => {
    const n = db.prepare('SELECT COUNT(*) AS n FROM banners_globais').get().n;
    if (n >= MAX_BANNERS_GLOBAIS) throw erroConflito(`Limite de ${MAX_BANNERS_GLOBAIS} banners globais.`);
    const link = validarLink(req.body?.link);
    const caminho = salvarImagem(req.body?.imagem, 'banner-global');
    const info = db
      .prepare('INSERT INTO banners_globais (imagem, link, ordem) VALUES (?, ?, ?)')
      .run(caminho, link, n);
    res.status(201).json(db.prepare('SELECT * FROM banners_globais WHERE id = ?').get(Number(info.lastInsertRowid)));
  });

  rotas.patch('/master/banners-globais/:id', logado, mestre, (req, res) => {
    const b = db.prepare('SELECT * FROM banners_globais WHERE id = ?').get(Number(req.params.id));
    if (!b) throw erroNaoEncontrado('Banner global nao encontrado.');
    db.prepare('UPDATE banners_globais SET link = ?, ordem = ?, ativo = ? WHERE id = ?').run(
      req.body?.link !== undefined ? validarLink(req.body.link) : b.link,
      req.body?.ordem !== undefined ? Number(req.body.ordem) : b.ordem,
      req.body?.ativo !== undefined ? (req.body.ativo ? 1 : 0) : b.ativo,
      b.id,
    );
    res.json(db.prepare('SELECT * FROM banners_globais WHERE id = ?').get(b.id));
  });

  rotas.delete('/master/banners-globais/:id', logado, mestre, (req, res) => {
    const b = db.prepare('SELECT * FROM banners_globais WHERE id = ?').get(Number(req.params.id));
    if (!b) throw erroNaoEncontrado('Banner global nao encontrado.');
    apagarImagem(b.imagem);
    db.prepare('DELETE FROM banners_globais WHERE id = ?').run(b.id);
    res.json({ ok: true });
  });

  // ---------- colaboradores (compartilhar campeonato, RN-CO) ----------

  const MAX_COLABORADORES = 2;
  const rotuloColaborador = (col) => ({
    id: col.id,
    email: col.email,
    status: col.conta_id ? 'ativo' : 'pendente',
    pode_jogos: !!col.pode_jogos,
    pode_times: !!col.pode_times,
    pode_regras: !!col.pode_regras,
    pode_sorteio: !!col.pode_sorteio,
  });

  // Flags do corpo; a de Sorteio so existe na Pelada Epica (RN-CO-03).
  const lerFlagsColaborador = (b, ehPelada) => {
    if (!ehPelada && b.pode_sorteio) throw erroValidacao('A flag Sorteio so existe na Pelada Epica.');
    return {
      pode_jogos: b.pode_jogos ? 1 : 0,
      pode_times: b.pode_times ? 1 : 0,
      pode_regras: b.pode_regras ? 1 : 0,
      pode_sorteio: ehPelada && b.pode_sorteio ? 1 : 0,
    };
  };

  async function enviarEmailConvite(req, { para, campeonato, donoNome, temConta }) {
    const link = `${urlBase(req)}/admin`;
    const acao = temConta
      ? 'Entre no painel para acessar.'
      : 'Crie sua conta no Copa Manager com este mesmo e-mail (e confirme-o) para acessar.';
    await enviarEmail({
      para,
      assunto: `${donoNome} compartilhou um campeonato com você — Copa Manager`,
      texto:
        `Olá!\n\n${donoNome} adicionou você como colaborador(a) do campeonato "${campeonato.nome}" no Copa Manager.\n` +
        `${acao}\n${link}\n\nSe você não esperava este convite, pode ignorar este e-mail.`,
      html:
        `<p>Olá!</p><p><strong>${donoNome}</strong> adicionou você como colaborador(a) do campeonato ` +
        `<strong>${campeonato.nome}</strong> no Copa Manager.</p><p>${acao}</p>` +
        `<p><a href="${link}" style="background:#0b5c3f;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none">Abrir o Copa Manager</a></p>` +
        '<p style="color:#777">Se você não esperava este convite, pode ignorar este e-mail.</p>',
    });
  }

  rotas.get('/campeonatos/:id/colaboradores', logado, (req, res) => {
    const c = campeonatoComAcesso(db, req.conta.id, req.params.id, 'dono');
    const linhas = db.prepare('SELECT * FROM colaboradores WHERE campeonato_id = ? ORDER BY id').all(c.id);
    res.json(linhas.map(rotuloColaborador));
  });

  rotas.post('/campeonatos/:id/colaboradores', logado, limiteConvite.middleware, async (req, res) => {
    const c = campeonatoComAcesso(db, req.conta.id, req.params.id, 'dono');
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw erroValidacao('E-mail invalido.');
    // RN-CO-10: nao convidar o proprio dono nem repetir e-mail no campeonato.
    const dono = db.prepare('SELECT nome, email FROM contas WHERE id = ?').get(c.conta_id);
    if (email === dono.email.toLowerCase()) throw erroValidacao('Voce ja e o dono deste campeonato.');
    if (db.prepare('SELECT id FROM colaboradores WHERE campeonato_id = ? AND email = ?').get(c.id, email)) {
      throw erroConflito('Este e-mail ja foi convidado para este campeonato.');
    }
    // RN-CO-01: teto de 2 (pendentes contam).
    const n = db.prepare('SELECT COUNT(*) AS n FROM colaboradores WHERE campeonato_id = ?').get(c.id).n;
    if (n >= MAX_COLABORADORES) throw erroConflito(`Limite de ${MAX_COLABORADORES} colaboradores por campeonato.`);

    const ehPelada = obterEsporte(c.esporte)?.ranking === 'individual';
    const flags = lerFlagsColaborador(req.body ?? {}, ehPelada);
    // RN-CO-02: e-mail com conta vincula na hora; sem conta fica pendente.
    const contaExistente = db.prepare('SELECT id FROM contas WHERE email = ?').get(email);
    const info = db
      .prepare(
        `INSERT INTO colaboradores (campeonato_id, conta_id, email, pode_jogos, pode_times, pode_regras, pode_sorteio)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(c.id, contaExistente?.id ?? null, email, flags.pode_jogos, flags.pode_times, flags.pode_regras, flags.pode_sorteio);
    // RN-CO-11: falha de envio nao desfaz o convite.
    try {
      await enviarEmailConvite(req, { para: email, campeonato: c, donoNome: dono.nome, temConta: !!contaExistente });
    } catch (e) {
      console.error('[convite] falha ao enviar e-mail:', e.message);
    }
    res.status(201).json(rotuloColaborador(db.prepare('SELECT * FROM colaboradores WHERE id = ?').get(Number(info.lastInsertRowid))));
  });

  rotas.patch('/campeonatos/:id/colaboradores/:cid', logado, (req, res) => {
    const c = campeonatoComAcesso(db, req.conta.id, req.params.id, 'dono');
    const col = db.prepare('SELECT * FROM colaboradores WHERE id = ? AND campeonato_id = ?').get(Number(req.params.cid), c.id);
    if (!col) throw erroNaoEncontrado('Colaborador nao encontrado.');
    const ehPelada = obterEsporte(c.esporte)?.ranking === 'individual';
    const flags = lerFlagsColaborador(req.body ?? {}, ehPelada);
    db.prepare('UPDATE colaboradores SET pode_jogos = ?, pode_times = ?, pode_regras = ?, pode_sorteio = ? WHERE id = ?')
      .run(flags.pode_jogos, flags.pode_times, flags.pode_regras, flags.pode_sorteio, col.id);
    res.json(rotuloColaborador(db.prepare('SELECT * FROM colaboradores WHERE id = ?').get(col.id)));
  });

  rotas.delete('/campeonatos/:id/colaboradores/:cid', logado, (req, res) => {
    const c = campeonatoComAcesso(db, req.conta.id, req.params.id, 'dono');
    const col = db.prepare('SELECT * FROM colaboradores WHERE id = ? AND campeonato_id = ?').get(Number(req.params.cid), c.id);
    if (!col) throw erroNaoEncontrado('Colaborador nao encontrado.');
    db.prepare('DELETE FROM colaboradores WHERE id = ?').run(col.id);
    res.json({ ok: true });
  });

  // ---------- publico ----------

  rotas.get('/publico/:slug', (req, res) => {
    res.json(dadosPublicos(db, req.params.slug));
  });

  // ---------- seguir campeonatos (RN-SG) ----------

  // Estado do botao na pagina publica: funciona logado ou anonimo (RN-SG-06).
  rotas.get('/seguir/:slug/estado', talvezLogado, (req, res) => {
    res.json(estadoDeSeguir(db, req.conta?.id ?? null, req.params.slug));
  });

  // Seguir e deixar de seguir sao idempotentes (RN-SG-03) e exigem login: o
  // visitante anonimo e levado a autenticar antes (fluxo tratado no front, fase B).
  rotas.post('/seguir/:slug', limiteSeguir.middleware, logado, (req, res) => {
    res.json(seguir(db, req.conta.id, req.params.slug));
  });

  rotas.delete('/seguir/:slug', limiteSeguir.middleware, logado, (req, res) => {
    res.json(deixarDeSeguir(db, req.conta.id, req.params.slug));
  });

  // Secao "Seguindo" da home (RN-SG-04): copas que a conta segue (nao contam no limite).
  rotas.get('/seguindo', logado, (req, res) => {
    res.json(listarSeguidos(db, req.conta.id));
  });

  return rotas;
}
