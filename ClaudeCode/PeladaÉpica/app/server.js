// Bootstrap do servidor Pelada Epica.
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { prepararBanco } from './db/db.js';
import { montarRotas } from './routes/api.js';
import { DIR_UPLOADS } from './src/uploads.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORTA = process.env.PORTA ? Number(process.env.PORTA) : 3000;

const db = prepararBanco();

const app = express();
app.disable('x-powered-by');

// Cabecalhos de seguranca basicos.
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
  });
  next();
});

// Limite maior de JSON por causa dos uploads de imagem em base64 (ate ~3 MB).
app.use(express.json({ limit: '5mb' }));
app.use('/api', montarRotas(db));
app.use('/uploads', express.static(DIR_UPLOADS, { maxAge: '7d' }));
app.use(express.static(join(__dirname, 'public')));

// Pagina publica do campeonato: /c/qualquer-slug -> c.html (o JS busca os dados).
app.get('/c/:slug', (_req, res) => res.sendFile(join(__dirname, 'public', 'c.html')));
app.get('/admin', (_req, res) => res.sendFile(join(__dirname, 'public', 'admin.html')));

// Middleware de erro: traduz erros de dominio em status HTTP.
// Erros 5xx NAO vazam detalhes internos ao cliente — so no log do servidor.
app.use((err, req, res, _next) => {
  const status = err.statusCode ?? (err.type === 'entity.too.large' ? 413 : 500);
  if (status >= 500) {
    console.error(err);
    return res.status(status).json({ erro: 'ErroInterno', mensagem: 'Erro interno no servidor. Tente novamente.' });
  }
  res.status(status).json({ erro: err.name ?? 'Erro', mensagem: err.message });
});

export function iniciar(porta = PORTA) {
  return app.listen(porta, () => {
    console.log(`Pelada Epica rodando em http://localhost:${porta}`);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  iniciar();
}

export { app, db };
