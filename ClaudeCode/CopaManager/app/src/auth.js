// Contas, senhas (scrypt), confirmacao de e-mail e sessoes por cookie httpOnly.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { erroValidacao, erroNaoAutenticado, erroConflito } from './erros.js';

const DIAS_SESSAO = 30;
export const NOME_COOKIE = 'sessao';

// ---------- senha ----------

export function hashSenha(senha) {
  const sal = randomBytes(16).toString('hex');
  const hash = scryptSync(senha, sal, 64).toString('hex');
  return `${sal}:${hash}`;
}

export function conferirSenha(senha, senhaHash) {
  const [sal, hash] = senhaHash.split(':');
  const calculado = scryptSync(senha, sal, 64);
  const esperado = Buffer.from(hash, 'hex');
  return calculado.length === esperado.length && timingSafeEqual(calculado, esperado);
}

// ---------- contas ----------

export function registrarConta(db, { nome, email, senha, consentimento }) {
  nome = String(nome ?? '').trim();
  email = String(email ?? '').trim().toLowerCase();
  senha = String(senha ?? '');
  if (!nome) throw erroValidacao('Informe seu nome.');
  if (nome.length > 80) throw erroValidacao('Nome muito longo (limite: 80 caracteres).');
  if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw erroValidacao('E-mail invalido.');
  if (senha.length < 6) throw erroValidacao('A senha deve ter pelo menos 6 caracteres.');
  if (senha.length > 200) throw erroValidacao('A senha deve ter no maximo 200 caracteres.');
  // LGPD: o aceite e explicito e fica registrado com data (consentimento_em).
  if (consentimento !== true) throw erroValidacao('E preciso aceitar a Politica de Privacidade para criar a conta.');
  const existente = db.prepare('SELECT id FROM contas WHERE email = ?').get(email);
  if (existente) throw erroConflito('Ja existe uma conta com este e-mail.');
  const info = db
    .prepare('INSERT INTO contas (nome, email, senha_hash, email_verificado, consentimento_em) VALUES (?, ?, ?, 0, ?)')
    .run(nome, email, hashSenha(senha), new Date().toISOString());
  return { id: Number(info.lastInsertRowid), nome, email };
}

// Hash de sacrificio: quando o e-mail nao existe, conferimos a senha contra ele
// mesmo assim, para o tempo de resposta nao revelar quais e-mails tem conta.
const HASH_FANTASMA = hashSenha(randomBytes(16).toString('hex'));

export function autenticar(db, { email, senha }) {
  email = String(email ?? '').trim().toLowerCase();
  const conta = db.prepare('SELECT * FROM contas WHERE email = ?').get(email);
  // Contas criadas pelo Google nao tem senha (senha_hash sem ':'): conferimos
  // contra o hash fantasma para o tempo de resposta nao denunciar o caso.
  const hashReal = conta?.senha_hash?.includes(':') ? conta.senha_hash : HASH_FANTASMA;
  const senhaOk = conferirSenha(String(senha ?? '').slice(0, 200), hashReal);
  // Mensagem unica para email ou senha errados: nao revela quais e-mails existem.
  if (!conta || !senhaOk || !conta.senha_hash.includes(':')) {
    throw erroNaoAutenticado('E-mail ou senha incorretos.');
  }
  return { id: conta.id, nome: conta.nome, email: conta.email, email_verificado: conta.email_verificado };
}

// ---------- confirmacao de e-mail ----------

const HORAS_TOKEN_VERIFICACAO = 24;
const hashDeToken = (token) => createHash('sha256').update(String(token ?? '')).digest('hex');

// Gera um token novo (e invalida os pendentes). So o HASH vai para o banco.
export function criarTokenVerificacao(db, contaId) {
  db.prepare('DELETE FROM verificacoes_email WHERE conta_id = ? AND usado_em IS NULL').run(contaId);
  const token = randomBytes(32).toString('hex');
  const expira = new Date(Date.now() + HORAS_TOKEN_VERIFICACAO * 3600_000).toISOString();
  db.prepare('INSERT INTO verificacoes_email (conta_id, token_hash, expira_em) VALUES (?, ?, ?)').run(
    contaId,
    hashDeToken(token),
    expira,
  );
  return token;
}

export function confirmarEmail(db, token) {
  const v = db.prepare('SELECT * FROM verificacoes_email WHERE token_hash = ?').get(hashDeToken(token));
  if (!v || v.usado_em) {
    throw erroValidacao('Link de confirmacao invalido ou ja usado. Peca um novo e-mail de confirmacao.');
  }
  if (new Date(v.expira_em).getTime() < Date.now()) {
    throw erroValidacao('Este link expirou. Peca um novo e-mail de confirmacao.');
  }
  db.prepare('UPDATE verificacoes_email SET usado_em = ? WHERE id = ?').run(new Date().toISOString(), v.id);
  db.prepare('UPDATE contas SET email_verificado = 1 WHERE id = ?').run(v.conta_id);
  return db.prepare('SELECT id, nome, email FROM contas WHERE id = ?').get(v.conta_id);
}

// ---------- login com Google ----------

