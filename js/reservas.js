/* Recanto El Shaday — Seção 4 (revelação ao rolar) */
(function () {
  'use strict';
  var root = document.getElementById('contato');
  if (!root || !('IntersectionObserver' in window)) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  root.classList.add('is-ready');
  var io = new IntersectionObserver(function (es) {
    es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); } });
  }, { threshold: 0.1, rootMargin: '0px 0px -6% 0px' });
  root.querySelectorAll('[data-r]').forEach(function (el) { io.observe(el); });
})();
