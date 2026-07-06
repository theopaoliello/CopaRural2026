// Bootstrap do servidor local do HUB Nuvem Voadora.
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { prepararBanco } from './db/db.js';
import { seedLojas } from './db/seed.js';
import { montarRotas } from './routes/api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORTA = process.env.PORTA ? Number(process.env.PORTA) : 3000;

const db = prepararBanco();
const criadas = seedLojas(db);
if (criadas) console.log(`Seed: ${criadas} lojas de exemplo inseridas.`);

const app = express();
app.use(express.json());
app.use('/api', montarRotas(db));
app.use(express.static(join(__dirname, 'public')));

// Middleware de erro: traduz erros de dominio em status HTTP.
app.use((err, req, res, _next) => {
  const status = err.statusCode ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ erro: err.name ?? 'Erro', mensagem: err.message });
});

export function iniciar(porta = PORTA) {
  return app.listen(porta, () => {
    console.log(`Nuvem Voadora HUB rodando em http://localhost:${porta}`);
  });
}

// Sobe o servidor quando executado diretamente (node server.js).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  iniciar();
}

export { app, db };
