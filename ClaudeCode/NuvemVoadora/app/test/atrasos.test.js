import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abrirBanco, migrar } from '../db/db.js';
import { criarLoja } from '../src/lojas.js';
import { criarOS } from '../src/os.js';
import { registrarRecebimento } from '../src/recebimento.js';
import { osAtrasadas, partesEmRisco, desempenhoLojas, historicoAtrasos } from '../src/atrasos.js';
import { obterOS } from '../src/os.js';

const AGORA = '2026-07-06T12:00:00Z';

function base() {
  const db = migrar(abrirBanco(':memory:'));
  const atrasada = criarLoja(db, { nome: 'Loja Atrasada' });
  const pontual = criarLoja(db, { nome: 'Loja Pontual' });
  return { db, atrasada, pontual };
}

test('OS com parte AGUARDANDO vencida aparece com a loja responsável', () => {
  const { db, atrasada, pontual } = base();
  // janela fecha no passado -> prazo (=+5d) tambem no passado
  const os = criarOS(db, {
    cliente: { nome: 'Cliente' },
    janela_fecha_em: '2026-06-01',
    partes: [{ loja_id: atrasada.id, itens: [{ descricao: 'x' }] }, { loja_id: pontual.id, itens: [{ descricao: 'y' }] }],
  });
  const lista = osAtrasadas(db, AGORA);
  assert.equal(lista.length, 1);
  assert.equal(lista[0].codigo, os.codigo);
  // ambas as partes estao vencidas (mesma janela); a responsavel esta identificada
  assert.ok(lista[0].partes_atrasadas.some((p) => p.loja_nome === 'Loja Atrasada'));
  assert.ok(lista[0].max_dias_atraso > 0);
});

test('parte já recebida não conta como atrasada (RN-07.1)', () => {
  const { db, atrasada, pontual } = base();
  const os = criarOS(db, {
    cliente: { nome: 'Cliente' },
    janela_fecha_em: '2026-06-01',
    partes: [{ loja_id: atrasada.id, itens: [] }, { loja_id: pontual.id, itens: [] }],
  });
  // recebe as duas -> nada atrasado
  for (const p of os.partes) registrarRecebimento(db, p.codigo_barras, 'op');
  assert.equal(osAtrasadas(db, AGORA).length, 0);
});

test('desempenhoLojas aponta a loja culpada', () => {
  const { db, atrasada, pontual } = base();
  criarOS(db, {
    cliente: { nome: 'C' },
    janela_fecha_em: '2026-06-01',
    partes: [{ loja_id: atrasada.id, itens: [] }, { loja_id: pontual.id, itens: [] }],
  });
  const ranking = desempenhoLojas(db, AGORA);
  assert.ok(ranking.length >= 1);
  assert.ok(ranking.every((l) => l.partes_atrasadas > 0));
});

test('parte recebida com atraso vira histórico da loja (nº do pacote) e marca a OS', () => {
  const { db, atrasada, pontual } = base();
  // janela no passado -> prazo (=+5d) tambem no passado -> recebimento agora = atrasado
  const os = criarOS(db, {
    cliente: { nome: 'Cliente' },
    janela_fecha_em: '2026-06-01',
    partes: [{ loja_id: atrasada.id, itens: [] }, { loja_id: pontual.id, itens: [] }],
  });
  for (const p of os.partes) registrarRecebimento(db, p.codigo_barras, 'op');

  // ja nao ha atraso "em aberto" (todas recebidas)...
  assert.equal(osAtrasadas(db, AGORA).length, 0);
  // ...mas o historico persiste, com o numero do pacote e a loja responsavel.
  const hist = historicoAtrasos(db);
  assert.ok(hist.length >= 1);
  const lojaAtrasada = hist.find((l) => l.loja_nome === 'Loja Atrasada');
  assert.ok(lojaAtrasada);
  assert.equal(lojaAtrasada.total_atrasos, 1);
  assert.ok(lojaAtrasada.pacotes[0].codigo_parte.startsWith(os.codigo));
  assert.ok(lojaAtrasada.pacotes[0].dias_atraso >= 1);

  // o status de atraso permanece na ordem mesmo apos o recebimento.
  const det = obterOS(db, os.codigo);
  assert.equal(det.teve_atraso, true);
  assert.equal(det.atrasada, true);
  assert.ok(det.partes.some((p) => p.recebida_atrasada));
});

test('parte recebida no prazo não gera histórico', () => {
  const { db, atrasada, pontual } = base();
  // janela no futuro -> prazo no futuro -> recebimento agora = dentro do prazo
  const os = criarOS(db, {
    cliente: { nome: 'Cliente' },
    janela_fecha_em: '2027-01-01',
    partes: [{ loja_id: atrasada.id, itens: [] }, { loja_id: pontual.id, itens: [] }],
  });
  for (const p of os.partes) registrarRecebimento(db, p.codigo_barras, 'op');
  assert.equal(historicoAtrasos(db).length, 0);
  assert.equal(obterOS(db, os.codigo).teve_atraso, false);
});

test('partesEmRisco pega prazo dentro de 2 dias', () => {
  const { db, atrasada, pontual } = base();
  // agora = 10/07; janela fecha 06/07 -> prazo = 11/07 (dentro de 2 dias)
  criarOS(db, {
    cliente: { nome: 'C' },
    janela_fecha_em: '2026-07-06',
    partes: [{ loja_id: atrasada.id, itens: [] }, { loja_id: pontual.id, itens: [] }],
  });
  const risco = partesEmRisco(db, '2026-07-10T12:00:00Z', 2);
  assert.ok(risco.length >= 1);
});
