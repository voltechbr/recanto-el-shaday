/* Recanto El Shaday — Acabamento do hero
   Profundidade: o cenário reage ao ponteiro (somente mouse) e à rolagem.
   Tudo via variáveis CSS (--px, --py, --sy, --lx, --ly); sem JS, o hero segue completo. */
(function () {
  'use strict';
  var hero = document.querySelector('.hero');
  if (!hero || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var fine = window.matchMedia('(hover: hover) and (pointer: fine) and (min-width: 1101px)');
  var visible = true, raf = 0;
  var tx = 0, ty = 0, cx = 0, cy = 0, sy = 0;

  function frame() {
    raf = 0;
    cx += (tx - cx) * 0.07; cy += (ty - cy) * 0.07;
    hero.style.setProperty('--px', cx.toFixed(3));
    hero.style.setProperty('--py', cy.toFixed(3));
    hero.style.setProperty('--sy', sy.toFixed(0));
    if (Math.abs(tx - cx) > 0.002 || Math.abs(ty - cy) > 0.002) raf = requestAnimationFrame(frame);
  }
  function kick() { if (visible && !raf) raf = requestAnimationFrame(frame); }

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (e) { visible = e[0].isIntersecting; if (visible) kick(); }, { threshold: 0 }).observe(hero);
  }

  window.addEventListener('scroll', function () {
    sy = Math.min(Math.max(window.pageYOffset, 0), window.innerHeight * 1.1);
    kick();
  }, { passive: true });

  if (fine.matches) {
    hero.addEventListener('pointermove', function (e) {
      if (e.pointerType && e.pointerType !== 'mouse') return;
      var r = hero.getBoundingClientRect();
      var nx = (e.clientX - r.left) / r.width, ny = (e.clientY - r.top) / r.height;
      tx = (nx - 0.5) * 2; ty = (ny - 0.5) * 2;
      hero.style.setProperty('--lx', (nx * 100).toFixed(1) + '%');
      hero.style.setProperty('--ly', (ny * 100).toFixed(1) + '%');
      hero.classList.add('is-lit');
      kick();
    }, { passive: true });
    hero.addEventListener('pointerleave', function () { tx = ty = 0; hero.classList.remove('is-lit'); kick(); });
  }
})();

/* CTA fixo do celular */
(function () {
  var cta = document.querySelector('.m-cta'), c = document.getElementById('contato'), ft = document.querySelector('.site-footer'), hero = document.querySelector('.hero');
  if (!cta || !hero || !('IntersectionObserver' in window)) return;
  var pastHero = false, atContact = false;
  function upd() { cta.classList.toggle('is-on', pastHero && !atContact); }
  new IntersectionObserver(function (e) { pastHero = !e[0].isIntersecting; upd(); }, { threshold: 0.35 }).observe(hero);
  var at = { c: false, f: false };
  function seen(k) { return function (e) { at[k] = e[0].isIntersecting; atContact = at.c || at.f; upd(); }; }
  if (c) new IntersectionObserver(seen('c'), { threshold: 0.15 }).observe(c);
  if (ft) new IntersectionObserver(seen('f'), { threshold: 0.1 }).observe(ft);
})();

/* Fotos ampliáveis: só fotografias (.m-fig e .est__fig); logos e ícones ficam de fora */
(function () {
  var figs = document.querySelectorAll('.m-fig, .est__fig');
  if (!figs.length) return;
  var box = document.createElement('div');
  box.className = 'lb'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', 'Foto ampliada');
  box.innerHTML = '<button class="lb__x" type="button" aria-label="Fechar foto ampliada">&times;</button><figure class="lb__fig"><img class="lb__img" alt=""><figcaption class="lb__cap"></figcaption></figure>';
  document.body.appendChild(box);
  var img = box.querySelector('.lb__img'), cap = box.querySelector('.lb__cap'), x = box.querySelector('.lb__x'), last = null;

  function fit() { // até 2x o tamanho natural: nunca amplia além disso (evita borrar)
    var nw = img.naturalWidth, nh = img.naturalHeight; if (!nw) return;
    var k = Math.min((innerWidth - 32) / nw, (innerHeight - 120) / nh, 2);
    img.style.width = Math.round(nw * k) + 'px'; img.style.height = 'auto';
  }
  function open(f) {
    var im = f.querySelector('img'); if (!im) return;
    last = document.activeElement;
    img.removeAttribute('style'); img.alt = im.alt; img.src = im.currentSrc || im.src;
    var c = f.querySelector('figcaption'); cap.textContent = c ? c.textContent : '';
    if (img.complete) fit(); else img.onload = fit;
    box.classList.add('is-open'); document.documentElement.classList.add('lb-open'); x.focus();
  }
  function close() {
    if (!box.classList.contains('is-open')) return;
    box.classList.remove('is-open'); document.documentElement.classList.remove('lb-open');
    if (last && last.focus) last.focus();
  }
  figs.forEach(function (f) {
    var im = f.querySelector('img'); if (!im) return;
    f.setAttribute('data-zoom', ''); f.setAttribute('tabindex', '0'); f.setAttribute('role', 'button');
    f.setAttribute('aria-label', 'Ampliar foto: ' + (im.alt || ''));
    f.addEventListener('click', function () { open(f); });
    f.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(f); } });
  });
  x.addEventListener('click', close);
  box.addEventListener('click', function (e) { if (e.target === box || e.target === x.parentNode) close(); });
  document.addEventListener('keydown', function (e) {
    if (!box.classList.contains('is-open')) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'Tab') { e.preventDefault(); x.focus(); }   // foco preso no botão fechar
  });
  window.addEventListener('resize', function () { if (box.classList.contains('is-open')) fit(); });
})();
