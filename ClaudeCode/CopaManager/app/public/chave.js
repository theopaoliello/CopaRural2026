// Desenhador de chaveamento em SVG (EF Mata-mata Manual, secao 5.2.1).
// UMA funcao serve as tres telas — miniatura da galeria do wizard, chave
// grande da aba Chaveamento e mata-mata da pagina publica — sempre desenhando
// a partir da MESMA estrutura que gera os jogos: o que se ve nunca diverge do
// motor. Sem dependencias; compartilhado por admin.html e c.html.
//
// Estrutura de entrada (normalizada pelos adaptadores no fim do arquivo):
//   { rodadas: N,
//     confrontos: [{ rodada, confronto }],            // sem a disputa de 3o
//     entradas:   [{ rodada, confronto, lado, rotulo }] }
(function () {
  'use strict';

  const escXml = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Atribui uma linha a cada entrada e o ponto medio a cada confronto,
  // percorrendo a arvore em ordem visual (lado casa em cima).
  function calcularLayout(estrutura) {
    const nos = new Map(estrutura.confrontos.map((c) => [`${c.rodada}:${c.confronto}`, { ...c }]));
    const entradas = new Map(estrutura.entradas.map((e) => [`${e.rodada}:${e.confronto}:${e.lado}`, { ...e }]));
    let linha = 0;

    function visitar(r, c) {
      const no = nos.get(`${r}:${c}`);
      no.lados = {};
      for (const lado of ['casa', 'fora']) {
        const filho = nos.get(`${r - 1}:${lado === 'casa' ? c * 2 : c * 2 + 1}`);
        const entrada = entradas.get(`${r}:${c}:${lado}`);
        if (entrada) {
          entrada.linha = linha++;
          no.lados[lado] = { y: entrada.linha, fonte: 'entrada', entrada };
        } else if (filho) {
          no.lados[lado] = { y: visitar(r - 1, filho.confronto), fonte: 'filho', filho };
        } else {
          no.lados[lado] = null; // vaga sem alimentador (nao ocorre fora da disputa)
        }
      }
      const ys = Object.values(no.lados).filter(Boolean).map((l) => l.y);
      no.y = ys.reduce((a, b) => a + b, 0) / ys.length;
      return no.y;
    }

    const raiz = estrutura.confrontos.reduce((m, c) => (c.rodada > m.rodada ? c : m));
    visitar(raiz.rodada, raiz.confronto);
    // So desenha o que a raiz alcanca: um confronto solto (dado inconsistente)
    // e ignorado em vez de derrubar a tela inteira.
    return { nos: [...nos.values()].filter((n) => n.lados), totalLinhas: linha, raiz };
  }

  // Desenha a chave. opcoes: { rotulos (true = nomes; false = miniatura),
  // largura (so na miniatura, para caber no cartao) }.
  function desenhar(estrutura, opcoes) {
    const op = opcoes || {};
    const rot = op.rotulos !== false;
    const colW = rot ? 128 : 30;
    const rowH = rot ? 30 : 13;
    const margem = rot ? 118 : 10;
    const { nos, totalLinhas } = calcularLayout(estrutura);
    const X = (r) => margem + r * colW; // juncao (linha vertical) da rodada r
    const Y = (l) => 12 + l * rowH;

    const linhas = [];
    const textos = [];
    const traco = (x1, y1, x2, y2) =>
      linhas.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`);

    for (const no of nos) {
      const x = X(no.rodada);
      const ys = [];
      for (const lado of ['casa', 'fora']) {
        const l = no.lados[lado];
        if (!l) continue;
        const y = Y(l.y);
        ys.push(y);
        if (l.fonte === 'entrada') {
          // Rotulo a esquerda + linha ate a juncao da rodada em que entra
          // (folga = linha longa atravessando as rodadas puladas).
          traco(margem, y, x, y);
          if (rot) {
            textos.push(`<text x="${margem - 6}" y="${y + 4}" text-anchor="end">${escXml(l.entrada.rotulo)}</text>`);
          } else {
            traco(margem - 5, y, margem, y);
          }
        } else {
          traco(X(l.filho.rodada), Y(l.filho.y), x, Y(l.filho.y)); // saida do confronto filho
        }
      }
      if (ys.length === 2) traco(x, ys[0], x, ys[1]);
    }
    // Saida do campeao.
    const raizNo = nos.reduce((m, c) => (c.rodada > m.rodada ? c : m));
    const xFim = X(raizNo.rodada);
    traco(xFim, Y(raizNo.y), xFim + (rot ? 26 : 10), Y(raizNo.y));
    if (rot) textos.push(`<text x="${xFim + 30}" y="${Y(raizNo.y) + 4}">🏆</text>`);

    const largura = xFim + (rot ? 60 : 16);
    const altura = Y(totalLinhas - 1) + 14;
    const escala = op.largura ? ` width="${op.largura}"` : ' width="100%"';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${largura} ${altura}"${escala} ` +
      `style="max-width:${largura}px" role="img">` +
      `<g stroke="currentColor" stroke-width="1.4" fill="none" opacity="0.75">${linhas.join('')}</g>` +
      `<g fill="currentColor" font-size="12" font-family="inherit">${textos.join('')}</g></svg>`;
  }

  // ---------- layout em caixas (uma caixa por confronto) ----------

  // Alem do desenho de linhas, as telas que mostram PLACAR precisam de uma
  // caixa por confronto. Aqui sai a altura (em "unidades de caixa") de cada
  // uma: quem nao e alimentado por ninguem ocupa a proxima linha livre; quem e
  // alimentado fica na media dos seus alimentadores. Numa chave com folga isso
  // alinha o confronto com quem o abastece — e numa escada empilha tudo na
  // mesma faixa, que e exatamente como uma escada se le.
  function layoutCaixas(estrutura) {
    const existe = new Set(estrutura.confrontos.map((c) => `${c.rodada}:${c.confronto}`));
    const alimentadores = (c) => [c.confronto * 2, c.confronto * 2 + 1]
      .filter((f) => existe.has(`${c.rodada - 1}:${f}`))
      .map((f) => ({ rodada: c.rodada - 1, confronto: f }));

    const ordenados = [...estrutura.confrontos].sort((a, b) => a.rodada - b.rodada || a.confronto - b.confronto);
    const y = new Map();
    let proxima = 0;
    for (const c of ordenados) {
      const pais = alimentadores(c).map((f) => y.get(`${f.rodada}:${f.confronto}`));
      y.set(`${c.rodada}:${c.confronto}`, pais.length
        ? pais.reduce((a, b) => a + b, 0) / pais.length
        : proxima++);
    }
    const rodadas = [...new Set(ordenados.map((c) => c.rodada))].sort((a, b) => a - b);
    return {
      linhas: Math.max(proxima, 1),
      rodadas: rodadas.map((rodada) => ({
        rodada,
        confrontos: ordenados.filter((c) => c.rodada === rodada)
          .map((c) => ({ ...c, y: y.get(`${c.rodada}:${c.confronto}`) }))
          .sort((a, b) => a.y - b.y),
      })),
    };
  }

  // ---------- adaptadores ----------

  // Do catalogo (GET /api/chaveamentos): rotulos P1..PN ou nomes fornecidos.
  function deCatalogo(desenho, nomes) {
    return {
      rodadas: desenho.rodadas,
      confrontos: desenho.confrontos.map((c) => ({ rodada: c.rodada, confronto: c.confronto })),
      entradas: desenho.slots.map((s) => ({
        rodada: s.rodada, confronto: s.confronto, lado: s.lado,
        rotulo: (nomes && nomes[s.posicao - 1]) ?? `P${s.posicao}`,
      })),
    };
  }

  // De uma chave ja gerada (GET /api/campeonatos/:id/chaveamento): as vagas de
  // entrada viram rotulos com o nome do time. A disputa de 3o fica fora do
  // desenho (ela nao pertence a arvore da chave).
  // `rotuloDoSlot` (opcional) manda no texto — e por ele que o misto mostra
  // "1o do Grupo A" antes de a fase de grupos terminar.
  function deChaveamento(chav, nomeDoTime, rotuloDoSlot) {
    const confrontos = [];
    for (const r of chav.rodadas) {
      for (const c of r.confrontos.filter((x) => !x.disputa_terceiro)) {
        confrontos.push({ rodada: r.rodada, confronto: c.confronto });
      }
    }
    return {
      rodadas: Math.max(...confrontos.map((c) => c.rodada)),
      confrontos,
      entradas: chav.slots.map((s) => ({
        rodada: s.rodada, confronto: s.confronto, lado: s.lado,
        rotulo: (rotuloDoSlot ? rotuloDoSlot(s) : null) ?? nomeDoTime(s.time_id) ?? '?',
      })),
    };
  }

  // SVG (string) -> PNG baixado. E o "Baixar imagem do chaveamento" da EF
  // 5.2.1: o mesmo desenho que a tela mostra, pronto para o grupo do WhatsApp.
  function baixarPng(svg, nomeArquivo, escala) {
    const fator = escala || 2;
    const medida = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
    const largura = medida ? Number(medida[1]) : 800;
    const altura = medida ? Number(medida[2]) : 600;
    // Na tela o SVG e responsivo (width="100%"); como imagem isso o deixa sem
    // tamanho intrinseco e ele simplesmente nao carrega. Fixa as medidas.
    const paraImagem = svg
      .replace(/\swidth="[^"]*"/, ` width="${largura}"`)
      .replace(/<svg /, `<svg height="${altura}" `)
      .replace(/currentColor/g, '#14532d');

    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = largura * fator;
      canvas.height = altura * fator;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = `${nomeArquivo}.png`;
      a.click();
    };
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(paraImagem)}`;
  }

  window.ChaveSVG = { desenhar, deCatalogo, deChaveamento, layoutCaixas, baixarPng };
}());
