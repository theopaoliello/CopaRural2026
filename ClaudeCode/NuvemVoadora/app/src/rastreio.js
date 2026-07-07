// Rastreio publico do cliente final: consulta por codigo da OS (NV-2600001)
// ou de uma parte (NV-2600001-A). A resposta e SANITIZADA — nada de CEP,
// nome completo, escaninho ou operadores; so o progresso do pedido.
import { parseCodigo } from './codigos.js';
import { OS, parteEstaAtrasada } from './estados.js';
import { agoraISO } from './datas.js';
import { ErroValidacao, NaoEncontrado } from './erros.js';

// Jornada do cliente em 5 etapas; cada status da OS cai em uma delas.
export const ETAPAS = Object.freeze([
  'Pedido registrado',
  'Recebendo os pacotes das lojas',
  'Consolidando no HUB',
  'Pronto para envio',
  'Enviado',
]);

const ETAPA_POR_STATUS = Object.freeze({
  [OS.ABERTA]: 1,
  [OS.PENDENTE]: 2,
  [OS.LIBERADA_SEPARACAO]: 3,
  [OS.EM_SEPARACAO]: 3,
  [OS.PRONTA_DESPACHO]: 4,
  [OS.DESPACHADA]: 5,
  [OS.ENCERRADA]: 5,
});

const SITUACAO_OS = Object.freeze({
  ABERTA: 'Pedido registrado no HUB.',
  PENDENTE: 'Aguardando os pacotes das lojas chegarem ao HUB.',
  LIBERADA_SEPARACAO: 'Todos os pacotes chegaram! Consolidação na fila.',
  EM_SEPARACAO: 'Consolidando suas cartas em um pacote único.',
  PRONTA_DESPACHO: 'Pacote único pronto — despacho em breve.',
  DESPACHADA: 'Pacote enviado para você.',
  ENCERRADA: 'Pedido entregue. Bons jogos!',
  CANCELADA: 'Pedido cancelado. Fale com o suporte.',
});

const SITUACAO_PARTE = Object.freeze({
  AGUARDANDO: 'A caminho do HUB',
  RECEBIDA: 'Recebido no HUB',
  CONSOLIDADA: 'No pacote final',
  QUARENTENA: 'Em conferência no HUB',
  RECUSADA: 'Reenvio solicitado à loja',
});

function primeiroNome(nomeCompleto) {
  return String(nomeCompleto ?? '').trim().split(/\s+/)[0] || null;
}

export function rastrearPedido(db, codigoInformado, agora = agoraISO()) {
  const info = parseCodigo(codigoInformado);
  if (!info) {
    throw new ErroValidacao('Código inválido. Use o código do pedido (ex.: NV-2600001) ou do pacote (ex.: NV-2600001-A).');
  }
  const os = db.prepare('SELECT * FROM ordem_servico WHERE codigo = ?').get(info.codigoOS);
  if (!os) throw new NaoEncontrado(`Pedido não encontrado: ${info.codigoOS}`);

  const partes = db
    .prepare(
      `SELECT p.letra, p.status, p.prazo_limite, l.nome AS loja_nome
         FROM parte p JOIN loja l ON l.id = p.loja_id
        WHERE p.os_id = ? ORDER BY p.letra`,
    )
    .all(os.id);

  const partesCliente = partes.map((p) => {
    const atrasado = parteEstaAtrasada(p.status, p.prazo_limite, agora);
    return {
      letra: p.letra,
      loja_nome: p.loja_nome,
      situacao: atrasado ? 'Atrasado — já estamos cobrando a loja' : SITUACAO_PARTE[p.status],
      no_hub: p.status === 'RECEBIDA' || p.status === 'CONSOLIDADA',
      atrasado,
    };
  });

  const noHub = partesCliente.filter((p) => p.no_hub).length;
  const atrasado = partesCliente.some((p) => p.atrasado);
  const cancelado = os.status === OS.CANCELADA;

  return {
    codigo: os.codigo,
    cliente: primeiroNome(os.cliente_nome),
    etapa: cancelado ? null : ETAPA_POR_STATUS[os.status],
    etapas: ETAPAS,
    situacao: SITUACAO_OS[os.status] ?? os.status,
    cancelado,
    entregue: os.status === OS.ENCERRADA,
    total_partes: partesCliente.length,
    partes_no_hub: noHub,
    atrasado,
    partes: partesCliente,
    datas: {
      pedido_em: os.aberta_em,
      completo_em: os.liberada_em,
      pronto_em: os.pronta_em,
      enviado_em: os.despachada_em ?? null,
    },
    rastreio_postagem: os.rastreio_postagem ?? null,
  };
}
