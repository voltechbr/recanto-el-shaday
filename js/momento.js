/* Recanto El Shaday — Seção 2 (revelação ao rolar + paralaxe sutil) */
(function () {
  'use strict';
  var root = document.getElementById('momento');
  if (!root) return;

  var calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var items = root.querySelectorAll('[data-m]');

  /* Revelação: só esconde os itens quando o JS está ativo */
  if (!calm && 'IntersectionObserver' in window) {
    root.classList.add('is-ready');
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    items.forEach(function (el) { io.observe(el); });
  }

  /* Paralaxe leve nas fotos (apenas telas largas) */
  var wide = window.matchMedia('(min-width: 1021px)');
  var pars = root.querySelectorAll('.m-par[data-speed]');
  if (calm || !pars.length) return;

  var ticking = false;
  function update() {
    ticking = false;
    pars.forEach(function (el) {
      if (!wide.matches) { el.style.translate = ''; return; }
      var r = el.getBoundingClientRect();
      var mid = r.top + r.height / 2 - window.innerHeight / 2;
      el.style.translate = '0 ' + (mid * parseFloat(el.dataset.speed)).toFixed(1) + 'px';
    });
  }
  function onScroll() { if (!ticking) { ticking = true; requestAnimationFrame(update); } }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  update();
})();
