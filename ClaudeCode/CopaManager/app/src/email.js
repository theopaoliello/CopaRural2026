// Envio de e-mails transacionais via Brevo (API HTTP, sem dependencia npm).
// Sem BREVO_API_KEY configurada, roda em "modo log": imprime o conteudo no
// console do servidor — util em desenvolvimento (o link de confirmacao sai la).
const API_BREVO = 'https://api.brevo.com/v3/smtp/email';

// Transporte injetavel: os testes capturam as mensagens sem rede.
let transporteCustom = null;
export function configurarTransporte(fn) {
  transporteCustom = fn;
}

export async function enviarEmail({ para, assunto, texto, html }) {
  if (transporteCustom) return transporteCustom({ para, assunto, texto, html });

  const chave = process.env.BREVO_API_KEY;
  if (!chave) {
    console.log(`[email modo-log] para: ${para} | assunto: ${assunto}\n${texto}`);
    return { modo: 'log' };
  }

  const remetente = process.env.EMAIL_REMETENTE ?? 'nao-responda@copamanager.com.br';
  const resp = await fetch(API_BREVO, {
    method: 'POST',
    headers: { 'api-key': chave, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      sender: { name: 'Copa Manager', email: remetente },
      to: [{ email: para }],
      subject: assunto,
      textContent: texto,
      htmlContent: html,
    }),
  });
  if (!resp.ok) {
    // Detalhes so no log do servidor; quem chamou decide a mensagem ao cliente.
    console.error('[email] falha no envio via Brevo:', resp.status, await resp.text().catch(() => ''));
    throw new Error('Falha no envio do e-mail.');
  }
  return { modo: 'brevo' };
}
