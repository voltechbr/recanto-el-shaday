/* =========================================================
   Recanto El Shaday — Etapa 5: efeitos especiais
   1) tela de carregamento  2) cursor de flamingo (só mouse)
   3) bolhas de clique      4) rolagem com GSAP + ScrollTrigger
   Cada bloco é isolado: se um falhar, os outros e o site continuam.
   ========================================================= */
(function () {
  'use strict';

  var doc = document.documentElement;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ------------------------------------------------------------
     1) TELA DE CARREGAMENTO
     Some quando a página carregou (mínimo ~2,2 s para a animação e a frase
     aparecerem; no máximo ~5 s, mesmo que o vídeo demore).
  ------------------------------------------------------------ */
  var loaderDone = false;
  function finishLoader() {
    if (loaderDone) return;
    loaderDone = true;
    var el = document.getElementById('loader');
    doc.classList.remove('has-loader');            // libera rolagem e a entrada do hero
    if (el) {
      el.classList.add('is-leaving');
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
        doc.classList.remove('js-loader');
        refreshScroll();
      }, 1200);
    } else {
      doc.classList.remove('js-loader');
    }
  }
  function initLoader() {
    var el = document.getElementById('loader');
    if (!el || !doc.classList.contains('js-loader') || reduce) {
      doc.classList.remove('has-loader');
      if (el && el.parentNode) el.parentNode.removeChild(el);
      return;
    }
    var minDone = false, loaded = document.readyState === 'complete';
    var tryFinish = function () { if (minDone && loaded) finishLoader(); };
    setTimeout(function () { minDone = true; tryFinish(); }, 2200);
    setTimeout(finishLoader, 5000);
    if (!loaded) window.addEventListener('load', function () { loaded = true; tryFinish(); });
  }

  /* ------------------------------------------------------------
     2) CURSOR DE FLAMINGO — apenas mouse real (hover + pointer fine)
     pointer-events:none → nunca interfere em cliques ou navegação.
  ------------------------------------------------------------ */
  function initCursor() {
    var fine = window.matchMedia('(hover: hover) and (pointer: fine)');
    if (!fine.matches) return;

    var wrap = document.createElement('div');
    wrap.className = 'flamingo';
    wrap.setAttribute('aria-hidden', 'true');
    wrap.innerHTML =
      '<span class="flamingo__body"><svg viewBox="0 0 72 72">' +
      '<defs>' +
      '<linearGradient id="fgRing" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffa3c8"/><stop offset="1" stop-color="#ff5c9a"/></linearGradient>' +
      '<linearGradient id="fgNeck" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff9cc4"/><stop offset="1" stop-color="#ff6aa5"/></linearGradient>' +
      '</defs>' +
      /* boia: anel rosa com furo mostrando a água turquesa */
      '<ellipse cx="36" cy="49" rx="27" ry="16" fill="#d9487f" opacity=".55"/>' +
      '<ellipse cx="36" cy="45" rx="27" ry="16" fill="url(#fgRing)"/>' +
      '<ellipse cx="36" cy="45" rx="14.500" ry="7.500" fill="#5fe3ef"/>' +
      '<ellipse cx="36" cy="44" rx="14.500" ry="6.500" fill="#2cc4d6" opacity=".55"/>' +
      '<path d="M14 40c4-9 14-12 22-12" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="2.500" stroke-linecap="round"/>' +
      /* pescoço e cabeça do flamingo */
      '<path d="M22 36C8 32 9 12 23 11" fill="none" stroke="url(#fgNeck)" stroke-width="7" stroke-linecap="round"/>' +
      '<circle cx="25" cy="11" r="6" fill="#ff7db1"/>' +
      '<path d="M29 9c6 0 11 3 11 8-4-1-8-1-11-3z" fill="#2b1b22"/>' +
      '<path d="M29 9c3 0 6 1 8 2.500-3 .5-6 0-8-1z" fill="#f5e6cf"/>' +
      '<circle cx="25" cy="9.500" r="1.600" fill="#fff"/><circle cx="25.500" cy="9.500" r=".8" fill="#2b1b22"/>' +
      '</svg></span>';
    document.body.appendChild(wrap);

    /* Posição aplicada direto no evento do ponteiro: sem rAF, sem interpolação, sem transição de posição.
       (Antes: LERP de 0,38 por frame a cada pointermove → o flamingo "deslizava" atrás do mouse.)
       'pointerrawupdate' (Chromium) entrega a posição na taxa real do mouse; nos demais, pointermove. */
    var shown = false, lastLink = false;
    function move(e) {
      if (e.pointerType && e.pointerType !== 'mouse') return;
      wrap.style.transform = 'translate3d(' + e.clientX + 'px,' + e.clientY + 'px,0)';
      if (!shown) {
        shown = true;
        wrap.classList.add('is-on');
        doc.classList.add('has-flamingo');        // só esconde o cursor nativo depois que o flamingo apareceu
      }
      var t = !!(e.target && e.target.closest && e.target.closest('a,button,summary,[role="button"]'));
      if (t !== lastLink) { lastLink = t; wrap.classList.toggle('is-link', t); }
    }
    document.addEventListener('onpointerrawupdate' in window ? 'pointerrawupdate' : 'pointermove', move, { passive: true });
    document.addEventListener('pointerdown', function (e) { if (!e.pointerType || e.pointerType === 'mouse') wrap.classList.add('is-down'); }, { passive: true });
    document.addEventListener('pointerup', function () { wrap.classList.remove('is-down'); }, { passive: true });
    document.documentElement.addEventListener('mouseleave', function () { wrap.classList.remove('is-on'); });
    document.documentElement.addEventListener('mouseenter', function () { if (shown) wrap.classList.add('is-on'); });

    // se o ponteiro deixar de ser fino (ex.: destacar tela touch), devolve o cursor nativo
    var off = function () { if (!fine.matches) { doc.classList.remove('has-flamingo'); wrap.style.display = 'none'; } };
    if (fine.addEventListener) fine.addEventListener('change', off);
  }

  /* ------------------------------------------------------------
     3) BOLHAS AO CLICAR (botões e links)
  ------------------------------------------------------------ */
  function initBubbles() {
    if (reduce || !document.body.animate) return;
    var layer = document.createElement('div');
    layer.className = 'fx-bubbles';
    layer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(layer);
    var small = window.matchMedia('(max-width: 680px), (pointer: coarse)').matches;
    var count = small ? 10 : 15;

    function pop(cx, cy) {
      if (layer.childNodes.length > 70) return;
      var ease = 'cubic-bezier(.2,.7,.2,1)';
      function place(node, size) { node.style.width = node.style.height = size + 'px'; layer.appendChild(node); return size / 2; }
      function el(cls) { var n = document.createElement('i'); if (cls) n.className = cls; return n; }

      /* mancha de luz + anel que se expande */
      var sp = el('splash'), h = place(sp, 90);
      sp.animate([
        { transform: 'translate(' + (cx - h) + 'px,' + (cy - h) + 'px) scale(.2)', opacity: .9 },
        { transform: 'translate(' + (cx - h) + 'px,' + (cy - h) + 'px) scale(1.5)', opacity: 0 }
      ], { duration: 650, easing: ease }).onfinish = function () { sp.remove(); };

      var ring = el('ring'); h = place(ring, 30);
      ring.animate([
        { transform: 'translate(' + (cx - h) + 'px,' + (cy - h) + 'px) scale(.3)', opacity: 1 },
        { transform: 'translate(' + (cx - h) + 'px,' + (cy - h) + 'px) scale(5.5)', opacity: 0 }
      ], { duration: 850, easing: ease }).onfinish = function () { ring.remove(); };

      /* bolhas maiores subindo, com balanço lateral */
      for (var i = 0; i < count; i++) {
        var b = el(), s = 14 + Math.pow(Math.random(), 1.6) * 34, r = place(b, s);
        var side = (Math.random() - .5) * 150;
        var rise = 70 + Math.random() * 130;
        var x0 = cx - r + (Math.random() - .5) * 26, y0 = cy - r + (Math.random() - .5) * 14;
        var sway = (Math.random() < .5 ? -1 : 1) * (10 + Math.random() * 16);
        (function (node, x0, y0, side, rise, sway) {
          node.animate([
            { transform: 'translate(' + x0 + 'px,' + y0 + 'px) scale(.2)', opacity: 0 },
            { transform: 'translate(' + (x0 + side * .35) + 'px,' + (y0 - rise * .3) + 'px) scale(1)', opacity: 1, offset: .18 },
            { transform: 'translate(' + (x0 + side * .35 + sway) + 'px,' + (y0 - rise * .65) + 'px) scale(1.04)', opacity: 1, offset: .6 },
            { transform: 'translate(' + (x0 + side) + 'px,' + (y0 - rise) + 'px) scale(1.18)', opacity: 0 }
          ], { duration: 950 + Math.random() * 750, easing: 'cubic-bezier(.25,.6,.3,1)', delay: Math.random() * 110 })
            .onfinish = function () { node.remove(); };
        })(b, x0, y0, side, rise, sway);
      }
    }

    document.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('a[href],button,summary,.btn') : null;
      if (!t) return;
      var cx = e.clientX, cy = e.clientY;
      if (!cx && !cy) {                                           // clique via teclado: usa o centro do elemento
        var r = t.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2;
      }
      pop(cx, cy);
    }, { passive: true });
  }

  /* ------------------------------------------------------------
     4) ANIMAÇÕES DE ROLAGEM — GSAP + ScrollTrigger
     Só roda se as bibliotecas carregaram e o movimento não está reduzido.
     Os conteúdos só são escondidos depois disso: se algo falhar, tudo
     continua visível (o CSS das seções já mostra o conteúdo por padrão).
  ------------------------------------------------------------ */
  var scrollReady = false;
  function refreshScroll() { if (scrollReady && window.ScrollTrigger) window.ScrollTrigger.refresh(); }

  function initScroll() {
    if (reduce || !window.gsap || !window.ScrollTrigger) return;
    var gsap = window.gsap, ST = window.ScrollTrigger;
    gsap.registerPlugin(ST);
    ST.config({ ignoreMobileResize: true });

    // GSAP assume a revelação: desliga a revelação em CSS/IO das seções 2–4 (sem dupla animação)
    ['momento', 'estrutura', 'contato'].forEach(function (id) {
      var r = document.getElementById(id); if (r) r.classList.remove('is-ready');
    });

    var q = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

    /* --- Textos e blocos: surgem subindo suavemente --- */
    var blocks = q([
      '.moment__head > div', '.moment__aside', '.m-block', '.m-leisure__cta',
      '.est__head > *', '.est__struct-text h3', '.est__pool', '.est__cap-item', '.est__price-main', '.est__cta',
      '.rsv__head > *', '.rsv__loc', '.rsv__book', '.rsv__fact', '.rsv__rules-head'
    ].join(','));
    if (blocks.length) {
      gsap.set(blocks, { opacity: 0, y: 36 });
      ST.batch(blocks, {
        start: 'top 88%', once: true,
        onEnter: function (els) { gsap.to(els, { opacity: 1, y: 0, duration: .95, ease: 'power3.out', stagger: .12, overwrite: true, clearProps: 'transform' }); }
      });
    }

    /* --- Listas em cascata: índice, ocasiões, passos e regras --- */
    ['.est__index li', '.est__occ-words li', '.rsv__steps li', '.rsv details'].forEach(function (sel) {
      var items = q(sel); if (!items.length) return;
      gsap.set(items, { opacity: 0, y: 24 });
      ST.batch(items, {
        start: 'top 92%', once: true,
        onEnter: function (els) { gsap.to(els, { opacity: 1, y: 0, duration: .8, ease: 'power2.out', stagger: .08, overwrite: true, clearProps: 'transform' }); }
      });
    });
    var occHead = q('.est__occ > .est__eyebrow');
    if (occHead.length) {
      gsap.set(occHead, { opacity: 0, y: 20 });
      ST.batch(occHead, { start: 'top 92%', once: true, onEnter: function (e) { gsap.to(e, { opacity: 1, y: 0, duration: .8, ease: 'power2.out', clearProps: 'transform' }); } });
    }

    /* --- Fotos: surgem com leve escala --- */
    var figs = q('.m-fig, .est__fig');
    if (figs.length) {
      gsap.set(figs, { opacity: 0, y: 48, scale: .965 });
      ST.batch(figs, {
        start: 'top 90%', once: true,
        onEnter: function (els) { gsap.to(els, { opacity: 1, y: 0, scale: 1, duration: 1.15, ease: 'power3.out', stagger: .16, overwrite: true, clearProps: 'transform' }); }
      });
    }

    /* --- Números: contagem suave (35, 100 e 850) --- */
    q('.est__cap .est__big, .est__amount').forEach(function (el) {
      var node = null;
      for (var i = 0; i < el.childNodes.length; i++) {
        var n = el.childNodes[i];
        if (n.nodeType === 3 && /^\s*\d+\s*$/.test(n.nodeValue)) { node = n; break; }
      }
      if (!node) return;
      var end = parseInt(node.nodeValue, 10), o = { v: 0 };
      node.nodeValue = '0';
      ST.create({
        trigger: el, start: 'top 88%', once: true,
        onEnter: function () {
          gsap.to(o, { v: end, duration: 1.6, ease: 'power2.out',
            onUpdate: function () { node.nodeValue = String(Math.round(o.v)); },
            onComplete: function () { node.nodeValue = String(end); } });
        }
      });
    });

    /* --- Profundidade (somente telas largas com mouse): paralaxe suave --- */
    var mm = gsap.matchMedia();
    mm.add('(min-width: 1021px) and (hover: hover) and (pointer: fine)', function () {
      doc.classList.add('fx-depth');
      q('.m-fig__img img, .est__fig img').forEach(function (img) {
        gsap.fromTo(img, { '--gy': -4 }, {
          '--gy': 4, ease: 'none',
          scrollTrigger: { trigger: img.closest('figure') || img, start: 'top bottom', end: 'bottom top', scrub: .6 }
        });
      });
      q('.m-num').forEach(function (n) {
        gsap.fromTo(n, { yPercent: 10 }, { yPercent: -10, ease: 'none',
          scrollTrigger: { trigger: n, start: 'top bottom', end: 'bottom top', scrub: .8 } });
      });
      q('.moment__deco--waves').forEach(function (w) {
        gsap.fromTo(w, { yPercent: -6 }, { yPercent: 6, ease: 'none',
          scrollTrigger: { trigger: '#momento', start: 'top bottom', end: 'bottom top', scrub: 1 } });
      });
      return function () { doc.classList.remove('fx-depth'); };
    });

    scrollReady = true;
    window.addEventListener('load', function () { ST.refresh(); });
  }

  /* ------------------------------------------------------------ */
  function safe(fn) { try { fn(); } catch (e) { if (window.console) console.warn('[efeitos]', e); } }
  safe(initLoader);
  safe(initCursor);
  safe(initBubbles);
  safe(initScroll);
})();
