import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { criarZip, gerarXlsx } from '../src/xlsx.js';

// Le de volta os arquivos de um zip gerado (parser minimo dos headers locais).
function lerZip(buf) {
  const arquivos = new Map();
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const compSize = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    const nome = buf.slice(p + 30, p + 30 + nameLen).toString('utf8');
    const dados = buf.slice(p + 30 + nameLen + extraLen, p + 30 + nameLen + extraLen + compSize);
    arquivos.set(nome, inflateRawSync(dados).toString('utf8'));
    p += 30 + nameLen + extraLen + compSize;
  }
  return arquivos;
}

test('criarZip: assinaturas e round-trip do conteudo', () => {
  const zip = criarZip([['a.txt', 'ola'], ['dir/b.txt', 'mundo']]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);          // local header
  assert.ok(zip.includes(Buffer.from('PK\x05\x06', 'binary'))); // EOCD
  const lidos = lerZip(zip);
  assert.equal(lidos.get('a.txt'), 'ola');
  assert.equal(lidos.get('dir/b.txt'), 'mundo');
});

test('gerarXlsx: estrutura OOXML completa e dados na planilha', () => {
  const buf = gerarXlsx([{
    nome: 'Teste',
    colunas: [{ titulo: 'Código' }, { titulo: 'Qtd' }],
    linhas: [['NV-2600001-A', 3], ['NV-2600001-B', null]],
  }]);
  const zip = lerZip(buf);
  for (const obrigatorio of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) {
    assert.ok(zip.has(obrigatorio), `faltou ${obrigatorio}`);
  }
  const sheet = zip.get('xl/worksheets/sheet1.xml');
  assert.match(sheet, /NV-2600001-A/);
  assert.match(sheet, /<c r="B2"><v>3<\/v><\/c>/);        // numero como numero
  assert.match(sheet, /C&#243;digo|Código/);              // cabecalho
  assert.match(sheet, /autoFilter/);
  assert.match(zip.get('xl/workbook.xml'), /name="Teste"/);
});

test('gerarXlsx: escapa XML e suporta multiplas abas', () => {
  const buf = gerarXlsx([
    { nome: 'A & B', colunas: [{ titulo: '<x>' }], linhas: [['a<b>&"c"']] },
    { nome: 'Outra', colunas: [{ titulo: 'Y' }], linhas: [] },
  ]);
  const zip = lerZip(buf);
  assert.ok(zip.has('xl/worksheets/sheet2.xml'));
  const sheet = zip.get('xl/worksheets/sheet1.xml');
  assert.match(sheet, /a&lt;b&gt;&amp;&quot;c&quot;/);
  assert.doesNotMatch(sheet, /<is><t[^>]*>a<b>/);
  assert.match(zip.get('xl/workbook.xml'), /A &amp; B/);
});

test('gerarXlsx: nome de aba invalido e sanitizado e limitado a 31 chars', () => {
  const nome = 'Relatório: [muito/longo?*] ' + 'x'.repeat(40);
  const buf = gerarXlsx([{ nome, colunas: [{ titulo: 'A' }], linhas: [] }]);
  const wb = lerZip(buf).get('xl/workbook.xml');
  const m = /name="([^"]+)"/.exec(wb);
  assert.ok(m[1].length <= 31);
  assert.doesNotMatch(m[1], /[[\]:*?/\\]/);
});
