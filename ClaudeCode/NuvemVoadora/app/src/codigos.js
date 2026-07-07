// Geracao e leitura do codigo da parte/OS.
// Formato (EF secao 4): NV-<AA><SEQ5>[-<LETRA>]
//   OS    -> "NV-2600042"      (AA=ano 2 digitos, SEQ=5 digitos)
//   Parte -> "NV-2600042-A"    (letra sequencial da parte na OS)

import { randomBytes } from 'node:crypto';

const PREFIXO = 'NV';

function anoDoisDigitos(ano) {
  return String(ano % 100).padStart(2, '0');
}

// Codigo da OS a partir do ano e da sequencia daquele ano.
export function codigoOS(ano, seq) {
  if (!Number.isInteger(seq) || seq < 1 || seq > 99999) {
    throw new RangeError(`seq da OS fora do intervalo 1..99999: ${seq}`);
  }
  return `${PREFIXO}-${anoDoisDigitos(ano)}${String(seq).padStart(5, '0')}`;
}

// Indice 0-based -> letra bijetiva base-26: 0=A, 25=Z, 26=AA...
export function indiceParaLetra(i) {
  if (!Number.isInteger(i) || i < 0) throw new RangeError(`indice invalido: ${i}`);
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Gera as N letras das partes de uma OS: ['A','B','C',...].
export function gerarLetras(n) {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`n de partes invalido: ${n}`);
  return Array.from({ length: n }, (_, i) => indiceParaLetra(i));
}

// Codigo da parte a partir do codigo da OS + letra.
export function codigoParte(codOS, letra) {
  return `${codOS}-${letra}`;
}

// Codigo de acesso da loja ao portal (formato LJ-<10 hex>). Aleatorio e nao
// sequencial de proposito: funciona como credencial simples do MVP.
export function tokenLoja() {
  return 'LJ-' + randomBytes(5).toString('hex').toUpperCase();
}

// Interpreta um codigo lido (de OS ou de parte). Retorna null se nao casar.
export function parseCodigo(codigo) {
  if (typeof codigo !== 'string') return null;
  const m = /^NV-(\d{2})(\d{5})(?:-([A-Z]+))?$/.exec(codigo.trim().toUpperCase());
  if (!m) return null;
  const [, aa, seq, letra] = m;
  return {
    codigoOS: `${PREFIXO}-${aa}${seq}`,
    letra: letra ?? null,
    ano: 2000 + Number(aa),
    seq: Number(seq),
    ehParte: Boolean(letra),
  };
}
