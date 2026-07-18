// Rotas da API: autenticacao, administracao (sempre validando posse) e publica.
import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import {
  registrarConta, autenticar, criarSessao, encerrarSessao, hashSenha, conferirSenha,
  criarTokenVerificacao, confirmarEmail, contaViaGoogle,
  criarTokenRecuperacao, redefinirSenha,
  lerCookie, cookieDeSessao, cookieDeSaida, exigirLogin, NOME_COOKIE,
} from '../src/auth.js';
import { enviarEmail } from '../src/email.js';
import { googleConfigurado, urlDeAutorizacao, perfilDoCodigo } from '../src/google.js';
import {
  campeonatoDaConta, timeDaConta, jogadorDaConta, jogoDaConta, bannerDaConta,
} from '../src/posse.js';
import {
  criarCampeonato, classificacaoDoCampeonato, gerarMataDoCampeonato, criarJogoAvulso,
  slugificar, slugDisponivel, textoLimitado, validarCorTema, validarPremiacaoRebaixamento,
  vagasDoCampeonato, MAX_NOME_JOGADOR, MAX_NOME_TIME,
} from '../src/campeonatos.js';
import {
  planoDeVagas, sugerirCombinacao, textoSugestao, resumoDoPlano, tamanhosPrevistos,
} from '../src/melhores.js';
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
        `SELECT c.id, c.nome, c.email, c.papel, c.criado_em,
           c.tipo, c.max_campeonatos, c.max_times, c.max_jogadores_time,
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
        `SELECT id, nome, email, papel, tipo, max_campeonatos, max_times, max_jogadores_time
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

    db.prepare(
      `UPDATE contas SET nome = ?, email = ?, papel = ?, tipo = ?,
         max_campeonatos = ?, max_times = ?, max_jogadores_time = ? WHERE id = ?`,
    ).run(nome, email, papel, tipo, maxCampeonatos, maxTimes, maxJogadoresTime, alvo.id);
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
      banners: db.prepare('SELECT * FROM banners WHERE campeonato_id = ? ORDER BY ordem, id').all(c.id),
      classificacao,
      vagas: vagasDoCampeonato(db, c, classificacao),
    });
  });

  rotas.patch('/campeonatos/:id', logado, (req, res) => {
    const c = campeonatoDaConta(db, req.conta.id, req.params.id);
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
       premiacao = ?, premia_artilheiro = ?, rebaixamento_modo = ?, rebaixamento_qtd = ? WHERE id = ?`,
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

  // ---------- Pelada Epica: jogos avulsos e jogadores do campeonato ----------

  rotas.post('/campeonatos/:id/jogos', logado, (req, res) => {
    const c = campeonatoDaConta(db, req.conta.id, req.params.id);
    res.status(201).json(criarJogoAvulso(db, c, req.body ?? {}));
  });

  // ---------- Pelada Epica: sorteio de times (EF secao 7) ----------

  function campeonatoPelada(req) {
    const c = campeonatoDaConta(db, req.conta.id, req.params.id);
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
    const j = jogoDaConta(db, req.conta.id, req.params.id);
    const c = db.prepare('SELECT esporte FROM campeonatos WHERE id = ?').get(j.campeonato_id);
    if (obterEsporte(c?.esporte)?.ranking !== 'individual') {
      throw erroValidacao('A tabela deste campeonato e gerada automaticamente e nao permite apagar jogos.');
    }
    db.prepare('DELETE FROM jogos WHERE id = ?').run(j.id); // eventos/escalacoes caem em cascata
    res.json({ ok: true });
  });

  rotas.post('/campeonatos/:id/jogadores', logado, (req, res) => {
    const c = campeonatoDaConta(db, req.conta.id, req.params.id);
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
    const t = timeDaConta(db, req.conta.id, req.params.id);
    const nome = req.body?.nome !== undefined ? textoLimitado(req.body.nome, MAX_NOME_TIME, 'Nome do time') : t.nome;
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

  // Limite de jogadores por time (RN-GC-06/08): sempre pela conta DONA do
  // campeonato do time (nao por quem esta operando).
  const conferirJogadoresDoTime = (time, adicionando) => {
    const donaId = db.prepare('SELECT conta_id FROM campeonatos WHERE id = ?').get(time.campeonato_id).conta_id;
    const existentes = db.prepare('SELECT COUNT(*) AS n FROM jogadores WHERE time_id = ?').get(time.id).n;
    conferirLimiteJogadoresTime(db, donaId, existentes + adicionando);
  };

  rotas.post('/times/:id/jogadores', logado, (req, res) => {
    const t = timeDaConta(db, req.conta.id, req.params.id);
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
    const t = timeDaConta(db, req.conta.id, req.params.id);
    const texto = String(req.body?.texto ?? '');
    if (texto.length > 20_000) throw erroValidacao('Texto do lote muito longo (limite: 20 mil caracteres).');
    // Tudo ou nada (RN-GC-06): valida o total resultante antes de inserir.
    conferirJogadoresDoTime(t, parsearLoteJogadores(texto).length);
    res.status(201).json(inserirLoteJogadores(db, t.id, texto));
  });

  rotas.patch('/jogadores/:id', logado, (req, res) => {
    const j = jogadorDaConta(db, req.conta.id, req.params.id);
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
    const j = jogadorDaConta(db, req.conta.id, req.params.id);
    // Eventos historicos ficam com jogador nulo (gols "sem autor"), nao somem.
    db.prepare('DELETE FROM jogadores WHERE id = ?').run(j.id);
    res.json({ ok: true });
  });

  // ---------- jogos e resultados (admin) ----------

  rotas.patch('/jogos/:id/agenda', logado, (req, res) => {
    const j = jogoDaConta(db, req.conta.id, req.params.id);
    db.prepare('UPDATE jogos SET data = ?, local = ?, obs = ? WHERE id = ?').run(
      req.body?.data !== undefined ? textoLimitado(req.body.data, 40, 'Data') : j.data,
      req.body?.local !== undefined ? textoLimitado(req.body.local, 200, 'Local') : j.local,
      req.body?.obs !== undefined ? textoLimitado(req.body.obs, 1000, 'Observacoes') : j.obs,
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
    const link = validarLink(req.body?.link);
    const caminho = salvarImagem(req.body?.imagem, 'banner');
    const info = db
      .prepare('INSERT INTO banners (campeonato_id, imagem, link, ordem) VALUES (?, ?, ?, ?)')
      .run(c.id, caminho, link, n);
    res.status(201).json(db.prepare('SELECT * FROM banners WHERE id = ?').get(Number(info.lastInsertRowid)));
  });

  rotas.patch('/banners/:id', logado, (req, res) => {
    const b = bannerDaConta(db, req.conta.id, req.params.id);
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
