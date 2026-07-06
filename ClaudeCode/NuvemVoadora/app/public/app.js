// Helpers compartilhados (script global, sem modulos).

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* sem corpo */ }
  if (!res.ok) throw new Error((data && data.mensagem) || res.statusText);
  return data;
}

function fmtData(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short',
  });
}

function fmtDia(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

function badge(status) {
  return `<span class="badge ${status}">${status.replace(/_/g, ' ')}</span>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function qs(nome) {
  return new URLSearchParams(location.search).get(nome);
}

// Navegacao centralizada: injeta o topo em qualquer pagina que tenha <header class="topo">.
const NAV = [
  ['index.html', 'Início'],
  ['recebimento.html', 'Recebimento'],
  ['separacao.html', 'Separação'],
  ['atrasos.html', 'Atrasos'],
  ['auditoria.html', 'Auditoria'],
  ['nova-os.html', 'Nova OS'],
  ['lojas.html', 'Lojas'],
];

function montarTopo() {
  const header = document.querySelector('header.topo');
  if (!header) return;
  const arquivo = location.pathname.split('/').pop() || 'index.html';
  header.innerHTML =
    '<h1>☁️ Nuvem Voadora — HUB</h1><nav>' +
    NAV.map(([href, txt]) => `<a href="${href}"${href === arquivo ? ' class="ativo"' : ''}>${txt}</a>`).join('') +
    '</nav>';
}

document.addEventListener('DOMContentLoaded', montarTopo);
