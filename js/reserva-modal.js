/* =========================================================
   Recanto El Shaday — Sistema de reservas (v2: banco compartilhado + WhatsApp)

   Estrutura do arquivo:
     1) CONFIG    — preço, taxa, limites, WhatsApp, datas bloqueadas à mão
     2) utilitários de data, dinheiro e telefone (puros, sem DOM)
     3) validate() / validateContact() — regras (puras, sem DOM)
     4) Store     — Supabase via RPC (js/reservas-config.js + supabase/schema.sql)
     5) UI        — modal, calendário, campos, revisão, WhatsApp

   Fluxo: calendário -> revisão + contato -> "Confirmar pelo WhatsApp":
     re-verifica a data -> grava uma SOLICITAÇÃO PENDENTE no banco -> abre o WhatsApp.
   Período: o visitante escolhe ENTRADA e SAÍDA (a saída não é cobrada; cada noite é uma diária, de 1 a 30).
   A entrada precisa ter pelo menos 24 h de antecedência (início às 10h, horário de Brasília) — o banco também confere.
   A solicitação pendente NÃO bloqueia a data: só a aprovação do administrador (painel /admin)
   ou um bloqueio manual tornam a data indisponível no calendário.
   Se o registro falhar, o WhatsApp NÃO é aberto.
   ========================================================= */
