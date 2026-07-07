import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abrirBanco, migrar } from '../db/db.js';
import { criarLoja } from '../src/lojas.js';
import { criarOS, despacharOS } from '../src/os.js';
import { registrarRecebimento } from '../src/recebimento.js';
import { iniciarSeparacao, scanConsolidacao, finalizarSeparacao } from '../src/separacao.js';
import {
  indicadores, relatorioInventario, relatorioPartesAReceber,
  relatorioOrdens, relatorioAtrasosLojas,
} from '../src/gerencial.js';

function cenario() {
  const db = migrar(abrirBanco(':memory:'));
  const l1 = criarLoja(db, { nome: 'Loja A', janela_dias: 15 });
  const l2 = criarLoja(db, { nome: 'Loja B', janela_dias: 7 });
  const novaOS = () => criarOS(db, {
    cliente: { nome: 'Cliente Teste', uf: 'SP' },
    partes: [
      { loja_id: l1.id, itens: [{ descricao: 'Carta X', quantidade: 1 }] },
      { loja_id: l2.id, itens: [{ descricao: 'Carta Y', quantidade: 2 }] },
    ],
  });
  return { db, l1, l2, novaOS };
}

function atePronta(db, os) {
  for (const p of os.partes) registrarRecebimento(db, p.codigo_barras, 'op1');
  iniciarSeparacao(db, os.codigo);
  for (const p of os.partes) scanConsolidacao(db, os.codigo, p.codigo_barras, 'op1');
  return finalizarSeparacao(db, os.codigo);
}

test('indicadores: por_status, KPIs e pendencias por loja', () => {
  const { db, novaOS } = cenario();
  const os1 = novaOS();           // fica PENDENTE (2 partes a receber)
  const os2 = novaOS();
  registrarRecebimento(db, os2.partes[0].codigo_barras, 'op1'); // 1 no HUB

  const d = indicadores(db);
  const status = Object.fromEntries(d.por_status.map((s) => [s.status, s.total]));
  assert.equal(status.PENDENTE, 2);
  assert.equal(d.kpis.ordens_ativas, 2);
  assert.equal(d.kpis.partes_no_hub, 1);
  assert.equal(d.kpis.partes_a_receber, 3);
  assert.equal(d.kpis.atrasadas, 0);

  const lojaB = d.a_receber_por_loja.find((l) => l.loja === 'Loja B');
  assert.equal(lojaB.total, 2);   // parte da os1 + parte da os2
  const lojaA = d.a_receber_por_loja.find((l) => l.loja === 'Loja A');
  assert.equal(lojaA.total, 1);   // so a da os1 (a outra ja foi recebida)
  void os1;
});

test('indicadores: finalizadas_20d empilha em dia × com atraso', () => {
  const { db, novaOS } = cenario();
  const emDia = novaOS();
  atePronta(db, emDia);

  const comAtraso = novaOS();
  db.prepare("UPDATE parte SET prazo_limite = '2020-01-01T00:00:00.000Z' WHERE os_id = (SELECT id FROM ordem_servico WHERE codigo = ?) AND letra = 'A'")
    .run(comAtraso.codigo);
  atePronta(db, comAtraso);

  const d = indicadores(db);
  assert.equal(d.finalizadas_20d.length, 20);
  const hoje = d.finalizadas_20d[19];
  assert.equal(hoje.em_dia, 1);
  assert.equal(hoje.com_atraso, 1);
  assert.equal(d.kpis.lead_time_medio !== null, true);
});

test('indicadores: lojas_por_mes traz series com totais do periodo', () => {
  const { db, novaOS } = cenario();
  novaOS();
  novaOS();
  const d = indicadores(db);
  assert.equal(d.lojas_por_mes.meses.length, 1); // tudo aberto neste mes
  const serieA = d.lojas_por_mes.series.find((s) => s.loja === 'Loja A');
  assert.deepEqual(serieA.valores, [2]);
});

test('relatorio inventario: so partes dentro do HUB, com conteudo e dias', () => {
  const { db, novaOS } = cenario();
  const os = novaOS();
  registrarRecebimento(db, os.partes[0].codigo_barras, 'joana');

  const rel = relatorioInventario(db);
  assert.equal(rel.arquivo, 'inventario-hub.xlsx');
  assert.equal(rel.abas[0].linhas.length, 1); // so a recebida
  const linha = rel.abas[0].linhas[0];
  assert.equal(linha[0], os.partes[0].codigo_barras);
  assert.equal(linha[4], 'Loja A');
  assert.match(linha[9], /1× Carta X/);
  assert.equal(linha[11], 'joana');
  assert.equal(typeof linha[13], 'number'); // dias no HUB
});

test('relatorio inventario: OS despachada sai do inventario', () => {
  const { db, novaOS } = cenario();
  const os = novaOS();
  atePronta(db, os);
  assert.equal(relatorioInventario(db).abas[0].linhas.length, 2);
  despacharOS(db, os.codigo);
  assert.equal(relatorioInventario(db).abas[0].linhas.length, 0);
});

test('relatorio partes a receber: situacao No prazo / ATRASADA', () => {
  const { db, novaOS } = cenario();
  const os = novaOS();
  db.prepare("UPDATE parte SET prazo_limite = '2020-01-01T00:00:00.000Z' WHERE os_id = (SELECT id FROM ordem_servico WHERE codigo = ?) AND letra = 'A'")
    .run(os.codigo);

  const { linhas } = relatorioPartesAReceber(db).abas[0];
  assert.equal(linhas.length, 2);
  const atrasada = linhas.find((l) => l[0].endsWith('-A'));
  assert.equal(atrasada[10], 'ATRASADA');
  assert.ok(atrasada[11] > 0);
  const noPrazo = linhas.find((l) => l[0].endsWith('-B'));
  assert.equal(noPrazo[10], 'No prazo');
});

test('relatorio ordens: lead time e flags de atraso', () => {
  const { db, novaOS } = cenario();
  const os = novaOS();
  atePronta(db, os);
  const { linhas } = relatorioOrdens(db).abas[0];
  const l = linhas.find((x) => x[0] === os.codigo);
  assert.equal(l[3], 'PRONTA_DESPACHO');
  assert.equal(l[7], 'Não');            // teve atraso
  assert.equal(typeof l[13], 'number'); // lead time
});

test('relatorio atrasos-lojas: resumo + detalhe em duas abas', () => {
  const { db, novaOS } = cenario();
  const os = novaOS();
  db.prepare("UPDATE parte SET prazo_limite = '2020-01-01T00:00:00.000Z' WHERE os_id = (SELECT id FROM ordem_servico WHERE codigo = ?) AND letra = 'A'")
    .run(os.codigo);
  registrarRecebimento(db, os.partes[0].codigo_barras, 'op1');

  const rel = relatorioAtrasosLojas(db);
  assert.equal(rel.abas.length, 2);
  assert.equal(rel.abas[0].linhas.length, 1);
  assert.equal(rel.abas[0].linhas[0][0], 'Loja A');
  assert.equal(rel.abas[1].linhas[0][1], os.partes[0].codigo_barras);
});
