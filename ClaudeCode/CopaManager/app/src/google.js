// Login com Google: fluxo Authorization Code server-side, sem bibliotecas.
// Requer GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no ambiente; sem eles o
// botao nem aparece no front (GET /api/auth/config).
import { erroValidacao } from './erros.js';

const URL_AUTORIZACAO = 'https://accounts.google.com/o/oauth2/v2/auth';
const URL_TOKEN = 'https://oauth2.googleapis.com/token';

export const googleConfigurado = () =>
  !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

export function urlDeAutorizacao({ redirectUri, state }) {
  const q = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  return `${URL_AUTORIZACAO}?${q}`;
}

// Troca o code pelo id_token e devolve o perfil. A assinatura do JWT nao e
// validada de proposito: a resposta veio direto do Google via TLS nesta mesma
// chamada, entao nao ha o que falsificar (padrao para o fluxo server-side).
export async function perfilDoCodigo({ code, redirectUri }) {
  const resp = await fetch(URL_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!resp.ok) {
    console.error('[google] troca de codigo falhou:', resp.status, await resp.text().catch(() => ''));
    throw erroValidacao('Nao foi possivel entrar com o Google. Tente novamente.');
  }
  const { id_token } = await resp.json();
  if (!id_token) throw erroValidacao('Resposta do Google incompleta.');
  const payload = JSON.parse(Buffer.from(id_token.split('.')[1], 'base64url').toString('utf8'));
  return {
    sub: payload.sub,
    email: payload.email,
    nome: payload.name,
    emailVerificado: payload.email_verified === true || payload.email_verified === 'true',
  };
}
