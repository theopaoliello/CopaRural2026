// Gerador minimo de .xlsx sem dependencias: um arquivo xlsx e um ZIP de XMLs
// (SpreadsheetML). Usa node:zlib para comprimir e monta o container ZIP a mao.
// Suporta multiplas abas, cabecalho formatado (fundo azul, negrito), larguras
// de coluna, filtro automatico e linha de cabecalho congelada.
import { deflateRawSync } from 'node:zlib';
import { indiceParaLetra } from './codigos.js';

// --- CRC32 (exigido pelo formato ZIP) ---
const TABELA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABELA_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// --- Container ZIP (metodo deflate) ---
function dosDataHora(d = new Date()) {
  const data = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const hora = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  return { data, hora };
}

export function criarZip(arquivos) {
  const { data, hora } = dosDataHora();
  const locais = [];
  const centrais = [];
  let offset = 0;

  for (const [nome, conteudo] of arquivos) {
    const nomeBuf = Buffer.from(nome, 'utf8');
    const bruto = Buffer.isBuffer(conteudo) ? conteudo : Buffer.from(conteudo, 'utf8');
    const comprimido = deflateRawSync(bruto);
    const crc = crc32(bruto);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // versao necessaria
    local.writeUInt16LE(0x0800, 6);      // flag: nomes em UTF-8
    local.writeUInt16LE(8, 8);           // metodo: deflate
    local.writeUInt16LE(hora, 10);
    local.writeUInt16LE(data, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comprimido.length, 18);
    local.writeUInt32LE(bruto.length, 22);
    local.writeUInt16LE(nomeBuf.length, 26);
    locais.push(local, nomeBuf, comprimido);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);        // criado por
    central.writeUInt16LE(20, 6);        // versao necessaria
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(hora, 12);
    central.writeUInt16LE(data, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comprimido.length, 20);
    central.writeUInt32LE(bruto.length, 24);
    central.writeUInt16LE(nomeBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrais.push(central, nomeBuf);

    offset += 30 + nomeBuf.length + comprimido.length;
  }

  const corpoCentral = Buffer.concat(centrais);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(arquivos.length, 8);
  fim.writeUInt16LE(arquivos.length, 10);
  fim.writeUInt32LE(corpoCentral.length, 12);
  fim.writeUInt32LE(offset, 16);
  return Buffer.concat([...locais, corpoCentral, fim]);
}

// --- SpreadsheetML ---
function xml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

function celula(ref, valor, estilo) {
  const s = estilo ? ` s="${estilo}"` : '';
  if (valor === null || valor === undefined || valor === '') return `<c r="${ref}"${s}/>`;
  if (typeof valor === 'number' && Number.isFinite(valor)) {
    return `<c r="${ref}"${s}><v>${valor}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${xml(valor)}</t></is></c>`;
}

// Largura de coluna estimada pelo conteudo (limitada a 8..55).
function larguras(colunas, linhas) {
  return colunas.map((col, i) => {
    let max = String(col.titulo).length;
    for (const linha of linhas) {
      const v = linha[i];
      if (v !== null && v !== undefined) max = Math.max(max, String(v).length);
    }
    return Math.min(55, Math.max(8, col.largura ?? max + 2));
  });
}

function sheetXml({ colunas, linhas }) {
  const ws = larguras(colunas, linhas);
  const cols = ws
    .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
    .join('');
  const cabecalho =
    `<row r="1">${colunas.map((c, i) => celula(indiceParaLetra(i) + '1', c.titulo, 1)).join('')}</row>`;
  const corpo = linhas
    .map((linha, r) => {
      const n = r + 2;
      return `<row r="${n}">${linha.map((v, i) => celula(indiceParaLetra(i) + n, v)).join('')}</row>`;
    })
    .join('');
  const fim = `${indiceParaLetra(colunas.length - 1)}${linhas.length + 1}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${cols}</cols>
<sheetData>${cabecalho}${corpo}</sheetData>
<autoFilter ref="A1:${fim}"/>
</worksheet>`;
}

// Cabecalho: fundo azul-marinho da marca, fonte branca em negrito.
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F3864"/></patternFill></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" applyFont="1" applyFill="1"/></cellXfs>
</styleSheet>`;

function nomeAba(nome, i) {
  const limpo = String(nome ?? `Plan${i + 1}`).replace(/[[\]:*?/\\]/g, ' ').trim();
  return limpo.slice(0, 31) || `Plan${i + 1}`;
}

// Gera o buffer .xlsx. abas: [{ nome, colunas: [{titulo, largura?}], linhas: [[...]] }]
export function gerarXlsx(abas) {
  if (!Array.isArray(abas) || abas.length === 0) throw new Error('gerarXlsx: informe ao menos uma aba.');

  const overrides = abas
    .map((_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join('');
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${overrides}
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const sheetsTag = abas
    .map((a, i) => `<sheet name="${xml(nomeAba(a.nome, i))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('');
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheetsTag}</sheets>
</workbook>`;

  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${abas.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}
<Relationship Id="rId${abas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const arquivos = [
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', rels],
    ['xl/workbook.xml', workbook],
    ['xl/_rels/workbook.xml.rels', wbRels],
    ['xl/styles.xml', STYLES_XML],
    ...abas.map((a, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(a)]),
  ];
  return criarZip(arquivos);
}
