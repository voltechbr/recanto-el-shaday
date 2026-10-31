/* =========================================================
   Recanto El Shaday — Painel administrativo (/admin)

   Como funciona
   - Login: Supabase Auth (e-mail + senha) pela API REST. Nenhuma biblioteca de terceiros.
   - Dados: só pelas funções do banco admin_*() (supabase/schema.sql). Cada uma confere NO BANCO
     se o usuário logado está em public.administradores; esta tela é só a interface.
   - Chave usada: apenas a pública (js/reservas-config.js). Nada secreto vive aqui.
   - Dados de clientes são sempre inseridos com textContent (nunca innerHTML): um nome malicioso
     enviado pelo formulário público não consegue executar código no painel.
   ========================================================= */
(function () {
  'use strict';

  /* ---------- constantes e utilitários ---------- */
  var MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  var WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
  var STATUS_LABEL = { pendente: 'Pendente', confirmada: 'Aprovada', recusada: 'Recusada', cancelada: 'Cancelada', expirada: 'Expirada' };
  var REFRESH_MS = 60000;
  var MONTHS_BACK = 12, MONTHS_AHEAD = 36;
  var SKEY = 'elshaday-admin-auth';

  var $ = function (id) { return document.getElementById(id); };
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function toISO(y, m, d) { return y + '-' + pad(m) + '-' + pad(d); }
  function parseISO(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '')); if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3], dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return { y: y, m: mo, d: d, wd: dt.getDay() };
  }
  function longDate(iso) { var p = parseISO(iso); return p ? WEEKDAYS[p.wd] + ', ' + p.d + ' de ' + MONTHS[p.m - 1] + ' de ' + p.y : ''; }
  function shortDate(iso) { var p = parseISO(iso); return p ? pad(p.d) + '/' + pad(p.m) + '/' + p.y : ''; }
  function addDaysISO(iso, n) { var p = parseISO(iso), t = new Date(p.y, p.m - 1, p.d + n); return toISO(t.getFullYear(), t.getMonth() + 1, t.getDate()); }
  function addMonths(ym, n) { var t = ym.y * 12 + (ym.m - 1) + n; return { y: Math.floor(t / 12), m: (t % 12) + 1 }; }
  function ymKey(ym) { return ym.y * 12 + ym.m; }
  function daysIn(y, m) { return new Date(y, m, 0).getDate(); }
  function money(c) { var r = Math.floor(Math.abs(c) / 100), k = Math.abs(c) % 100; return 'R$ ' + String(r).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + pad(k); }
  function digits(v) { return String(v == null ? '' : v).replace(/\D+/g, ''); }
  function fmtPhone(v) {
    var d = digits(v); if (d.length > 11 && d.slice(0, 2) === '55') d = d.slice(2);
    if (d.length === 11) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7);
    if (d.length === 10) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 6) + '-' + d.slice(6);
    return String(v || '');
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  /* período: "data" = entrada; cada noite de [data, data_saida) é uma diária (a saída não ocupa a noite).
     Se o banco ainda não foi atualizado para a v5 (sem data_saida), cada reserva vale 1 diária. */
  function saidaDe(r) { return r.data_saida || addDaysISO(r.data, 1); }
  function diariasDe(r) { return r.diarias || 1; }
  function noitesDe(r) { var a = [], n = diariasDe(r), i; for (i = 0; i < n; i++) a.push(addDaysISO(r.data, i)); return a; }
  function periodoTxt(r) { return shortDate(r.data) + ' → ' + shortDate(saidaDe(r)) + ' · ' + plural(diariasDe(r), 'diária', 'diárias'); }
  var dtf = null;
  try { dtf = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (e) { dtf = null; }
  function fmtStamp(iso) { var d = new Date(iso); if (isNaN(d)) return ''; return dtf ? dtf.format(d).replace(',', ' às') : d.toLocaleString('pt-BR'); }
  function ago(iso) {
    var s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (!(s >= 0)) return '';
    if (s < 90) return 'agora há pouco';
    if (s < 3600) return 'há ' + Math.round(s / 60) + ' min';
    if (s < 86400) return 'há ' + Math.round(s / 3600) + ' h';
    return 'há ' + Math.round(s / 86400) + ' dia(s)';
  }

  /* cria elementos sem innerHTML */
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k]; if (v == null || v === false) return;
      if (k === 'text') el.textContent = v;
      else if (k === 'class') el.className = v;
      else if (k === 'on') Object.keys(v).forEach(function (ev) { el.addEventListener(ev, v[ev]); });
      else el.setAttribute(k, v === true ? '' : v);
    });
    (kids || []).forEach(function (c) { if (c == null || c === false) return; el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function setMsg(el, text, kind) { el.textContent = text || ''; el.className = 'ad-msg' + (text ? ' is-' + (kind || 'err') : ''); }

  /* ---------- configuração ---------- */
  var cfg = window.ELSHADAY_SUPABASE || {};
  var BASE = String(cfg.url || '').replace(/\/+$/, '');
  var KEY = String(cfg.anonKey || '');
  var CONFIGURED = /^https:\/\/[^\s\/]+/.test(BASE) && KEY.length >= 20;
  if (/service_role|^sb_secret_/.test(KEY)) { document.body.textContent = 'Chave secreta detectada em js/reservas-config.js. Troque pela chave pública (anon/publishable) e gere uma nova chave secreta no Supabase.'; return; }

  /* ---------- HTTP / autenticação (Supabase Auth via REST) ---------- */
  function HttpError(status, code, message) { this.status = status; this.code = code || ''; this.message = message || ''; }
  HttpError.prototype = Object.create(Error.prototype);

  function headers(token) {
    var hd = { 'Content-Type': 'application/json', 'apikey': KEY };
    if (token) hd.Authorization = 'Bearer ' + token; else if (KEY.indexOf('eyJ') === 0) hd.Authorization = 'Bearer ' + KEY;
    return hd;
  }
  function http(path, o) {
    o = o || {};
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 15000);
    return fetch(BASE + path, {
      method: o.method || 'GET', headers: headers(o.token), cache: 'no-store',
      body: o.body === undefined ? undefined : JSON.stringify(o.body), signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) {
      return r.text().then(function (t) {
        var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = null; }
        if (!r.ok) throw new HttpError(r.status, (j && (j.error_code || j.code)) || '', (j && (j.msg || j.message || j.error_description)) || t || '');
        return j;
      });
    }, function () { throw new HttpError(0, 'rede', 'Sem conexão com o servidor.'); })
      .then(function (v) { clearTimeout(timer); return v; }, function (e) { clearTimeout(timer); throw e; });
  }

  var session = null, persist = false, refreshing = null;
  function readStored() {
    var stores = []; try { stores = [sessionStorage, localStorage]; } catch (e) { return null; }
    for (var i = 0; i < stores.length; i++) {
      try { var v = stores[i].getItem(SKEY); if (v) { var s = JSON.parse(v); if (s && s.access_token && s.refresh_token) return { s: s, persist: stores[i] === localStorage }; } } catch (e) {}
    }
    return null;
  }
  function store() {
    try { sessionStorage.removeItem(SKEY); localStorage.removeItem(SKEY); } catch (e) {}
    if (!session) return;
    try { (persist ? localStorage : sessionStorage).setItem(SKEY, JSON.stringify(session)); } catch (e) {}
  }
  function setSession(r, keep) {
    var exp = r.expires_at || (Math.floor(Date.now() / 1000) + (r.expires_in || 3600));
    session = { access_token: r.access_token, refresh_token: r.refresh_token, expires_at: exp, email: (r.user && r.user.email) || (session && session.email) || '' };
    if (typeof keep === 'boolean') persist = keep;
    store();
  }
  function refreshSession() {
    if (!session) return Promise.reject(new HttpError(401, 'sem_sessao', ''));
    if (!refreshing) {
      refreshing = http('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: session.refresh_token } })
        .then(function (r) { setSession(r); }, function (e) {
          refreshing = null;
          if (e && e.status >= 400 && e.status < 500 && e.status !== 429) forceLogout('Sua sessão expirou. Entre novamente.');
          throw e;
        })
        .then(function () { refreshing = null; });
    }
    return refreshing;
  }
  function rawRpc(name, args) { return http('/rest/v1/rpc/' + name, { method: 'POST', body: args || {}, token: session.access_token }); }
  function rpc(name, args) {
    if (!session) return Promise.reject(new HttpError(401, 'sem_sessao', ''));
    var ready = (session.expires_at - Date.now() / 1000 < 60) ? refreshSession() : Promise.resolve();
    return ready.then(function () { return rawRpc(name, args); }).catch(function (e) {
      if (e && e.status === 401 && session) return refreshSession().then(function () { return rawRpc(name, args); });
      throw e;
    }).catch(function (e) {
      if (e && (e.status === 401 || e.status === 403 || e.code === '42501')) { forceLogout('Sua sessão terminou ou esta conta não tem permissão. Entre novamente.'); }
      throw e;
    });
  }
  function friendlyLoginError(e) {
    if (!e || e.status === 0) return 'Sem conexão. Verifique a internet e tente de novo.';
    if (e.status === 429 || e.code === 'over_request_rate_limit') return 'Muitas tentativas. Aguarde alguns minutos e tente de novo.';
    if (e.status === 400 || e.status === 401 || e.code === 'invalid_credentials') return 'E-mail ou senha incorretos.';
    return 'Não foi possível entrar agora. Tente novamente.';
  }

  /* ---------- estado ---------- */
  var S = {
    reservas: [], bloqueios: [], hoje: '', tab: 'cal',
    cur: { y: 0, m: 0 }, sel: null, solFiltro: 'pendente', confFiltro: 'proximas',
    conf: {}, blk: {}, pend: {}, busy: false, timer: null, loadedAt: null
  };
  function todayISO() {
    if (S.hoje) return S.hoje;
    var t = new Date(); return toISO(t.getFullYear(), t.getMonth() + 1, t.getDate());
  }
  function nowMonth() { var p = parseISO(todayISO()); return { y: p.y, m: p.m }; }

  function indexar() {
    S.conf = {}; S.blk = {}; S.pend = {};
    S.reservas.forEach(function (r) {
      if (r.status === 'confirmada') noitesDe(r).forEach(function (d) { S.conf[d] = r; });
      else if (r.status === 'pendente') noitesDe(r).forEach(function (d) { (S.pend[d] = S.pend[d] || []).push(r); });
    });
    S.bloqueios.forEach(function (b) { S.blk[b.data] = b.motivo || ''; });
  }
  function dayState(iso) {
    if (S.conf[iso]) return 'reservado';
    if (Object.prototype.hasOwnProperty.call(S.blk, iso)) return 'bloqueado';
    return 'livre';
  }

  /* ---------- telas ---------- */
  function showLogin(msg, kind) {
    $('tela-app').hidden = true; $('tela-login').hidden = false;
    clearInterval(S.timer);
    setMsg($('login-msg'), msg || '', kind || 'err');
    $('login-senha').value = '';
    $('login-email').focus();
  }
  function showApp() {
    $('tela-login').hidden = true; $('tela-app').hidden = false;
    $('user-email').textContent = session && session.email || '';
    clearInterval(S.timer);
    S.timer = setInterval(function () { if (!document.hidden && !S.busy && !$('dlg').open) load(true); }, REFRESH_MS);
  }
  function forceLogout(msg) {
    session = null; store(); S.reservas = []; S.bloqueios = [];
    if ($('dlg').open) $('dlg').close();
    showLogin(msg || '', 'err');
  }
  function logout() {
    var tk = session && session.access_token;
    if (tk) { try { http('/auth/v1/logout?scope=local', { method: 'POST', token: tk }).catch(function () {}); } catch (e) {} }
    session = null; store(); S.reservas = []; S.bloqueios = [];
    showLogin('Você saiu do painel.', 'info');
  }

  /* ---------- carregamento ---------- */
  function setBanner(text) { var b = $('banner'); b.textContent = text || ''; b.hidden = !text; }
  function load(silent) {
    return rpc('admin_dados').then(function (d) {
      S.reservas = d.reservas || []; S.bloqueios = d.bloqueios || []; S.hoje = d.hoje || '';
      S.loadedAt = new Date(); indexar(); setBanner('');
      $('upd').textContent = 'Atualizado às ' + pad(S.loadedAt.getHours()) + ':' + pad(S.loadedAt.getMinutes());
      var dm = $('dia-motivo'), keep = dm ? { v: dm.value, f: document.activeElement === dm, d: S.sel } : null;
      renderAll();
      if (keep && keep.d === S.sel && $('dia-motivo')) { $('dia-motivo').value = keep.v; if (keep.f) $('dia-motivo').focus(); }
    }, function (e) {
      if (!session) return;
      setBanner(e && e.status === 0 ? 'Sem conexão: os dados abaixo podem estar desatualizados.' : 'Não foi possível carregar os dados agora. Toque em “Atualizar”.');
      if (!silent) toast('Falha ao carregar os dados.', 'err');
    });
  }

  /* ---------- toast e diálogo ---------- */
  var toastT = null;
  function toast(text, kind) {
    var t = $('toast'); t.textContent = text; t.className = 'ad-toast is-' + (kind || 'ok'); t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(function () { t.hidden = true; }, 5000);
  }
  /* -> Promise<{ok:boolean, motivo:string}> */
  function confirmar(o) {
    return new Promise(function (resolve) {
      var dlg = $('dlg'), ok = $('dlg-ok'), mot = $('dlg-motivo');
      $('dlg-titulo').textContent = o.titulo; $('dlg-texto').textContent = o.texto || '';
      $('dlg-motivo-wrap').hidden = !o.motivo; $('dlg-motivo-lbl').textContent = o.motivo || ''; mot.value = '';
      ok.textContent = o.botao || 'Confirmar'; ok.className = 'ad-btn ' + (o.perigo ? 'ad-btn--danger' : 'ad-btn--primary');
      var done = false;
      function fin(v) {
        if (done) return; done = true;
        $('dlg-form').removeEventListener('submit', onSubmit); $('dlg-cancelar').removeEventListener('click', onCancel); dlg.removeEventListener('close', onClose);
        var motivo = mot.value; if (dlg.open) dlg.close();
        resolve({ ok: v, motivo: motivo });
      }
      function onSubmit(e) { e.preventDefault(); fin(true); }
      function onCancel() { fin(false); }
      function onClose() { fin(false); }
      $('dlg-form').addEventListener('submit', onSubmit); $('dlg-cancelar').addEventListener('click', onCancel); dlg.addEventListener('close', onClose);
      dlg.showModal(); (o.motivo ? mot : $('dlg-cancelar')).focus();
    });
  }

  /* ---------- ações (todas passam pelo banco) ---------- */
  function run(btn, fn) {
    if (S.busy) return Promise.resolve();
    S.busy = true; if (btn) btn.disabled = true;
    return fn().then(function (v) { S.busy = false; if (btn) btn.disabled = false; return v; }, function (e) {
      S.busy = false; if (btn) btn.disabled = false;
      if (session) toast(e && e.status === 0 ? 'Sem conexão. Nada foi alterado — tente de novo.' : 'Não foi possível concluir a ação. Atualize e confira.', 'err');
    });
  }
  function result(res, okMsg) {
    var ok = !!(res && res.ok);
    toast(ok ? okMsg : ((res && res.mensagem) || 'Não foi possível concluir a ação.'), ok ? 'ok' : 'err');
    return load(true).then(function () { return ok; });
  }
  function aprovar(r, btn) {
    return confirmar({
      titulo: 'Aprovar esta reserva?',
      texto: r.nome + ' — ' + periodoTxt(r) + '. Todas as noites do período ficarão indisponíveis no site (a data de saída continua livre).',
      botao: 'Aprovar reserva'
    }).then(function (c) {
      if (!c.ok) return;
      return run(btn, function () { return rpc('admin_aprovar_reserva', { p_id: r.id }).then(function (res) { return result(res, 'Reserva aprovada. As noites do período já estão bloqueadas no site.'); }); });
    });
  }
  function recusar(r, btn) {
    return confirmar({
      titulo: 'Recusar esta solicitação?', texto: r.nome + ' — ' + periodoTxt(r) + '. O calendário do site não muda.',
      motivo: 'Motivo (opcional, só você vê)', botao: 'Recusar solicitação', perigo: true
    }).then(function (c) {
      if (!c.ok) return;
      return run(btn, function () { return rpc('admin_recusar_reserva', { p_id: r.id, p_motivo: c.motivo || null }).then(function (res) { return result(res, 'Solicitação recusada.'); }); });
    });
  }
  function cancelar(r, btn) {
    return confirmar({
      titulo: 'Cancelar a reserva aprovada?', texto: r.nome + ' — ' + periodoTxt(r) + '. Todas as noites do período voltarão a ficar disponíveis no site.',
      motivo: 'Motivo (opcional, só você vê)', botao: 'Cancelar reserva', perigo: true
    }).then(function (c) {
      if (!c.ok) return;
      return run(btn, function () { return rpc('admin_cancelar_reserva', { p_id: r.id, p_motivo: c.motivo || null }).then(function (res) { return result(res, 'Reserva cancelada. As noites do período estão livres de novo.'); }); });
    });
  }
  function bloquear(datas, motivo, btn, texto) {
    return run(btn, function () { return rpc('admin_bloquear_datas', { p_datas: datas, p_motivo: motivo || null }).then(function (res) { return result(res, texto); }); });
  }
  function liberar(datas, btn, texto) {
    return run(btn, function () { return rpc('admin_liberar_datas', { p_datas: datas }).then(function (res) { return result(res, texto); }); });
  }

  /* ---------- componentes ---------- */
  function badge(status) { return h('span', { class: 'ad-badge ad-badge--' + status, text: STATUS_LABEL[status] || status }); }
  function waLink(r) {
    var d = digits(r.telefone); if (d.length === 10 || d.length === 11) d = '55' + d;
    var first = String(r.nome || '').split(' ')[0];
    var msg = 'Olá, ' + first + '! Aqui é da Chácara Recanto El Shaday. Recebemos sua solicitação de reserva para ' + longDate(r.data) + '.';
    return 'https://wa.me/' + d + '?text=' + encodeURIComponent(msg);
  }
  function conflitoDe(r) {
    if (r.status === 'confirmada' || r.status === 'cancelada') return null;
    if (r.data < todayISO()) return 'A entrada já passou.';
    var noites = noitesDe(r), i;
    for (i = 0; i < noites.length; i++) if (dayState(noites[i]) === 'bloqueado') return 'Há data bloqueada manualmente dentro do período (' + shortDate(noites[i]) + '). Libere o bloqueio no calendário para poder aprovar.';
    for (i = 0; i < noites.length; i++) if (S.conf[noites[i]] && S.conf[noites[i]].id !== r.id) return 'Este período inclui noites já reservadas para outro cliente (' + S.conf[noites[i]].nome + ').';
    return null;
  }
  function row(k, v) { return h('div', { class: 'ad-kv' }, [h('dt', { text: k }), h('dd', {}, [v])]); }
  function txt(s) { return document.createTextNode(s); }

  function card(r) {
    var conf = conflitoDe(r);
    var outras = (r.status === 'pendente' && S.pend[r.data] && S.pend[r.data].length > 1) ? S.pend[r.data].length - 1 : 0;
    var tel = digits(r.telefone);
    var emailOk = r.email && /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(r.email);
    var acts = [];
    if (r.status === 'pendente' || r.status === 'recusada' || r.status === 'expirada') {
      var bA = h('button', { type: 'button', class: 'ad-btn ad-btn--primary ad-btn--sm', text: r.status === 'pendente' ? 'Aprovar' : 'Aprovar mesmo assim' });
      if (conf) { bA.disabled = true; bA.title = conf; } else bA.addEventListener('click', function () { aprovar(r, bA); });
      acts.push(bA);
    }
    if (r.status === 'pendente') {
      var bR = h('button', { type: 'button', class: 'ad-btn ad-btn--ghost ad-btn--sm', text: 'Recusar' });
      bR.addEventListener('click', function () { recusar(r, bR); }); acts.push(bR);
    }
    if (r.status === 'confirmada') {
      var bC = h('button', { type: 'button', class: 'ad-btn ad-btn--ghost ad-btn--sm ad-danger', text: 'Cancelar reserva' });
      bC.addEventListener('click', function () { cancelar(r, bC); }); acts.push(bC);
    }
    if (tel.length >= 10) acts.push(h('a', { class: 'ad-btn ad-btn--wa ad-btn--sm', href: waLink(r), target: '_blank', rel: 'noopener noreferrer', text: 'WhatsApp' }));

    return h('article', { class: 'ad-card ad-card--' + r.status }, [
      h('header', { class: 'ad-card__head' }, [
        h('div', {}, [h('p', { class: 'ad-card__date', text: periodoTxt(r) }), h('h3', { class: 'ad-card__name', text: r.nome })]),
        badge(r.status)
      ]),
      h('dl', { class: 'ad-kvs' }, [
        row('Entrada', txt(longDate(r.data))),
        row('Saída', txt(longDate(saidaDe(r)))),
        row('Diárias', h('strong', { text: String(diariasDe(r)) })),
        row('Telefone', tel.length >= 10 ? h('a', { href: 'tel:+55' + (tel.length > 11 ? tel.slice(2) : tel), text: fmtPhone(r.telefone) }) : txt(r.telefone || '—')),
        row('E-mail', emailOk ? h('a', { href: 'mailto:' + r.email, text: r.email }) : txt(r.email || '—')),
        row('Pessoas', txt(plural(r.adultos, 'adulto', 'adultos') + ' · ' + plural(r.criancas, 'criança', 'crianças'))),
        row('Taxa de limpeza', txt(r.taxa_limpeza ? 'Sim · ' + money(r.valor_limpeza) : 'Não')),
        row('Valor total', h('span', {}, [h('strong', { text: money(r.valor_total) }), txt(' (' + diariasDe(r) + ' × ' + money(r.valor_diaria || 85000) + (r.taxa_limpeza ? ' + limpeza ' + money(r.valor_limpeza) : '') + ')')])),
        row('Recebida', txt(fmtStamp(r.criada_em) + ' (' + ago(r.criada_em) + ')'))
      ]),
      outras ? h('p', { class: 'ad-flag ad-flag--info', text: 'Há ' + plural(outras, 'outra solicitação pendente', 'outras solicitações pendentes') + ' para esta data. Ao aprovar uma, as demais precisarão ser recusadas.' }) : null,
      conf ? h('p', { class: 'ad-flag ad-flag--warn', text: conf }) : null,
      r.observacao_interna ? h('p', { class: 'ad-card__note', text: 'Notas: ' + r.observacao_interna }) : null,
      acts.length ? h('div', { class: 'ad-card__act' }, acts) : null
    ]);
  }
  function empty(text) { return h('p', { class: 'ad-empty', text: text }); }
  function matchBusca(r, q) {
    q = String(q || '').trim().toLowerCase(); if (!q) return true;
    var qd = digits(q);
    return String(r.nome).toLowerCase().indexOf(q) >= 0 || (qd && digits(r.telefone).indexOf(qd) >= 0) || String(r.email || '').toLowerCase().indexOf(q) >= 0;
  }

  /* ---------- calendário ---------- */
  function renderMonthSelect() {
    var sel = $('cal-mes'), base = nowMonth(); clear(sel);
    for (var i = -MONTHS_BACK; i <= MONTHS_AHEAD; i++) {
      var ym = addMonths(base, i);
      sel.appendChild(h('option', { value: ym.y + '-' + pad(ym.m), text: MONTHS[ym.m - 1].charAt(0).toUpperCase() + MONTHS[ym.m - 1].slice(1) + ' de ' + ym.y }));
    }
    sel.value = S.cur.y + '-' + pad(S.cur.m);
  }
  function renderCalendar() {
    var y = S.cur.y, m = S.cur.m, today = todayISO(), grid = $('cal-grid'); clear(grid);
    renderMonthSelect();
    var first = new Date(y, m - 1, 1).getDay(), n = daysIn(y, m), i;
    var nRes = 0, nBlq = 0, nPend = 0, pendIds = {};
    for (i = 0; i < first; i++) grid.appendChild(h('span', { class: 'ad-day ad-day--blank', 'aria-hidden': 'true' }));
    var tabIso = (S.sel && S.sel.slice(0, 7) === y + '-' + pad(m)) ? S.sel : (today.slice(0, 7) === y + '-' + pad(m) ? today : toISO(y, m, 1));
    for (i = 1; i <= n; i++) {
      var iso = toISO(y, m, i), st = dayState(iso), past = iso < today, np = (S.pend[iso] || []).length;
      if (st === 'reservado') nRes++; else if (st === 'bloqueado') nBlq++;
      if (!past) (S.pend[iso] || []).forEach(function (r) { pendIds[r.id] = 1; });
      var label = longDate(iso) + ', ' + (st === 'reservado' ? 'reservado para ' + S.conf[iso].nome : st === 'bloqueado' ? 'bloqueado' + (S.blk[iso] ? ': ' + S.blk[iso] : '') : 'disponível') +
        (np ? ', ' + plural(np, 'solicitação pendente', 'solicitações pendentes') : '') + (past ? ', data passada' : '');
      var b = h('button', {
        type: 'button', class: 'ad-day ad-day--' + st + (past ? ' is-past' : '') + (iso === today ? ' is-today' : '') + (iso === S.sel ? ' is-sel' : ''),
        'data-iso': iso, 'aria-label': label, 'aria-pressed': iso === S.sel ? 'true' : 'false', tabindex: iso === tabIso ? '0' : '-1'
      }, [h('span', { class: 'ad-day__n', text: String(i) }), np ? h('span', { class: 'ad-day__pend', 'aria-hidden': 'true', text: String(np) }) : null]);
      grid.appendChild(b);
    }
    nPend = Object.keys(pendIds).length;
    $('cal-resumo').textContent = nRes + ' noite(s) reservada(s) · ' + nBlq + ' bloqueado(s)' + (nPend ? ' · ' + plural(nPend, 'solicitação pendente', 'solicitações pendentes') : '') + ' neste mês';
    $('cal-prev').disabled = ymKey(S.cur) <= ymKey(addMonths(nowMonth(), -MONTHS_BACK));
    $('cal-next').disabled = ymKey(S.cur) >= ymKey(addMonths(nowMonth(), MONTHS_AHEAD));
  }
  function renderDayPanel() {
    var box = $('dia-painel'); clear(box);
    if (!S.sel) { box.appendChild(h('div', { class: 'ad-dia' }, [h('p', { class: 'ad-empty', text: 'Toque em um dia do calendário para ver detalhes, bloquear ou liberar a data.' })])); return; }
    var iso = S.sel, st = dayState(iso), past = iso < todayISO(), wrap = h('div', { class: 'ad-dia' });
    var stLabel = st === 'reservado' ? 'Reservado (aprovado)' : st === 'bloqueado' ? 'Bloqueado' : 'Disponível';
    wrap.appendChild(h('header', { class: 'ad-dia__head' }, [h('h2', { text: longDate(iso) }), h('span', { class: 'ad-badge ad-badge--st-' + st, text: stLabel + (past ? ' · passada' : '') })]));

    if (st === 'reservado') {
      wrap.appendChild(card(S.conf[iso]));
      if (Object.prototype.hasOwnProperty.call(S.blk, iso)) wrap.appendChild(h('p', { class: 'ad-flag ad-flag--warn', text: 'Esta data também tem um bloqueio manual antigo. Cancele a reserva e libere o bloqueio se quiser reabrir a data.' }));
    } else if (st === 'bloqueado') {
      wrap.appendChild(h('p', { class: 'ad-dia__txt', text: S.blk[iso] ? 'Motivo: ' + S.blk[iso] : 'Bloqueada manualmente, sem motivo informado.' }));
      var bl = h('button', { type: 'button', class: 'ad-btn ad-btn--primary', text: 'Liberar data' });
      bl.addEventListener('click', function () { liberar([iso], bl, 'Data liberada. Já aparece como disponível no site.'); });
      wrap.appendChild(bl);
    } else if (!past) {
      var inp = h('input', { type: 'text', id: 'dia-motivo', maxlength: '200', placeholder: 'Ex.: manutenção, uso da família' });
      var bb = h('button', { type: 'button', class: 'ad-btn ad-btn--primary', text: 'Bloquear data' });
      bb.addEventListener('click', function () { bloquear([iso], inp.value, bb, 'Data bloqueada. Já aparece como indisponível no site.'); });
      wrap.appendChild(h('div', { class: 'ad-field' }, [h('label', { for: 'dia-motivo', text: 'Motivo do bloqueio (opcional)' }), inp]));
      wrap.appendChild(bb);
    } else {
      wrap.appendChild(h('p', { class: 'ad-dia__txt', text: 'Data passada: sem ações disponíveis.' }));
    }

    var pends = (S.pend[iso] || []);
    if (pends.length) {
      wrap.appendChild(h('h3', { class: 'ad-dia__sub', text: plural(pends.length, 'solicitação pendente', 'solicitações pendentes') + ' para este dia' }));
      pends.forEach(function (r) { wrap.appendChild(card(r)); });
    }
    var outras = S.reservas.filter(function (r) { return noitesDe(r).indexOf(iso) >= 0 && r.status !== 'pendente' && r.status !== 'confirmada'; });
    if (outras.length) {
      wrap.appendChild(h('h3', { class: 'ad-dia__sub', text: 'Histórico deste dia' }));
      outras.forEach(function (r) { wrap.appendChild(card(r)); });
    }
    box.appendChild(wrap);
  }
  function selectDay(iso, focus) {
    S.sel = iso; var p = parseISO(iso);
    if (p && (p.y !== S.cur.y || p.m !== S.cur.m)) S.cur = { y: p.y, m: p.m };
    renderCalendar(); renderDayPanel();
    if (focus) { var b = $('cal-grid').querySelector('[data-iso="' + iso + '"]'); if (b) b.focus(); }
  }
  function goMonth(ym) {
    var lo = ymKey(addMonths(nowMonth(), -MONTHS_BACK)), hi = ymKey(addMonths(nowMonth(), MONTHS_AHEAD));
    if (ymKey(ym) < lo || ymKey(ym) > hi) return;
    S.cur = { y: ym.y, m: ym.m }; renderCalendar();
  }

  /* ---------- listas ---------- */
  function chips(boxId, opts, cur, onPick) {
    var box = $(boxId); clear(box);
    opts.forEach(function (o) {
      var b = h('button', { type: 'button', class: 'ad-chip' + (o.id === cur ? ' is-on' : ''), 'aria-pressed': o.id === cur ? 'true' : 'false' }, [o.label + (o.n != null ? ' ' : ''), o.n != null ? h('span', { class: 'ad-chip__n', text: String(o.n) }) : null]);
      b.addEventListener('click', function () { onPick(o.id); }); box.appendChild(b);
    });
  }
  function renderSolicitacoes() {
    var hoje = todayISO(), q = $('sol-busca').value;
    var cnt = function (f) { return S.reservas.filter(f).length; };
    chips('sol-filtros', [
      { id: 'pendente', label: 'Pendentes', n: cnt(function (r) { return r.status === 'pendente'; }) },
      { id: 'recusada', label: 'Recusadas', n: cnt(function (r) { return r.status === 'recusada'; }) },
      { id: 'outras', label: 'Canceladas/expiradas', n: cnt(function (r) { return r.status === 'cancelada' || r.status === 'expirada'; }) },
      { id: 'todas', label: 'Todas', n: S.reservas.length }
    ], S.solFiltro, function (id) { S.solFiltro = id; renderSolicitacoes(); });
    var list = S.reservas.filter(function (r) {
      if (S.solFiltro === 'pendente') return r.status === 'pendente';
      if (S.solFiltro === 'recusada') return r.status === 'recusada';
      if (S.solFiltro === 'outras') return r.status === 'cancelada' || r.status === 'expirada';
      return true;
    }).filter(function (r) { return matchBusca(r, q); });
    list.sort(function (a, b) {                                 // pendentes: data do evento mais próxima primeiro; histórico: mais recente primeiro
      if (S.solFiltro === 'pendente') { var pa = a.data < hoje, pb = b.data < hoje; if (pa !== pb) return pa ? 1 : -1; return a.data < b.data ? -1 : a.data > b.data ? 1 : (a.criada_em < b.criada_em ? -1 : 1); }
      return a.atualizada_em < b.atualizada_em ? 1 : -1;
    });
    var box = $('sol-lista'); clear(box);
    if (!list.length) { box.appendChild(empty(S.solFiltro === 'pendente' ? 'Nenhuma solicitação pendente. Quando um cliente enviar o formulário, ela aparece aqui.' : 'Nada por aqui.')); return; }
    list.forEach(function (r) { box.appendChild(card(r)); });
  }
  function renderConfirmadas() {
    var hoje = todayISO(), q = $('conf-busca').value;
    var all = S.reservas.filter(function (r) { return r.status === 'confirmada'; });
    chips('conf-filtros', [
      { id: 'proximas', label: 'Próximas', n: all.filter(function (r) { return r.data >= hoje; }).length },
      { id: 'passadas', label: 'Passadas', n: all.filter(function (r) { return r.data < hoje; }).length }
    ], S.confFiltro, function (id) { S.confFiltro = id; renderConfirmadas(); });
    var list = all.filter(function (r) { return S.confFiltro === 'proximas' ? r.data >= hoje : r.data < hoje; }).filter(function (r) { return matchBusca(r, q); });
    list.sort(function (a, b) { return S.confFiltro === 'proximas' ? (a.data < b.data ? -1 : 1) : (a.data < b.data ? 1 : -1); });
    var box = $('conf-lista'); clear(box);
    if (!list.length) { box.appendChild(empty(S.confFiltro === 'proximas' ? 'Nenhuma reserva aprovada para as próximas datas.' : 'Nenhuma reserva passada.')); return; }
    list.forEach(function (r) { box.appendChild(card(r)); });
  }
  function renderBadge() {
    var n = S.reservas.filter(function (r) { return r.status === 'pendente' && r.data >= todayISO(); }).length, c = $('cnt-sol');
    c.textContent = String(n); c.hidden = n === 0; c.setAttribute('aria-label', n + ' pendentes');
  }
  function renderAll() {
    if (!S.cur.y) S.cur = nowMonth();
    if (!S.sel) S.sel = todayISO();
    renderBadge(); renderCalendar(); renderDayPanel(); renderSolicitacoes(); renderConfirmadas();
  }

  /* ---------- abas ---------- */
  function setTab(id) {
    S.tab = id;
    ['cal', 'sol', 'conf'].forEach(function (t) {
      var on = t === id, tab = $('tab-' + t);
      tab.setAttribute('aria-selected', on ? 'true' : 'false'); tab.tabIndex = on ? 0 : -1; $('pan-' + t).hidden = !on;
    });
  }

  /* ---------- eventos ---------- */
  function bind() {
    $('form-login').addEventListener('submit', function (e) {
      e.preventDefault();
      var email = $('login-email').value.trim(), pw = $('login-senha').value, btn = $('btn-entrar');
      if (!email || !pw) { setMsg($('login-msg'), 'Informe o e-mail e a senha.'); return; }
      if (!CONFIGURED) { setMsg($('login-msg'), 'O site ainda não está ligado ao Supabase (js/reservas-config.js).'); return; }
      btn.disabled = true; btn.textContent = 'Entrando…'; setMsg($('login-msg'), '');
      var etapa = 'senha';
      http('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: email, password: pw } }).then(function (r) {
        etapa = 'permissao';
        setSession(r, $('login-manter').checked);
        return rpc('eh_admin').then(function (ok) {
          if (ok !== true) { return http('/auth/v1/logout?scope=local', { method: 'POST', token: session.access_token }).catch(function () {}).then(function () { session = null; store(); throw new HttpError(403, 'nao_admin', ''); }); }
        });
      }).then(function () {
        $('login-senha').value = ''; showApp(); S.cur = { y: 0, m: 0 }; S.sel = null; return load();
      }).catch(function (e) {
        if (e && e.code === 'nao_admin') setMsg($('login-msg'), 'Esta conta não tem permissão de administrador.');
        else if (etapa === 'senha') setMsg($('login-msg'), friendlyLoginError(e));
        else setMsg($('login-msg'), 'Não foi possível validar o acesso agora. Tente novamente.');
      }).then(function () { btn.disabled = false; btn.textContent = 'Entrar'; });
    });
    $('btn-ver-senha').addEventListener('click', function () {
      var i = $('login-senha'), show = i.type === 'password'; i.type = show ? 'text' : 'password';
      this.textContent = show ? 'Ocultar' : 'Mostrar'; this.setAttribute('aria-pressed', show ? 'true' : 'false'); this.setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha');
    });
    $('btn-sair').addEventListener('click', logout);
    $('btn-atualizar').addEventListener('click', function () { var b = this; b.disabled = true; load(false).then(function () { b.disabled = false; toast('Dados atualizados.', 'ok'); }); });

    var tabs = document.querySelectorAll('[data-tab]');
    Array.prototype.forEach.call(tabs, function (t, i) {
      t.addEventListener('click', function () { setTab(t.getAttribute('data-tab')); });
      t.addEventListener('keydown', function (e) {
        var k = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0; if (!k) return;
        e.preventDefault(); var n = tabs[(i + k + tabs.length) % tabs.length]; setTab(n.getAttribute('data-tab')); n.focus();
      });
    });

    $('cal-prev').addEventListener('click', function () { goMonth(addMonths(S.cur, -1)); });
    $('cal-next').addEventListener('click', function () { goMonth(addMonths(S.cur, 1)); });
    $('cal-hoje').addEventListener('click', function () { S.cur = nowMonth(); selectDay(todayISO()); });
    $('cal-mes').addEventListener('change', function () { var p = this.value.split('-'); goMonth({ y: +p[0], m: +p[1] }); });
    $('cal-grid').addEventListener('click', function (e) { var b = e.target.closest ? e.target.closest('.ad-day[data-iso]') : null; if (b) selectDay(b.getAttribute('data-iso'), true); });
    $('cal-grid').addEventListener('keydown', function (e) {
      var b = e.target.closest ? e.target.closest('.ad-day[data-iso]') : null; if (!b) return;
      var step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' ? -7 : e.key === 'ArrowDown' ? 7 : 0;
      if (!step) return; e.preventDefault();
      var iso = addDaysISO(b.getAttribute('data-iso'), step), p = parseISO(iso), ym = { y: p.y, m: p.m };
      if (ymKey(ym) < ymKey(addMonths(nowMonth(), -MONTHS_BACK)) || ymKey(ym) > ymKey(addMonths(nowMonth(), MONTHS_AHEAD))) return;
      selectDay(iso, true);
    });

    $('form-periodo').addEventListener('submit', function (e) {
      e.preventDefault();
      var de = $('per-de').value, ate = $('per-ate').value, msg = $('per-msg'), btn = e.submitter || this.querySelector('button[type=submit]');
      if (!parseISO(de) || !parseISO(ate)) { setMsg(msg, 'Informe as duas datas.'); return; }
      if (ate < de) { setMsg(msg, 'A data final deve ser igual ou depois da inicial.'); return; }
      if (de < todayISO()) { setMsg(msg, 'Não é possível bloquear datas que já passaram.'); return; }
      var datas = [], d = de; while (d <= ate && datas.length <= 400) { datas.push(d); d = addDaysISO(d, 1); }
      if (datas.length > 400) { setMsg(msg, 'Escolha no máximo 400 dias de uma vez.'); return; }
      setMsg(msg, '');
      confirmar({ titulo: 'Bloquear ' + plural(datas.length, 'data', 'datas') + '?', texto: 'De ' + shortDate(de) + ' até ' + shortDate(ate) + '. Ficarão indisponíveis no site. Se houver reserva aprovada no período, nada será bloqueado.', botao: 'Bloquear período' })
        .then(function (c) {
          if (!c.ok) return;
          return bloquear(datas, $('per-motivo').value, btn, datas.length + ' data(s) bloqueada(s).').then(function (ok) { if (ok) $('form-periodo').reset(); });
        });
    });

    $('sol-busca').addEventListener('input', renderSolicitacoes);
    $('conf-busca').addEventListener('input', renderConfirmadas);
    document.addEventListener('visibilitychange', function () { if (!document.hidden && session && !S.busy && !$('dlg').open) load(true); });
    window.addEventListener('online', function () { if (session) load(true); });
  }

  /* ---------- início ---------- */
  bind();
  if (!CONFIGURED) { showLogin('O site ainda não está ligado ao Supabase (js/reservas-config.js).', 'err'); return; }
  var stored = readStored();
  if (stored) {
    session = stored.s; persist = stored.persist;
    var pre = (session.expires_at - Date.now() / 1000 < 60) ? refreshSession() : Promise.resolve();
    pre.then(function () { return rpc('eh_admin'); }).then(function (ok) {
      if (ok !== true) { forceLogout('Esta conta não tem permissão de administrador.'); return; }
      showApp(); return load();
    }).catch(function () { if (session) forceLogout('Entre novamente para continuar.'); else showLogin('', 'err'); });
  } else {
    showLogin('', 'err');
  }
})();
