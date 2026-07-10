// Promove uma conta existente a master (administrador da plataforma).
// Uso: npm run master -- email@exemplo.com
import { prepararBanco } from '../db/db.js';

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error('Uso: npm run master -- email@exemplo.com');
  process.exit(1);
}

const db = prepararBanco();
const conta = db.prepare('SELECT id, nome, email, papel FROM contas WHERE email = ?').get(email);
if (!conta) {
  console.error(`Conta nao encontrada: ${email} (crie a conta primeiro pela tela de registro).`);
  process.exit(1);
}
if (conta.papel === 'master') {
  console.log(`${conta.nome} <${conta.email}> ja e master.`);
  process.exit(0);
}
db.prepare("UPDATE contas SET papel = 'master' WHERE id = ?").run(conta.id);
console.log(`Conta promovida a master: ${conta.nome} <${conta.email}>`);
