// Upload de imagens (escudo, foto do time, sumula, banner, logo) via data URL.
// As imagens chegam em base64 no JSON e sao gravadas em /uploads no disco.
import { randomBytes } from 'node:crypto';
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { erroValidacao } from './erros.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DIR_UPLOADS = join(__dirname, '..', 'uploads');

const MAX_BYTES = 3 * 1024 * 1024; // 3 MB por imagem
const EXTENSOES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

// Grava um data URL de imagem e devolve o caminho publico (/uploads/arquivo.ext).
export function salvarImagem(dataUrl, prefixo = 'img', dir = DIR_UPLOADS) {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl ?? ''));
  if (!m) throw erroValidacao('Imagem invalida. Envie PNG, JPG ou WEBP.');
  const buffer = Buffer.from(m[2], 'base64');
  if (!buffer.length) throw erroValidacao('Imagem vazia.');
  if (buffer.length > MAX_BYTES) throw erroValidacao('Imagem muito grande (limite: 3 MB).');
  mkdirSync(dir, { recursive: true });
  const nome = `${prefixo}-${randomBytes(8).toString('hex')}.${EXTENSOES[m[1]]}`;
  writeFileSync(join(dir, nome), buffer);
  return `/uploads/${nome}`;
}

// Remove uma imagem previamente salva (melhor esforco; ignora se nao existir).
export function apagarImagem(caminhoPublico, dir = DIR_UPLOADS) {
  if (!caminhoPublico) return;
  const arquivo = join(dir, basename(String(caminhoPublico)));
  try {
    if (existsSync(arquivo)) unlinkSync(arquivo);
  } catch {
    // best-effort: um arquivo orfao nao quebra o sistema
  }
}