(function () {
  'use strict';

  /* ---------- 1) CONFIG ---------- */
  var CONFIG = {
    pricePerDayCents: 85000,        // diária: R$ 850,00
    cleaningFeeCents: 15000,        // taxa de limpeza opcional: R$ 150,00
    maxMonthsAhead: 24,             // até quantos meses à frente o calendário navega
    minAdults: 1,
    maxGuests: 100,                 // capacidade confortável da área externa (adultos + crianças)
    childMaxAge: 12,
    minNoticeHours: 24,             // antecedência mínima em relação ao início da estadia
    checkInHour: 10,                // a estadia começa às 10h (horário de Brasília)
    maxNights: 30,                  // máximo de diárias por reserva (o banco confere o mesmo limite)
    hours: '10h às 23h',
    requestTimeoutMs: 10000,        // tempo máximo de espera pelo banco
    refreshMs: 45000,               // com o modal aberto, relê as datas a cada 45 s
    whatsapp: '5542988437189',
    /* Datas que o proprietário quer bloquear à mão (aparecem como indisponíveis).
       Formato 'AAAA-MM-DD'. Ex.: ['2026-12-24', '2026-12-25', '2026-12-31'] */
    blockedDates: []
  };

  var MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  var WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

  /* ---------- 2) Utilitários ---------- */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function toISO(y, m, d) { return y + '-' + pad(m) + '-' + pad(d); }          // m: 1–12
  function todayISO() { var t = new Date(); return toISO(t.getFullYear(), t.getMonth() + 1, t.getDate()); } // data LOCAL (não UTC)
  function parseISO(iso) {                                                       // null se inválida
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3], dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return { y: y, m: mo, d: d, wd: dt.getDay() };
  }
  function longDate(iso) {
    var p = parseISO(iso); if (!p) return '';
    return WEEKDAYS[p.wd] + ', ' + p.d + ' de ' + MONTHS[p.m - 1] + ' de ' + p.y;
  }
  function addMonths(ym, n) { var t = ym.y * 12 + (ym.m - 1) + n; return { y: Math.floor(t / 12), m: (t % 12) + 1 }; }
  function daysIn(y, m) { return new Date(y, m, 0).getDate(); }
  function addDaysISO(iso, n) { var p = parseISO(iso), t = new Date(p.y, p.m - 1, p.d + n); return toISO(t.getFullYear(), t.getMonth() + 1, t.getDate()); }
  function nightsBetween(a, b) {                                                 // diárias = saída - entrada (a saída não conta)
    var pa = parseISO(a), pb = parseISO(b);
    return (pa && pb) ? Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86400000) : NaN;
  }
  /* Início da estadia = entrada às 10h de Brasília (UTC-3, sem horário de verão desde 2019). Independe do fuso do aparelho.
     O banco refaz a conta com o fuso America/Sao_Paulo: o que vale é a validação dele. */
  function tooSoon(iso) { return Date.parse(iso + 'T' + pad(CONFIG.checkInHour) + ':00:00-03:00') - Date.now() < CONFIG.minNoticeHours * 3600000; }
  var NOTICE_MSG = 'As reservas precisam ser feitas com pelo menos 24 horas de antecedência em relação à entrada (a partir das 10h). Escolha uma entrada mais adiante.';
  function firstBusyNight(inISO, outISO, set) {                                  // primeira noite de [entrada, saída) indisponível
    if (!set || !parseISO(inISO) || !parseISO(outISO)) return null;
    for (var d = inISO, i = 0; d < outISO && i <= CONFIG.maxNights + 1; d = addDaysISO(d, 1), i++) if (set.has(d)) return d;
    return null;
  }
  function nightsText(n) { return n + (n === 1 ? ' diária' : ' diárias'); }
  function money(cents) {                                                        // 85000 -> "R$ 850,00"
    var neg = cents < 0; cents = Math.abs(Math.round(cents));
    var r = Math.floor(cents / 100), c = cents % 100;
    return (neg ? '-' : '') + 'R$ ' + String(r).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + pad(c);
  }
  function totals(cleaning, nights) {                                            // diárias x R$ 850 + limpeza UMA vez
    var n = (typeof nights === 'number' && nights >= 1) ? Math.floor(nights) : 1, fee = cleaning ? CONFIG.cleaningFeeCents : 0, days = CONFIG.pricePerDayCents * n;
    return { nights: n, unit: CONFIG.pricePerDayCents, daily: days, cleaning: fee, total: days + fee };
  }
  function isWhole(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; }

  /* ---------- 3) Validação (pura) ---------- */
  /* b: { date (entrada), out (saída; sem ela = 1 diária), adults, children, cleaning } · unavailable: Set de 'AAAA-MM-DD' (noites) */
  function validate(b, unavailable) {
    var errors = [], bad = {};
    var out = b.out || (parseISO(b.date) ? addDaysISO(b.date, 1) : null), n = nightsBetween(b.date, out);
    if (!b.date) {
      errors.push('Escolha a data de entrada no calendário para continuar.');
    } else if (!parseISO(b.date)) {
      errors.push('A data selecionada não é válida. Escolha outra data.');
    } else if (b.date < todayISO()) {
      errors.push('Essa data já passou. Escolha uma data a partir de hoje.');
    } else if (tooSoon(b.date)) {
      errors.push(NOTICE_MSG);
    } else if (!(n >= 1)) {
      errors.push('A data de saída deve ser depois da entrada.');
    } else if (n > CONFIG.maxNights) {
      errors.push('O máximo é de ' + CONFIG.maxNights + ' diárias por reserva.');
    } else if (unavailable) {
      var busy = firstBusyNight(b.date, out, unavailable);
      if (busy === b.date) errors.push('Essa data está indisponível. Escolha outra data.');
      else if (busy) errors.push('O período escolhido inclui datas indisponíveis. Escolha outro período.');
    }
    if (!isWhole(b.adults) || b.adults < CONFIG.minAdults || b.adults > CONFIG.maxGuests) {
      errors.push('Informe de ' + CONFIG.minAdults + ' a ' + CONFIG.maxGuests + ' adultos.'); bad.adults = true;
    }
    if (!isWhole(b.children) || b.children < 0 || b.children > CONFIG.maxGuests) {
      errors.push('Informe a quantidade de crianças (0 ou mais).'); bad.children = true;
    }
    if (!bad.adults && !bad.children && b.adults + b.children > CONFIG.maxGuests) {
      errors.push('A capacidade confortável é de até ' + CONFIG.maxGuests + ' pessoas (adultos + crianças).');
      bad.adults = bad.children = true;
    }
    return { ok: errors.length === 0, errors: errors, bad: bad };
  }

  /* ---------- 3b) Validação dos dados de contato (pura) ---------- */
  function onlyDigits(v) { return String(v == null ? '' : v).replace(/\D+/g, ''); }
  function phoneLocalDigits(v) {                       // tira o DDI 55 quando vier junto: 5542988437189 -> 42988437189
    var d = onlyDigits(v);
    if ((d.length === 12 || d.length === 13) && d.slice(0, 2) === '55') d = d.slice(2);
    return d;
  }
  function formatPhone(v) {                            // 42988437189 -> (42) 98843-7189
    var d = phoneLocalDigits(v).slice(0, 11), out = '';
    if (!d) return '';
    out = '(' + d.slice(0, 2);
    if (d.length > 2) out += ') ' + d.slice(2, d.length > 10 ? 7 : 6);
    if (d.length > (d.length > 10 ? 7 : 6)) out += '-' + d.slice(d.length > 10 ? 7 : 6);
    return out;
  }
  var NAME_RE = /^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'’.\-]*$/;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  /* c: { name, phone, email } (texto bruto dos campos) */
  function validateContact(c) {
    var errors = {}, name = String(c.name || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    var phone = phoneLocalDigits(c.phone), email = String(c.email || '').trim();
    var words = name ? name.split(' ') : [];
    if (!name) errors.name = 'Informe seu nome completo.';
    else if (words.length < 2 || words.some(function (w) { return !NAME_RE.test(w); }) || words[0].length < 2 || words[words.length - 1].length < 2 || name.length > 120)
      errors.name = 'Informe nome e sobrenome (apenas letras).';
    if (!phone) errors.phone = 'Informe seu telefone com DDD.';
    else if (!(phone.length === 10 || phone.length === 11) || +phone.slice(0, 2) < 11 || (phone.length === 11 && phone.charAt(2) !== '9'))
      errors.phone = 'Informe um telefone válido com DDD. Ex.: (42) 98843-7189.';
    if (email && (email.length > 160 || !EMAIL_RE.test(email))) errors.email = 'Informe um e-mail válido ou deixe em branco.';
    return {
      ok: Object.keys(errors).length === 0, errors: errors,
      clean: { name: name, phone: phone, phoneFmt: formatPhone(phone), email: email }
    };
  }

  /* ---------- 4) Store (Supabase) ---------- */
  /* Fala com as funções do banco (supabase/schema.sql) por HTTPS.
     A chave usada aqui é a PÚBLICA (anon): ela só consegue chamar
     datas_indisponiveis() e solicitar_reserva(); não lê nem grava a tabela. */
  var Store = (function () {
    function cfg() {
      var c = window.ELSHADAY_SUPABASE || {};
      return { url: String(c.url || '').replace(/\/+$/, ''), key: String(c.anonKey || '') };
    }
    function fail(code, extra) { var e = new Error('store:' + code + (extra ? ':' + extra : '')); e.code = code; return e; }
    function blocked() { return CONFIG.blockedDates.filter(function (d) { return !!parseISO(d); }); }

    function diagnose(status, code) {
      if (code === 'PGRST202' || status === 404) return 'CAUSA PROVÁVEL: o supabase/schema.sql não foi executado neste projeto (a função não existe).';
      if (status === 401 || status === 403) return 'CAUSA PROVÁVEL: chave inválida/errada em js/reservas-config.js, ou permissão (GRANT) ausente — rode o schema.sql inteiro.';
      if (status === 400) return 'CAUSA PROVÁVEL: parâmetros diferentes da função no banco — rode a versão atual do schema.sql.';
      if (status >= 500) return 'Erro interno do Supabase (projeto pausado ou erro na função). Veja Logs no painel.';
      return '';
    }
    function rpc(name, args) {
      var c = cfg();
      if (!/^https:\/\/[^\s\/]+/.test(c.url) || c.key.length < 20) {
        console.error('[El Shaday] Banco de reservas não configurado: preencha js/reservas-config.js (veja o README).');
        return Promise.reject(fail('config'));
      }
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, CONFIG.requestTimeoutMs);
      var headers = { 'Content-Type': 'application/json', 'apikey': c.key };
      if (c.key.indexOf('eyJ') === 0) headers.Authorization = 'Bearer ' + c.key;      // chaves antigas (JWT)
      var req = Promise.race([
        fetch(c.url + '/rest/v1/rpc/' + name, {
          method: 'POST', headers: headers, body: JSON.stringify(args || {}), cache: 'no-store', signal: ctrl ? ctrl.signal : undefined
        }),
        new Promise(function (_, rej) { setTimeout(function () { rej(fail('timeout')); }, CONFIG.requestTimeoutMs + 500); })
      ]);
      return req.then(function (r) {
        if (!r.ok) {                                                     // registra a resposta REAL do Supabase no console (nada é escondido)
          return r.text().then(function (t) {
            var j = {}; try { j = JSON.parse(t); } catch (e) {}
            var e = fail('http', r.status); e.status = r.status; e.detail = j.message || t || ''; e.dbCode = j.code || '';
            console.error('[El Shaday] Supabase respondeu HTTP ' + r.status + ' em ' + name + ' — ' + (e.dbCode ? e.dbCode + ': ' : '') + (e.detail || '(sem corpo)') + (j.hint ? ' | dica: ' + j.hint : '') + ' | ' + diagnose(r.status, e.dbCode));
            throw e;
          });
        }
        return r.json();
      }).then(function (v) { clearTimeout(timer); return v; }, function (e) {
        clearTimeout(timer);
        if (!(e && e.code)) console.error('[El Shaday] Sem resposta do Supabase (' + c.url + '): URL errada, sem internet ou bloqueio do navegador.', e);
        throw (e && e.code) ? e : fail('network');
      });
    }

    return {
      configured: function () { var c = cfg(); return /^https:\/\/[^\s\/]+/.test(c.url) && c.key.length >= 20; },
      /* -> Promise<string[]> 'AAAA-MM-DD' (rejeita se o banco não responder) */
      getUnavailable: function () {
        return rpc('datas_indisponiveis').then(function (rows) {
          if (!Array.isArray(rows)) throw fail('format');
          var list = rows.map(function (r) { return r && r.data; }).filter(function (d) { return !!parseISO(d); });
          return list.concat(blocked());
        });
      },
      /* b: { date, adults, children, cleaning, name, phone(dígitos), email, token }
         -> Promise<{ok:true, booking}|{ok:false, code, message}> ; rejeita só por falha de rede/banco */
      create: function (b) {
        return rpc('solicitar_reserva', {
          p_data: b.date, p_adultos: b.adults, p_criancas: b.children, p_limpeza: !!b.cleaning,
          p_nome: b.name, p_telefone: b.phone, p_email: b.email || null, p_token: b.token || null, p_data_saida: b.out || null
        }).then(function (res) {
          if (!res || typeof res !== 'object') throw fail('format');
          if (res.ok === true) return { ok: true, booking: { id: res.id, total: res.total, nights: res.diarias } };
          return { ok: false, code: res.codigo || 'invalid', message: res.mensagem || 'Não foi possível registrar a reserva.' };
        });
      }
    };
  })();

  /* ---------- 5) UI ---------- */
  var root = document.getElementById('reserva');
  if (!root) return;

  function $(sel) { return root.querySelector(sel); }
  var el = {
    panel: $('.rv__panel'), views: { form: $('[data-view="form"]'), review: $('[data-view="review"]'), done: $('[data-view="done"]') },
    month: $('[data-rv="month"]'), prev: $('[data-rv="prev"]'), next: $('[data-rv="next"]'), grid: $('[data-rv="grid"]'),
    dateV: $('[data-rv="date-value"]'), outV: $('[data-rv="out-value"]'), sDailyLbl: $('[data-rv="s-daily-label"]'), dateH: $('[data-rv="date-hours"]'),
    adults: $('#rv-adults'), children: $('#rv-children'), cleaning: $('#rv-cleaning'),
    sCleaning: $('[data-rv="s-cleaning"]'), sTotal: $('[data-rv="s-total"]'), sDaily: $('[data-rv="s-daily"]'),
    msg: $('[data-rv="msg"]'), confirm: $('[data-rv="confirm"]'),
    recap: $('[data-rv="recap"]'), reviewMsg: $('[data-rv="review-msg"]'), submit: $('[data-rv="submit"]'),
    doneRecap: $('[data-rv="done-recap"]'), doneWa: $('[data-rv="done-wa"]'),
    loadErr: $('[data-rv="load-err"]'), retry: $('[data-rv="retry"]'),
    name: $('#rv-name'), phone: $('#rv-phone'), email: $('#rv-email'), hp: $('[data-rv="hp"]'),
    errName: $('[data-rv="err-name"]'), errPhone: $('[data-rv="err-phone"]'), errEmail: $('[data-rv="err-email"]')
  };

  var cur = { y: 0, m: 0 };                // mês exibido
  var state = {
    month: null, selected: null, out: null, picking: 'entrada', cleaning: false, unavailable: new Set(),
    adults: '2', children: '0', view: 'form', busy: false, opener: null,
    loadFailed: false, token: null, lastBooking: null, timer: null
  };
  var renderToken = 0;

  function fresh() {
    state.selected = null; state.out = null; state.picking = 'entrada'; state.cleaning = false; state.adults = '2'; state.children = '0'; state.view = 'form';
    el.adults.value = '2'; el.children.value = '0'; el.cleaning.checked = false;
    state.token = null; state.lastBooking = null;
  }
  function nowMonth() { var t = new Date(); return { y: t.getFullYear(), m: t.getMonth() + 1 }; }
  function maxMonth() { return addMonths(nowMonth(), CONFIG.maxMonthsAhead); }
  function ymKey(ym) { return ym.y * 12 + ym.m; }

  function setMsg(node, text, kind) {
    node.textContent = text || '';
    node.className = 'rv__msg' + (text ? ' is-' + (kind || 'err') : '');
  }
  function showView(name) {
    state.view = name;
    Object.keys(el.views).forEach(function (k) { el.views[k].hidden = (k !== name); });
    el.panel.scrollTop = 0; root.querySelector('.rv__body').scrollTop = 0;
  }

  /* ----- valores ----- */
  function readGuests(raw) {                               // '' -> NaN ; '3' -> 3
    var s = String(raw == null ? '' : raw).trim();
    return /^\d+$/.test(s) ? parseInt(s, 10) : NaN;
  }
  function currentBooking() {
    return { date: state.selected, out: state.out || (state.selected ? addDaysISO(state.selected, 1) : null), adults: readGuests(el.adults.value), children: readGuests(el.children.value), cleaning: state.cleaning };
  }
  function nightsNow() { return (state.selected && state.out) ? nightsBetween(state.selected, state.out) : 1; }
  function renderSummary() {
    var n = nightsNow(), t = totals(state.cleaning, n);
    el.sDaily.textContent = money(t.daily);
    el.sDailyLbl.textContent = n === 1 ? 'Valor da diária' : 'Diárias (' + n + ' × ' + money(t.unit) + ')';
    el.sCleaning.textContent = money(t.cleaning);
    el.sTotal.textContent = money(t.total);
  }
  function renderDate() {
    if (state.selected) {
      var n = nightsNow();
      el.dateV.textContent = 'Entrada: ' + longDate(state.selected); el.dateV.classList.remove('is-empty');
      el.outV.textContent = 'Saída: ' + longDate(state.out); el.outV.hidden = false;
      el.dateH.textContent = state.picking === 'saida'
        ? nightsText(n) + ' · Para ficar mais dias, toque na data de saída. A saída não é cobrada.'
        : nightsText(n) + ' · Diária das 10h às 23h. A data de saída não é cobrada.';
      el.dateH.hidden = false;
    } else {
      el.dateV.textContent = 'Selecione a data de entrada no calendário'; el.dateV.classList.add('is-empty');
      el.outV.hidden = true; el.dateH.hidden = true;
    }
  }

  /* ----- calendário ----- */
  /* Última saída possível a partir da entrada escolhida: a noite anterior a ela precisa estar livre;
     a própria data de saída PODE ser uma noite ocupada (a saída não ocupa a noite). */
  function outLimit() {
    if (!state.selected) return null;
    var k = 1;
    while (k < CONFIG.maxNights && !state.unavailable.has(addDaysISO(state.selected, k))) k++;
    return addDaysISO(state.selected, k);
  }
  function pickingOut() { return !!state.selected && state.picking === 'saida'; }
  function validOut(iso, lim) { return pickingOut() && iso > state.selected && iso <= lim; }
  function dayClass(iso, today) {
    if (iso < today) return 'rv__day--past';
    if (state.unavailable.has(iso)) return 'rv__day--booked';
    if (tooSoon(iso)) return 'rv__day--soon';
    return 'rv__day--ok';
  }
  function dayLabel(iso, today, lim) {
    var s = longDate(iso);
    if (iso === state.selected) return s + ', entrada selecionada';
    if (state.selected && iso === state.out) return s + ', saída selecionada';
    if (state.selected && iso > state.selected && iso < state.out) return s + ', noite incluída na reserva';
    if (iso < today) return s + ', data passada, indisponível';
    if (state.unavailable.has(iso)) return s + (validOut(iso, lim) ? ', ocupada; pode ser escolhida como data de saída' : ', indisponível');
    if (tooSoon(iso)) return s + ', indisponível: menos de 24 horas de antecedência';
    return s + (pickingOut() && iso > state.selected ? ', disponível como saída' : ', disponível');
  }
  function renderGrid(focusIso) {
    var today = todayISO(), y = cur.y, m = cur.m, lim = pickingOut() ? outLimit() : null;
    var first = new Date(y, m - 1, 1).getDay(), n = daysIn(y, m);
    el.month.textContent = MONTHS[m - 1] + ' de ' + y;
    var tabIso = (state.selected && state.selected.slice(0, 7) === y + '-' + pad(m)) ? state.selected
      : (today.slice(0, 7) === y + '-' + pad(m) ? today : toISO(y, m, 1));
    var h = '', i;
    for (i = 0; i < first; i++) h += '<span class="rv__blank" aria-hidden="true"></span>';
    for (i = 1; i <= n; i++) {
      var iso = toISO(y, m, i), cls = dayClass(iso, today), outOk = validOut(iso, lim);
      var dis = (cls !== 'rv__day--ok' && !outOk) || state.loadFailed;
      if (outOk && cls === 'rv__day--booked') cls += ' rv__day--outok';
      if (iso === today) cls += ' rv__day--today';
      var chosen = false;
      if (state.selected) {
        if (iso === state.selected) { cls += ' rv__day--sel'; chosen = true; }
        else if (iso === state.out) { cls += ' rv__day--out'; chosen = true; }
        else if (iso > state.selected && iso < state.out) cls += ' rv__day--range';
      }
      h += '<button type="button" class="rv__day ' + cls + '" data-iso="' + iso + '"' +
        (dis ? ' aria-disabled="true"' : '') + (chosen ? ' aria-pressed="true"' : ' aria-pressed="false"') +
        ' tabindex="' + (iso === tabIso ? '0' : '-1') + '" aria-label="' + dayLabel(iso, today, lim) + '">' + i + '</button>';
    }
    el.grid.innerHTML = h;
    var minK = ymKey(nowMonth()), maxK = ymKey(maxMonth()), k = ymKey(cur);
    el.prev.disabled = k <= minK; el.next.disabled = k >= maxK;
    if (focusIso) { var b = el.grid.querySelector('[data-iso="' + focusIso + '"]'); if (b) b.focus(); }
  }
  /* Relê as datas indisponíveis no banco compartilhado e redesenha.
     Se o banco não responder, avisa o visitante e NÃO finge que está tudo livre. */
  function refresh(focusIso) {
    var token = ++renderToken;
    return Store.getUnavailable().then(function (list) {
      if (token !== renderToken) return;
      state.unavailable = new Set(list);
      state.loadFailed = false; el.loadErr.hidden = true;
      var wasSel = state.selected;
      if (wasSel && state.view === 'form' && firstBusyNight(wasSel, state.out || addDaysISO(wasSel, 1), state.unavailable)) {   // alguém levou uma noite do período
        state.selected = null; state.out = null; state.picking = 'entrada'; renderDate(); renderSummary();
        setMsg(el.msg, 'O período que você escolheu acabou de ser reservado por outra pessoa. Escolha outro período.', 'info');
      }
      renderGrid(focusIso);
    }, function (err) {
      if (token !== renderToken) return;
      state.loadFailed = true; el.loadErr.hidden = false;
      if (window.console) console.error('[El Shaday] Falha ao carregar datas:', err && err.message);
      renderGrid(focusIso);
    });
  }
  function goMonth(ym, focusIso) {
    if (ymKey(ym) < ymKey(nowMonth()) || ymKey(ym) > ymKey(maxMonth())) return;
    cur = { y: ym.y, m: ym.m };
    return refresh(focusIso);
  }

  /* 1º toque = entrada (já vale 1 diária); 2º toque em data posterior = saída; toque em data anterior/igual = nova entrada. */
  function selectDay(iso) {
    var today = todayISO();
    if (state.loadFailed) { setMsg(el.msg, 'Ainda não conseguimos carregar as datas. Toque em "Tentar novamente".', 'info'); return; }
    if (iso < today) { setMsg(el.msg, 'Datas passadas não podem ser selecionadas.', 'info'); return; }
    if (pickingOut() && iso > state.selected) {
      var n = nightsBetween(state.selected, iso), busy = firstBusyNight(state.selected, iso, state.unavailable);
      if (!busy && n <= CONFIG.maxNights) {
        state.out = iso; state.picking = 'entrada'; setMsg(el.msg, '');
        renderDate(); renderSummary(); renderGrid(iso); return;
      }
      if (n > CONFIG.maxNights && !busy) { setMsg(el.msg, 'O máximo é de ' + CONFIG.maxNights + ' diárias por reserva.', 'info'); return; }
      if (state.unavailable.has(iso) || tooSoon(iso)) { setMsg(el.msg, 'O período escolhido inclui datas indisponíveis. Escolha outra saída ou outra entrada.', 'info'); return; }
      /* a data está livre mas o período não: o visitante provavelmente quer começar por ela */
    }
    if (state.unavailable.has(iso)) { setMsg(el.msg, 'Essa data está indisponível. Escolha outra data.', 'info'); return; }
    if (tooSoon(iso)) { setMsg(el.msg, NOTICE_MSG, 'info'); return; }
    state.selected = iso; state.out = addDaysISO(iso, 1); state.picking = 'saida';
    setMsg(el.msg, '');
    renderDate(); renderSummary(); renderGrid(iso);
  }

  el.grid.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('.rv__day') : null;
    if (b) selectDay(b.getAttribute('data-iso'));
  });
  el.grid.addEventListener('keydown', function (e) {               // setas navegam pelos dias
    var b = e.target.closest ? e.target.closest('.rv__day') : null; if (!b) return;
    var p = parseISO(b.getAttribute('data-iso')), step = 0;
    if (e.key === 'ArrowLeft') step = -1; else if (e.key === 'ArrowRight') step = 1;
    else if (e.key === 'ArrowUp') step = -7; else if (e.key === 'ArrowDown') step = 7;
    else if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault(); var mv = addMonths(cur, e.key === 'PageUp' ? -1 : 1); goMonth(mv, toISO(mv.y, mv.m, Math.min(p.d, daysIn(mv.y, mv.m)))); return;
    } else return;
    e.preventDefault();
    var t = new Date(p.y, p.m - 1, p.d + step), iso = toISO(t.getFullYear(), t.getMonth() + 1, t.getDate());
    if (iso < todayISO()) return;
    var ym = { y: t.getFullYear(), m: t.getMonth() + 1 };
    if (ym.y !== cur.y || ym.m !== cur.m) goMonth(ym, iso);
    else { var nb = el.grid.querySelector('[data-iso="' + iso + '"]'); if (nb) { b.tabIndex = -1; nb.tabIndex = 0; nb.focus(); } }
  });
  el.prev.addEventListener('click', function () { goMonth(addMonths(cur, -1)); });
  el.next.addEventListener('click', function () { goMonth(addMonths(cur, 1)); });
  el.retry.addEventListener('click', function () { setMsg(el.msg, ''); refresh(); });

  /* ----- adultos / crianças ----- */
  function guestInvalid(input, min) {
    var v = readGuests(input.value);
    return isNaN(v) || v < min || v > CONFIG.maxGuests;
  }
  function markField(input, bad) { input.parentNode.classList.toggle('is-bad', !!bad); input.setAttribute('aria-invalid', bad ? 'true' : 'false'); }
  function syncSteppers() {
    root.querySelectorAll('.rv__sbtn').forEach(function (b) {
      var input = b.getAttribute('data-step') === 'adults' ? el.adults : el.children;
      var min = input === el.adults ? CONFIG.minAdults : 0, v = readGuests(input.value);
      if (isNaN(v)) { b.disabled = false; return; }
      b.disabled = (b.getAttribute('data-dir') === '-1' && v <= min) || (b.getAttribute('data-dir') === '1' && v >= CONFIG.maxGuests);
    });
  }
  [el.adults, el.children].forEach(function (input) {
    var min = input === el.adults ? CONFIG.minAdults : 0;
    input.addEventListener('input', function () {                  // só dígitos: sem sinal, vírgula, ponto ou letras
      var clean = input.value.replace(/\D+/g, '').slice(0, 3);
      if (clean !== input.value) input.value = clean;
      markField(input, false); syncSteppers();
    });
    input.addEventListener('blur', function () { markField(input, guestInvalid(input, min)); syncSteppers(); });   // não corrige em silêncio: o erro aparece ao confirmar
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); bump(input, e.key === 'ArrowUp' ? 1 : -1); }
    });
  });
  function bump(input, dir) {
    var min = input === el.adults ? CONFIG.minAdults : 0, v = readGuests(input.value);
    v = isNaN(v) ? min : v + dir;                                  // campo vazio: parte do mínimo
    input.value = String(Math.max(min, Math.min(CONFIG.maxGuests, v)));
    markField(input, false); syncSteppers();
  }
  root.querySelectorAll('.rv__sbtn').forEach(function (b) {
    b.addEventListener('click', function () { bump(b.getAttribute('data-step') === 'adults' ? el.adults : el.children, +b.getAttribute('data-dir')); });
  });

  /* ----- taxa de limpeza: atualiza o total na hora ----- */
  el.cleaning.addEventListener('change', function () { state.cleaning = el.cleaning.checked; renderSummary(); });

  /* ----- recap (revisão / sucesso) ----- */
  function recapHTML(b) {
    var n = nightsBetween(b.date, b.out), t = totals(b.cleaning, n);
    function row(k, v, cls) { return '<div class="rv__row' + (cls ? ' ' + cls : '') + '"><dt>' + k + '</dt><dd>' + v + '</dd></div>'; }
    return row('Entrada', longDate(b.date)) + row('Saída', longDate(b.out)) + row('Diárias', n) + row('Horário', CONFIG.hours) +
      row('Adultos', b.adults) + row('Crianças (até ' + CONFIG.childMaxAge + ' anos)', b.children) +
      row('Taxa de limpeza', b.cleaning ? 'Incluída · ' + money(t.cleaning) : 'Não incluída · ' + money(0)) +
      row('Valor da diária', money(t.unit)) + (n > 1 ? row('Valor das diárias (' + n + ' × ' + money(t.unit) + ')', money(t.daily)) : '') +
      row('Valor total', money(t.total), 'rv__row--total');
  }
  function capFirst(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  /* Mensagem do WhatsApp (texto puro; a codificação fica em waLink) */
  function waMessage(b, c) {
    var n = nightsBetween(b.date, b.out), t = totals(b.cleaning, n);
    return 'Olá! Gostaria de confirmar uma reserva na Chácara Recanto El Shaday.\n\n' +
      '*DADOS DO CLIENTE*\n' +
      'Nome: ' + c.name + '\n' +
      'Telefone: ' + c.phoneFmt + '\n' +
      (c.email ? 'E-mail: ' + c.email + '\n' : '') +
      '\n*DADOS DA RESERVA*\n' +
      'Entrada: ' + capFirst(longDate(b.date)) + '\n' +
      'Saída: ' + capFirst(longDate(b.out)) + '\n' +
      'Diárias: ' + n + '\n' +
      'Horário: ' + CONFIG.hours + '\n' +
      'Adultos: ' + b.adults + '\n' +
      'Crianças de até ' + CONFIG.childMaxAge + ' anos: ' + b.children + '\n' +
      'Taxa de limpeza: ' + (b.cleaning ? 'incluída' : 'não incluída') + '\n' +
      'Valor da diária: ' + money(t.unit) + '\n' +
      (n > 1 ? 'Valor das ' + n + ' diárias: ' + money(t.daily) + '\n' : '') +
      'Valor da taxa de limpeza: ' + money(t.cleaning) + '\n' +
      '*VALOR TOTAL: ' + money(t.total) + '*\n\n' +
      'Gostaria de confirmar a disponibilidade e receber as orientações para concluir a reserva.';
  }
  function waLink(b, c) { return 'https://wa.me/' + CONFIG.whatsapp + '?text=' + encodeURIComponent(waMessage(b, c)); }

  /* ----- contato: máscara, erros por campo ----- */
  function setFieldErr(input, errEl, text) {
    errEl.textContent = text || '';
    input.setAttribute('aria-invalid', text ? 'true' : 'false');
    input.parentNode.classList.toggle('is-bad', !!text);
  }
  function showContactErrors(v) {
    setFieldErr(el.name, el.errName, v.errors.name); setFieldErr(el.phone, el.errPhone, v.errors.phone); setFieldErr(el.email, el.errEmail, v.errors.email);
    if (v.errors.name) el.name.focus(); else if (v.errors.phone) el.phone.focus(); else if (v.errors.email) el.email.focus();
  }
  el.phone.addEventListener('input', function () {
    var f = formatPhone(el.phone.value);
    if (f !== el.phone.value) el.phone.value = f;
    setFieldErr(el.phone, el.errPhone, '');
  });
  el.name.addEventListener('input', function () { setFieldErr(el.name, el.errName, ''); });
  el.email.addEventListener('input', function () { setFieldErr(el.email, el.errEmail, ''); });
  [['name', 'errName'], ['phone', 'errPhone'], ['email', 'errEmail']].forEach(function (k) {   // valida ao sair do campo
    el[k[0]].addEventListener('blur', function () {
      if (!el[k[0]].value) return;                                 // vazio: o aviso aparece só ao confirmar
      var v = validateContact({ name: el.name.value, phone: el.phone.value, email: el.email.value });
      setFieldErr(el[k[0]], el[k[1]], v.errors[k[0]]);
    });
  });
  function newToken() {
    try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
    return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }

  /* ----- passo 1: validar e mostrar a revisão ----- */
  function onConfirmClick() {
    if (state.busy) return;
    setMsg(el.msg, '');
    state.busy = true; el.confirm.disabled = true;
    Store.getUnavailable().then(function (list) {                  // confere de novo a disponibilidade agora
      state.busy = false; el.confirm.disabled = false;
      state.unavailable = new Set(list); state.loadFailed = false; el.loadErr.hidden = true;
      var b = currentBooking(), v = validate(b, state.unavailable);
      markField(el.adults, v.bad.adults); markField(el.children, v.bad.children);
      if (!v.ok) {
        if (b.date && firstBusyNight(b.date, b.out, state.unavailable)) { state.selected = null; state.out = null; state.picking = 'entrada'; renderDate(); renderSummary(); }
        renderGrid(); setMsg(el.msg, v.errors.join(' '), 'err');
        if (v.bad.adults) el.adults.focus(); else if (v.bad.children) el.children.focus();
        return;
      }
      el.recap.innerHTML = recapHTML(b);
      setMsg(el.reviewMsg, '');
      state.token = newToken();                                     // identifica esta tentativa (reenvio seguro)
      showView('review');
      el.name.focus({ preventScroll: true });
    }, function (err) {
      state.busy = false; el.confirm.disabled = false;
      if (window.console) console.error('[El Shaday] Falha ao verificar datas:', err && err.message);
      state.loadFailed = true; el.loadErr.hidden = false; renderGrid();
      setMsg(el.msg, 'Não foi possível verificar a disponibilidade agora. Verifique sua conexão e tente novamente.', 'err');
    });
  }

  /* ----- passo 2: registrar no banco e SÓ ENTÃO abrir o WhatsApp ----- */
  function onSubmitClick() {
    if (state.busy) return;
    setMsg(el.reviewMsg, '');
    var cv = validateContact({ name: el.name.value, phone: el.phone.value, email: el.email.value });
    showContactErrors(cv);
    if (!cv.ok) { setMsg(el.reviewMsg, 'Confira os campos destacados para continuar.', 'err'); return; }
    if (el.hp.value) return;                                       // campo-armadilha preenchido: é robô, ignora em silêncio

    var b = currentBooking();
    var v0 = validate(b, state.unavailable);
    if (!v0.ok) { backToForm(v0.errors[0]); return; }

    /* abre a aba JÁ no clique (celulares bloqueiam janelas abertas depois de uma espera de rede);
       só recebe o endereço do WhatsApp se o registro der certo, senão é fechada. */
    var win = null;
    try { win = window.open('', '_blank'); if (win) win.opener = null; } catch (e) { win = null; }
    function closeWin() { try { if (win && !win.closed) win.close(); } catch (e) {} }

    state.busy = true; el.submit.disabled = true;
    el.submit.querySelector('span').textContent = 'Verificando a data…';

    Store.getUnavailable().then(function (list) {                  // 8) verifica de novo, agora
      state.unavailable = new Set(list);
      if (firstBusyNight(b.date, b.out, state.unavailable)) return { ok: false, code: 'indisponivel' };
      el.submit.querySelector('span').textContent = 'Registrando…';
      return Store.create({                                        // 9) grava e bloqueia (a trava é do banco)
        date: b.date, out: b.out, adults: b.adults, children: b.children, cleaning: b.cleaning,
        name: cv.clean.name, phone: cv.clean.phone, email: cv.clean.email, token: state.token
      });
    }).then(function (res) {
      endBusy();
      if (!res.ok) {
        closeWin(); refresh();
        if (res.code === 'indisponivel') { backToForm(nightsBetween(b.date, b.out) > 1 ? 'Alguma data do período escolhido não está mais disponível. Escolha outro período para continuar.' : 'Essa data não está mais disponível. Escolha outra data para continuar.'); }
        else if (res.code === 'antecedencia') { backToForm(res.message || NOTICE_MSG); }
        else setMsg(el.reviewMsg, res.message || 'Não foi possível registrar a solicitação. Tente novamente.', 'err');
        return;
      }
      var url = waLink(b, cv.clean);                               // 10) agora sim: abre o WhatsApp
      state.lastBooking = b; state.token = null;
      el.doneRecap.innerHTML = recapHTML(b);
      el.doneWa.setAttribute('href', url);
      refresh(); showView('done');
      root.querySelector('[data-rv="done-title"]').focus();
      var opened = false;
      if (win && !win.closed) { try { win.location.href = url; opened = true; } catch (e) { opened = false; } }
      if (!opened) {                                               // janela bloqueada: no celular, segue na mesma aba
        if (isMobile()) { window.location.href = url; }
      }
    }, function (err) {                                            // 11) erro de rede/banco: NÃO abre o WhatsApp
      endBusy(); closeWin();
      if (window.console) console.error('[El Shaday] Falha ao registrar:', err && err.message);
      setMsg(el.reviewMsg, 'Não conseguimos registrar sua solicitação agora, então o WhatsApp não foi aberto e nenhuma data foi reservada. Verifique sua conexão e toque em "Confirmar pelo WhatsApp" para tentar de novo.', 'err');
    });
  }
  function endBusy() {
    state.busy = false; el.submit.disabled = false;
    el.submit.querySelector('span').textContent = 'Confirmar pelo WhatsApp';
  }
  function isMobile() { return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || ''); }
  /* data perdida / inválida: volta ao calendário mantendo adultos, crianças e taxa */
  function backToForm(text) {
    state.selected = null; state.out = null; state.picking = 'entrada'; state.token = null; renderDate(); renderSummary(); renderGrid();
    showView('form'); setMsg(el.msg, text, 'err');
  }

  /* ----- abrir / fechar ----- */
  function open(opener) {
    state.opener = opener || document.activeElement;
    var sw = window.innerWidth - document.documentElement.clientWidth;
    if (sw > 0) document.body.style.paddingRight = sw + 'px';
    document.documentElement.classList.add('rv-lock');
    root.hidden = false;
    setMsg(el.msg, '');
    cur = nowMonth();                                              // sempre abre no mês atual
    renderDate(); renderSummary(); syncSteppers();
    refresh().then(function () { el.panel.focus({ preventScroll: true }); });
    clearInterval(state.timer);
    state.timer = setInterval(function () { if (!root.hidden && !state.busy) refresh(); }, CONFIG.refreshMs);   // vê reservas de outros visitantes
  }
  function close() {
    if (root.hidden) return;
    var wasDone = state.view === 'done';
    root.hidden = true; clearInterval(state.timer);
    document.documentElement.classList.remove('rv-lock');
    document.body.style.paddingRight = '';
    if (wasDone) { fresh(); renderDate(); renderSummary(); }
    showView('form');                                              // revisão/sucesso: reabre sempre no calendário
    if (state.opener && state.opener.focus) state.opener.focus();
  }

  document.addEventListener('click', function (e) {
    var o = e.target.closest ? e.target.closest('[data-reserva-open]') : null;
    if (o) { e.preventDefault(); open(o); return; }
    if (root.hidden) return;
    if (e.target.closest && e.target.closest('[data-rv-close]')) { close(); return; }
  });
  el.confirm.addEventListener('click', onConfirmClick);
  el.views.review.addEventListener('submit', function (e) { e.preventDefault(); onSubmitClick(); });
  root.querySelector('[data-rv="back"]').addEventListener('click', function () { showView('form'); el.confirm.focus({ preventScroll: true }); });
  el.views.form.addEventListener('submit', function (e) { e.preventDefault(); onConfirmClick(); });

  document.addEventListener('keydown', function (e) {
    if (root.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;                                   // foco preso dentro do modal
    var f = Array.prototype.filter.call(el.panel.querySelectorAll('button,a[href],input,[tabindex]'), function (n) {
      return !n.disabled && n.tabIndex >= 0 && n.offsetParent !== null;
    });
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (!root.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && (document.activeElement === first || document.activeElement === el.panel)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  /* ao voltar para a aba/janela, relê as datas (outro visitante pode ter reservado) */
  document.addEventListener('visibilitychange', function () { if (!document.hidden && !root.hidden && !state.busy) refresh(); });

  /* API mínima para testes */
  window.ElShadayReservas = { open: open, close: close, config: CONFIG, store: Store, validate: validate, validateContact: validateContact, formatPhone: formatPhone, waMessage: waMessage, waLink: waLink, totals: totals, money: money };
})();
