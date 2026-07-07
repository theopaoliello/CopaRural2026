import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abrirBanco, migrar } from '../db/db.js';
import { criarLoja } from '../src/lojas.js';
import { criarOS, despacharOS, encerrarOS } from '../src/os.js';
import { registrarRecebimento } from '../src/recebimento.js';
import { iniciarSeparacao, scanConsolidacao, finalizarSeparacao } from '../src/separacao.js';
import { rastrearPedido } from '../src/rastreio.js';
import { OS } from '../src/estados.js';

function cenario() {
  const db = migrar(abrirBanco(':memory:'));
  const l1 = criarLoja(db, { nome: 'Loja A', janela_dias: 15 });
  const l2 = criarLoja(db, { nome: 'Loja B', janela_dias: 7 });
  const os = criarOS(db, {
    cliente: { nome: 'Maria Silva', uf: 'MG', cep: '30000-000' },
    partes: [
      { loja_id: l1.id, itens: [{ descricao: 'Carta X', quantidade: 1 }] },
      { loja_id: l2.id, itens: [{ descricao: 'Carta Y', quantidade: 2 }] },
    ],
  });
  return { db, os };
}

// Leva a OS ate PRONTA_DESPACHO pelo fluxo real (recebe tudo, separa, fecha).
function ateProntaDespacho(db, os) {
  for (const p of os.partes) registrarRecebimento(db, p.codigo_barras, 'op1');
  iniciarSeparacao(db, os.codigo);
  for (const p of os.partes) scanConsolidacao(db, os.codigo, p.codigo_barras, 'op1');
  return finalizarSeparacao(db, os.codigo);
}

test('rastreio de OS pendente: etapa 2, progresso 0/2', () => {
  const { db, os } = cenario();
  const r = rastrearPedido(db, os.codigo);
  assert.equal(r.codigo, os.codigo);
  assert.equal(r.etapa, 2);
  assert.equal(r.total_partes, 2);
  assert.equal(r.partes_no_hub, 0);
  assert.equal(r.atrasado, false);
  assert.equal(r.partes[0].situacao, 'A caminho do HUB');
});

test('rastreio nao vaza dados sensiveis (nome completo, CEP, escaninho)', () => {
  const { db, os } = cenario();
  const r = rastrearPedido(db, os.codigo);
  assert.equal(r.cliente, 'Maria'); // so o primeiro nome
  const json = JSON.stringify(r);
  assert.ok(!json.includes('Maria Silva'));
  assert.ok(!json.includes('30000-000'));
  assert.equal(r.cliente_cep, undefined);
  assert.equal(r.escaninho, undefined);
});

test('rastreio aceita codigo de parte e resolve a OS', () => {
  const { db, os } = cenario();
  const r = rastrearPedido(db, os.partes[0].codigo_barras);
  assert.equal(r.codigo, os.codigo);
});

test('rastreio avanca para etapa 3 quando todas as partes chegam', () => {
  const { db, os } = cenario();
  for (const p of os.partes) registrarRecebimento(db, p.codigo_barras, 'op1');
  const r = rastrearPedido(db, os.codigo);
  assert.equal(r.etapa, 3);
  assert.equal(r.partes_no_hub, 2);
});

test('rastreio sinaliza atraso de forma amigavel', () => {
  const { db, os } = cenario();
  db.prepare("UPDATE parte SET prazo_limite = '2020-01-01T00:00:00.000Z' WHERE codigo_barras = ?")
    .run(os.partes[0].codigo_barras);
  const r = rastrearPedido(db, os.codigo);
  assert.equal(r.atrasado, true);
  assert.match(r.partes[0].situacao, /Atrasado/);
});

test('despacharOS: PRONTA_DESPACHO -> DESPACHADA com rastreio da transportadora', () => {
  const { db, os } = cenario();
  ateProntaDespacho(db, os);
  const dep = despacharOS(db, os.codigo, { rastreio_postagem: 'AA123456789BR' });
  assert.equal(dep.status, OS.DESPACHADA);
  assert.ok(dep.despachada_em);

  const r = rastrearPedido(db, os.codigo);
  assert.equal(r.etapa, 5);
  assert.equal(r.rastreio_postagem, 'AA123456789BR');
  assert.ok(r.datas.enviado_em);
});

test('despacharOS rejeita OS que nao esta pronta', () => {
  const { db, os } = cenario();
  assert.throws(() => despacharOS(db, os.codigo), /transicao invalida/);
});

test('encerrarOS fecha o ciclo e o rastreio mostra entregue', () => {
  const { db, os } = cenario();
  ateProntaDespacho(db, os);
  despacharOS(db, os.codigo);
  const enc = encerrarOS(db, os.codigo);
  assert.equal(enc.status, OS.ENCERRADA);
  const r = rastrearPedido(db, os.codigo);
  assert.equal(r.entregue, true);
  assert.equal(r.etapa, 5);
});

test('rastreio: codigo invalido -> 400; inexistente -> 404', () => {
  const { db } = cenario();
  assert.throws(() => rastrearPedido(db, 'XPTO'), (e) => e.statusCode === 400);
  assert.throws(() => rastrearPedido(db, 'NV-9900099'), (e) => e.statusCode === 404);
});
