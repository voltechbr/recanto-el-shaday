/* Recanto El Shaday — Hero (Etapa 1) */
(function () {
  'use strict';

  /* ---- Destino do botão "Planejar minha visita" ----
     Hoje aponta para a âncora #contato (seção provisória no index.html).
     Quando a área de contato/reservas existir, basta trocar este valor
     (ex.: '#reservas' ou '/contato') — todos os [data-cta] são atualizados. */
  var CONTACT_TARGET = '#contato';

  document.querySelectorAll('[data-cta]').forEach(function (el) {
    el.setAttribute('href', CONTACT_TARGET);
  });

  /* ---- Vídeo: fallback e economia ---- */
  var hero = document.querySelector('.hero');
  var video = hero && hero.querySelector('.hero__video');
  if (video) {
    var fail = function () { video.style.display = 'none'; }; // o poster do .hero assume
    video.addEventListener('error', fail, true);
    video.querySelectorAll('source').forEach(function (s) { s.addEventListener('error', function () {
      if (video.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) fail();
    }); });

    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    var tryPlay = function () {
      if (reduce.matches) { video.pause(); return; }
      var p = video.play();
      if (p && p.catch) p.catch(fail);
    };
    tryPlay();

    // pausa quando fora da tela (bateria/dados)
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (e) {
        if (e[0].isIntersecting) tryPlay(); else video.pause();
      }, { threshold: 0.05 }).observe(hero);
    }
  }

  /* ---- Paralaxe sutil dos cartões (somente ponteiro fino, sem reduced-motion) ---- */
  var fine = window.matchMedia('(hover: hover) and (pointer: fine) and (min-width: 1101px)');
  var calm = window.matchMedia('(prefers-reduced-motion: reduce)');
  var cards = hero ? hero.querySelectorAll('.card[data-depth]') : [];
  if (cards.length && fine.matches && !calm.matches) {
    var raf = null, mx = 0, my = 0;
    hero.addEventListener('pointermove', function (e) {
      var r = hero.getBoundingClientRect();
      mx = (e.clientX - r.left) / r.width - 0.5;
      my = (e.clientY - r.top) / r.height - 0.5;
      if (!raf) raf = requestAnimationFrame(apply);
    });
    hero.addEventListener('pointerleave', function () { mx = my = 0; if (!raf) raf = requestAnimationFrame(apply); });
    function apply() {
      raf = null;
      cards.forEach(function (c) {
        var d = parseFloat(c.dataset.depth) || 10;
        c.style.transform = 'translate3d(' + (-mx * d).toFixed(1) + 'px,' + (-my * d).toFixed(1) + 'px,0)';
      });
    }
  }
})();
