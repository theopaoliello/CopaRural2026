// Backup do banco: grava data/backups/pelada-<data>.db e mantem os 14 mais
// recentes. Agende em cron/Task Scheduler: npm run backup
// VACUUM INTO gera uma copia integra e compactada, segura mesmo com WAL ativo.
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { abrirBanco, CAMINHO_PADRAO } from '../db/db.js';

const DIR_BACKUPS = join(dirname(CAMINHO_PADRAO), 'backups');
const MANTER = 14;

mkdirSync(DIR_BACKUPS, { recursive: true });
const carimbo = new Date().toISOString().slice(0, 16).replace(/:/g, '-'); // 2026-07-10T09-30
const destino = join(DIR_BACKUPS, `pelada-${carimbo}.db`);

const db = abrirBanco();
db.prepare('VACUUM INTO ?').run(destino);
db.close();
console.log(`Backup gravado: ${destino}`);

const antigos = readdirSync(DIR_BACKUPS)
  .filter((a) => a.startsWith('pelada-') && a.endsWith('.db'))
  .sort();
for (const a of antigos.slice(0, Math.max(0, antigos.length - MANTER))) {
  unlinkSync(join(DIR_BACKUPS, a));
  console.log(`Backup antigo removido: ${a}`);
}
