// Testes de seguranca: rate limit, validacao de link/cor, tetos de campo e cookie.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { prepararBanco } from '../db/db.js';
import { montarRotas } from '../routes/api.js';
import { cookieDeSessao, cookieDeSaida } from '../src/auth.js';
import { criarLimitador } from '../src/ratelimit.js';
import { configurarTransporte } from '../src/email.js';

const servidores = [];
after(() => servidores.forEach((s) => s.close()));

// Captura os e-mails de verificacao (nenhuma rede nos testes).
const emails = [];
configurarTransporte(async (m) => { emails.push(m); });
const tokenDoUltimoEmail = (para) =>
  [...emails].reverse().find((e) => e.para === para)?.texto.match(/token=([0-9a-f]+)/)?.[1];

// Registro completo: cria a conta e confirma o e-mail (abre a sessao).
async function registrarEntrar(c, dados) {
  const reg = await c('POST', '/api/auth/registrar', { ...dados, consentimento: true });
  assert.equal(reg.status, 201, JSON.stringify(reg.corpo));
  const conf = await c('POST', '/api/auth/confirmar-email', { token: tokenDoUltimoEmail(dados.email) });
  assert.equal(conf.status, 200, JSON.stringify(conf.corpo));
}

// Sobe um app isolado (banco e limitadores proprios) e devolve um cliente HTTP.
async function subirApp(limites) {
  const db = prepararBanco(':memory:');
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', montarRotas(db, { limites }));
  app.use((err, _req, res, _next) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ erro: err.name ?? 'Erro', mensagem: err.message });
  });
  const servidor = app.listen(0);
  servidores.push(servidor);
  await new Promise((r) => servidor.on('listening', r));
  const base = `http://localhost:${servidor.address().port}`;
  let cookie = '';
  return async (metodo, caminho, corpo) => {
    const resp = await fetch(base + caminho, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    const setCookie = resp.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: resp.status, corpo: await resp.json().catch(() => ({})) };
  };
}

const PNG_FAKE = 'data:image/png;base64,aGVsbG8='; // conteudo qualquer: o teste e da rota

// ---------- rate limit ----------

test('limitador: janela desliza e chaves sao independentes', () => {
  const { tentar } = criarLimitador({ max: 2, janelaMs: 1000 });
  assert.equal(tentar('a', 0), true);
  assert.equal(tentar('a', 100), true);
  assert.equal(tentar('a', 200), false); // estourou
  assert.equal(tentar('b', 200), true); // outra chave nao e afetada
  assert.equal(tentar('a', 1500), true); // janela deslizou
});

test('login: bloqueia forca bruta com 429 apos o limite', async () => {
  const c = await subirApp({ login: { max: 3, janelaMs: 60_000 }, registro: { max: 100 }, confirmacao: { max: 100 } });
  await registrarEntrar(c, { nome: 'Vito', email: 'vito@teste.com', senha: 'segredo1' });
  for (let i = 0; i < 3; i++) {
    const r = await c('POST', '/api/auth/login', { email: 'vito@teste.com', senha: 'errada!' });
    assert.equal(r.status, 401);
  }
  // A partir daqui nem a senha correta passa: o IP esta bloqueado na janela.
  const bloqueado = await c('POST', '/api/auth/login', { email: 'vito@teste.com', senha: 'segredo1' });
  assert.equal(bloqueado.status, 429);
});

test('registro: bloqueia criacao de contas em massa com 429', async () => {
  const c = await subirApp({ login: { max: 100 }, registro: { max: 2, janelaMs: 60_000 } });
  const dados = (nome, email) => ({ nome, email, senha: 'segredo1', consentimento: true });
  assert.equal((await c('POST', '/api/auth/registrar', dados('A', 'a@t.com'))).status, 201);
  assert.equal((await c('POST', '/api/auth/registrar', dados('B', 'b@t.com'))).status, 201);
  assert.equal((await c('POST', '/api/auth/registrar', dados('C', 'c@t.com'))).status, 429);
});

// ---------- validacoes contra conteudo malicioso ----------

const FOLGADO = { login: { max: 1000 }, registro: { max: 1000 }, confirmacao: { max: 1000 } };

async function clienteComCampeonato() {
  const c = await subirApp(FOLGADO);
  await registrarEntrar(c, { nome: 'Org', email: 'org@teste.com', senha: 'segredo1' });
  const criado = await c('POST', '/api/campeonatos', {
    nome: 'Copa Teste', formato: 'pontos', sortear: false,
    times: [{ nome: 'Leoes' }, { nome: 'Tigres' }],
  });
  assert.equal(criado.status, 201);
  return { c, campeonato: criado.corpo };
}

test('banner: recusa link javascript: e aceita https', async () => {
  const { c, campeonato } = await clienteComCampeonato();
  const ruim = await c('POST', `/api/campeonatos/${campeonato.id}/banners`, {
    imagem: PNG_FAKE, link: 'javascript:alert(document.cookie)',
  });
  assert.equal(ruim.status, 400);
  const bom = await c('POST', `/api/campeonatos/${campeonato.id}/banners`, {
    imagem: PNG_FAKE, link: 'https://patrocinador.com.br/promo',
  });
  assert.equal(bom.status, 201);
  // PATCH tambem valida
  const patch = await c('PATCH', `/api/banners/${bom.corpo.id}`, { link: 'javascript:1' });
  assert.equal(patch.status, 400);
});

test('cor do tema: apenas hexadecimal (vai para contexto CSS publico)', async () => {
  const { c, campeonato } = await clienteComCampeonato();
  const ruim = await c('PATCH', `/api/campeonatos/${campeonato.id}`, {
    cor_tema: 'red;background:url(https://mal.com/x)',
  });
  assert.equal(ruim.status, 400);
  const bom = await c('PATCH', `/api/campeonatos/${campeonato.id}`, { cor_tema: '#AaBbCc' });
  assert.equal(bom.status, 200);
});

test('tetos de tamanho: nome de conta, senha e nome de campeonato', async () => {
  const c = await subirApp(FOLGADO);
  const nomeGigante = 'x'.repeat(500);
  assert.equal(
    (await c('POST', '/api/auth/registrar', { nome: nomeGigante, email: 'g@t.com', senha: 'segredo1', consentimento: true })).status,
    400,
  );
  assert.equal(
    (await c('POST', '/api/auth/registrar', { nome: 'Ok', email: 'g@t.com', senha: 'x'.repeat(300), consentimento: true })).status,
    400,
  );
  await registrarEntrar(c, { nome: 'Ok', email: 'g@t.com', senha: 'segredo1' });
  assert.equal(
    (await c('POST', '/api/campeonatos', { nome: nomeGigante, formato: 'pontos', times: ['A', 'B'] })).status,
    400,
  );
});

// ---------- cookie ----------

test('cookie de sessao ganha Secure quando COOKIE_SEGURO esta definido', () => {
  delete process.env.COOKIE_SEGURO;
  assert.ok(!cookieDeSessao('tok').includes('Secure'));
  assert.ok(cookieDeSessao('tok').includes('HttpOnly'));
  process.env.COOKIE_SEGURO = '1';
  try {
    assert.ok(cookieDeSessao('tok').includes('; Secure'));
    assert.ok(cookieDeSaida().includes('; Secure'));
  } finally {
    delete process.env.COOKIE_SEGURO;
  }
});
