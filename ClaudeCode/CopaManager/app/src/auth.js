// Contas, senhas (scrypt) e sessoes por cookie httpOnly.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
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

export function registrarConta(db, { nome, email, senha }) {
  nome = String(nome ?? '').trim();
  email = String(email ?? '').trim().toLowerCase();
  senha = String(senha ?? '');
  if (!nome) throw erroValidacao('Informe seu nome.');
  if (nome.length > 80) throw erroValidacao('Nome muito longo (limite: 80 caracteres).');
  if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw erroValidacao('E-mail invalido.');
  if (senha.length < 6) throw erroValidacao('A senha deve ter pelo menos 6 caracteres.');
  if (senha.length > 200) throw erroValidacao('A senha deve ter no maximo 200 caracteres.');
  const existente = db.prepare('SELECT id FROM contas WHERE email = ?').get(email);
  if (existente) throw erroConflito('Ja existe uma conta com este e-mail.');
  const info = db
    .prepare('INSERT INTO contas (nome, email, senha_hash) VALUES (?, ?, ?)')
    .run(nome, email, hashSenha(senha));
  return { id: Number(info.lastInsertRowid), nome, email };
}

// Hash de sacrificio: quando o e-mail nao existe, conferimos a senha contra ele
// mesmo assim, para o tempo de resposta nao revelar quais e-mails tem conta.
const HASH_FANTASMA = hashSenha(randomBytes(16).toString('hex'));

export function autenticar(db, { email, senha }) {
  email = String(email ?? '').trim().toLowerCase();
  const conta = db.prepare('SELECT * FROM contas WHERE email = ?').get(email);
  const senhaOk = conferirSenha(String(senha ?? '').slice(0, 200), conta?.senha_hash ?? HASH_FANTASMA);
  // Mensagem unica para email ou senha errados: nao revela quais e-mails existem.
  if (!conta || !senhaOk) throw erroNaoAutenticado('E-mail ou senha incorretos.');
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