// Resolve o perfil vindo do Google em uma conta local: por google_id; senao
// vincula a conta existente do mesmo e-mail; senao cria uma conta nova (sem
// senha). Exigir e-mail verificado NO GOOGLE fecha a porta de alguem vincular
// a conta de terceiro usando um Gmail recem-criado com e-mail nao confirmado.
export function contaViaGoogle(db, { sub, email, nome, emailVerificado }) {
  email = String(email ?? '').trim().toLowerCase();
  if (!sub || !email) throw erroValidacao('Resposta do Google incompleta.');
  if (!emailVerificado) throw erroValidacao('O seu e-mail ainda nao esta verificado no Google.');

  let conta = db.prepare('SELECT * FROM contas WHERE google_id = ?').get(String(sub));
  if (!conta) {
    conta = db.prepare('SELECT * FROM contas WHERE email = ?').get(email);
    if (conta) {
      // Mesmo e-mail: vincula o SSO e considera o e-mail confirmado.
      db.prepare('UPDATE contas SET google_id = ?, email_verificado = 1 WHERE id = ?').run(String(sub), conta.id);
    } else {
      // LGPD: ao entrar pelo Google o aceite da politica esta no proprio botao
      // ("Ao continuar, voce concorda..."); registramos a data do primeiro acesso.
      const info = db
        .prepare(
          `INSERT INTO contas (nome, email, senha_hash, google_id, email_verificado, consentimento_em)
           VALUES (?, ?, 'google', ?, 1, ?)`,
        )
        .run(String(nome ?? email).trim().slice(0, 80) || email, email, String(sub), new Date().toISOString());
      conta = db.prepare('SELECT * FROM contas WHERE id = ?').get(info.lastInsertRowid);
    }
  }
  return { id: conta.id, nome: conta.nome, email: conta.email };
}

// ---------- sessoes ----------

export function criarSessao(db, contaId) {
  const token = randomBytes(32).toString('hex');
  const expira = new Date(Date.now() + DIAS_SESSAO * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sessoes (token, conta_id, expira_em) VALUES (?, ?, ?)').run(
    token,
    contaId,
    expira,
  );
  return token;
}

// Resolve a sessao em { real, efetiva }: `real` e quem fez login; `efetiva` e a
// conta cujo conteudo esta sendo gerenciado (tenant escolhido pelo master) ou a
// propria `real`. So contas master podem ter efetiva diferente da real.
export function contaDaSessao(db, token) {
  if (!token) return null;
  const sessao = db
    .prepare(
      `SELECT s.expira_em, s.conta_efetiva_id, c.id, c.nome, c.email, c.papel
       FROM sessoes s JOIN contas c ON c.id = s.conta_id
       WHERE s.token = ?`,
    )
    .get(token);
  if (!sessao) return null;
  if (new Date(sessao.expira_em).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessoes WHERE token = ?').run(token);
    return null;
  }
  const real = { id: sessao.id, nome: sessao.nome, email: sessao.email, papel: sessao.papel };
  let efetiva = real;
  let tenantEscolhido = false; // true mesmo quando o master escolheu a PROPRIA conta
  if (sessao.conta_efetiva_id && real.papel === 'master') {
    const alvo = db
      .prepare('SELECT id, nome, email, papel FROM contas WHERE id = ?')
      .get(sessao.conta_efetiva_id);
    if (alvo) {
      efetiva = alvo;
      tenantEscolhido = true;
    }
  }
  return { real, efetiva, tenantEscolhido };
}

export function encerrarSessao(db, token) {
  if (token) db.prepare('DELETE FROM sessoes WHERE token = ?').run(token);
}

// ---------- integracao Express ----------

export function lerCookie(req, nome) {
  const bruto = req.headers.cookie;
  if (!bruto) return null;
  for (const parte of bruto.split(';')) {
    const idx = parte.indexOf('=');
    if (idx < 0) continue;
    if (parte.slice(0, idx).trim() === nome) return decodeURIComponent(parte.slice(idx + 1).trim());
  }
  return null;
}

// Em producao (HTTPS), defina COOKIE_SEGURO=1 para o navegador nunca enviar a
// sessao por HTTP puro. Lido a cada chamada para os testes poderem alternar.
const flagsCookie = () =>
  `Path=/; HttpOnly; SameSite=Lax${process.env.COOKIE_SEGURO ? '; Secure' : ''}`;

export function cookieDeSessao(token) {
  const maxAge = DIAS_SESSAO * 24 * 60 * 60;
  return `${NOME_COOKIE}=${token}; ${flagsCookie()}; Max-Age=${maxAge}`;
}

export const cookieDeSaida = () => `${NOME_COOKIE}=; ${flagsCookie()}; Max-Age=0`;

// Middleware: exige sessao valida. req.conta = conta efetiva (tenant, quando o
// master escolheu uma); req.contaReal = quem realmente fez login.
export function exigirLogin(db) {
  return (req, _res, next) => {
    const sessao = contaDaSessao(db, lerCookie(req, NOME_COOKIE));
    if (!sessao) return next(erroNaoAutenticado());
    req.conta = sessao.efetiva;
    req.contaReal = sessao.real;
    req.tenantEscolhido = sessao.tenantEscolhido;
    next();
  };
}
