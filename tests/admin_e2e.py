"""Testes ponta a ponta do painel /admin (Chromium) contra PostgreSQL real via tests/pg_gateway.py.
Use tests/run.sh."""
import json, re, sys, datetime, urllib.request
from playwright.sync_api import sync_playwright

SITE = 'http://localhost:8000/admin/index.html'
MOCK, FAKE = 'http://localhost:54321', 'https://mock.supabase.co'
CFG = "window.ELSHADAY_SUPABASE={url:'%s',anonKey:'%s'};" % (FAKE, 'k' * 40)
results = []

def check(name, cond, extra=''):
    results.append((name, bool(cond)))
    print(('PASS ' if cond else 'FAIL ') + name + (('  -> ' + str(extra)) if (extra and not cond) else ''))

def ctl(cmd, data=None, **q):
    qs = ('?' + '&'.join('%s=%s' % kv for kv in q.items())) if q else ''
    rq = urllib.request.Request(MOCK + '/__admin/' + cmd + qs, data=data.encode() if data else None, method='POST' if data else 'GET')
    return json.loads(urllib.request.urlopen(rq).read())

def sql(s):
    r = ctl('sql', s); assert r['rc'] == 0, r; return r['out']

def fut(n): return (datetime.date.today() + datetime.timedelta(days=n)).isoformat()
def rows(): return ctl('rows')
def by_name(n): return [r for r in rows() if r['nome'] == n]

def setup(ctx):
    def cfg(route): route.fulfill(status=200, content_type='application/javascript', body=CFG)
    def sb(route):
        req = route.request
        cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS'}
        if req.method == 'OPTIONS': return route.fulfill(status=204, headers=cors)
        r = route.fetch(url=req.url.replace(FAKE, MOCK), method=req.method, headers=req.headers, post_data=req.post_data)
        route.fulfill(response=r, headers={**r.headers, **cors})
    ctx.route('**/js/reservas-config.js', cfg); ctx.route(FAKE + '/**', sb)
    ctx.route(re.compile(r'https://(fonts\.|cdnjs\.).*'), lambda r: r.abort())

def login(page, email='dono@elshaday.test', pw='senha-forte-123', keep=False):
    page.fill('#login-email', email); page.fill('#login-senha', pw)
    if keep: page.check('#login-manter')
    page.click('#btn-entrar')

def goto_month(page, iso):
    page.select_option('#cal-mes', iso[:7]); page.wait_for_timeout(100)

def day_cls(page, iso):
    goto_month(page, iso); return page.get_attribute('.ad-day[data-iso="%s"]' % iso, 'class')

def confirm_dialog(page, motivo=None):
    page.wait_for_selector('#dlg[open]')
    if motivo: page.fill('#dlg-motivo', motivo)
    page.click('#dlg-ok'); page.wait_for_selector('#dlg:not([open])', state='attached'); page.wait_for_timeout(500)

def public_unavailable():
    rq = urllib.request.Request(MOCK + '/rest/v1/rpc/datas_indisponiveis', b'{}', {'apikey': 'k', 'Content-Type': 'application/json'})
    return {x['data'] for x in json.loads(urllib.request.urlopen(rq).read())}

def main():
    ctl('up'); ctl('seed'); ctl('reset')
    d_pend, d_conf, d_blk, d_free = fut(10), fut(20), fut(30), fut(45)
    XSS = '<img src=x onerror="window.__xss=1"> Ana Hacker'
    sql("""insert into public.reservas(data,adultos,criancas,taxa_limpeza,valor_diaria,valor_limpeza,valor_total,nome,telefone,email,status) values
      ('%s',2,1,true,85000,15000,100000,'%s','42988437189','ana@ex.com','pendente'),
      ('%s',3,0,false,85000,0,85000,'Bruno Pendente Silva','42999990002',null,'pendente'),
      ('%s',4,2,false,85000,0,85000,'Carla Confirmada Dias','42999990003',null,'confirmada');
      insert into public.datas_bloqueadas(data,motivo) values ('%s','Manutenção da piscina');""" % (d_pend, XSS.replace("'", "''"), d_pend, d_conf, d_blk))
    errs = []
    with sync_playwright() as p:
        br = p.chromium.launch()
        ctx = br.new_context(viewport={'width': 1280, 'height': 900}); setup(ctx)
        page = ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        page.on('dialog', lambda d: d.dismiss())

        # ---- 1) login ----
        page.goto(SITE); page.wait_for_selector('#tela-login:not([hidden])')
        check('L0 sem sessão: mostra login e esconde o painel', page.is_hidden('#tela-app'))
        check('L0b página tem noindex e CSP', 'noindex' in page.content() and 'Content-Security-Policy' in page.content())
        login(page, pw='errada'); page.wait_for_timeout(800)
        check('L1 senha errada: mensagem genérica, continua no login', 'incorretos' in page.inner_text('#login-msg') and page.is_hidden('#tela-app'))
        login(page, email='visita@elshaday.test', pw='outra-senha-123'); page.wait_for_timeout(1200)
        check('L2 usuário válido mas NÃO administrador: acesso negado', 'não tem permissão' in page.inner_text('#login-msg') and page.is_hidden('#tela-app'))
        login(page); page.wait_for_selector('#tela-app:not([hidden])'); page.wait_for_timeout(600)
        check('L3 administrador entra', page.inner_text('#user-email') == 'dono@elshaday.test')
        check('L3b chave pública não é service_role', 'service_role' not in page.content())

        # ---- 2) calendário ----
        goto_month(page, d_conf)
        check('C1 data confirmada aparece como RESERVADO', 'ad-day--reservado' in day_cls(page, d_conf))
        check('C2 data bloqueada aparece como BLOQUEADO', 'ad-day--bloqueado' in day_cls(page, d_blk))
        check('C3 data só com pendentes aparece LIVRE com selo de 2 pendentes', 'ad-day--livre' in day_cls(page, d_pend) and page.inner_text('.ad-day[data-iso="%s"] .ad-day__pend' % d_pend) == '2')
        check('C4 data sem nada aparece LIVRE', 'ad-day--livre' in day_cls(page, d_free))
        check('C5 calendário público: pendente NÃO bloqueia; confirmada e bloqueio sim', d_pend not in public_unavailable() and {d_conf, d_blk} <= public_unavailable())
        # meses distantes navegáveis
        page.select_option('#cal-mes', fut(400)[:7]); check('C6 navega para meses distantes (13 meses à frente)', page.locator('.ad-day[data-iso]').count() >= 28)
        goto_month(page, d_free)

        # ---- 3) segurança de exibição ----
        page.click('#tab-sol'); page.wait_for_timeout(300)
        check('S1 nome malicioso exibido como TEXTO (sem executar)', page.evaluate('window.__xss') is None and page.locator('#sol-lista img').count() == 0 and '<img' in page.inner_text('#sol-lista'))
        check('S2 selo de pendentes na aba = 2', page.inner_text('#cnt-sol') == '2')
        check('S3 link do WhatsApp da solicitação', page.locator('#sol-lista a[href^="https://wa.me/55"]').count() == 2)

        # ---- 4) aprovar / recusar ----
        card = page.locator('.ad-card', has_text='Bruno Pendente Silva')
        card.get_by_role('button', name='Aprovar').click(); confirm_dialog(page)
        check('A1 aprovar pela interface grava "confirmada"', by_name('Bruno Pendente Silva')[0]['status'] == 'confirmada')
        check('A2 após aprovar, a data fica indisponível no site público', d_pend in public_unavailable())
        card = page.locator('.ad-card', has_text='Ana Hacker')
        check('A3 outra pendente da mesma data: Aprovar fica desabilitado + aviso', card.get_by_role('button', name='Aprovar').is_disabled() and 'já reservadas para outro cliente' in card.inner_text())
        card.get_by_role('button', name='Recusar').click(); confirm_dialog(page, 'Data já fechada')
        ana = by_name(XSS)[0]
        check('A4 recusar grava "recusada" com motivo nas notas', ana['status'] == 'recusada' and 'Data já fechada' in (ana['obs'] or ''))
        page.click('#sol-filtros button:has-text("Recusadas")'); page.wait_for_timeout(200)
        check('A5 filtro Recusadas mostra a recusada', page.locator('#sol-lista .ad-card').count() == 1)

        # ---- 5) confirmadas ----
        page.click('#tab-conf'); page.wait_for_timeout(300)
        check('R1 aba Confirmadas lista as 2 próximas', page.locator('#conf-lista .ad-card').count() == 2)
        page.fill('#conf-busca', 'carla'); page.wait_for_timeout(200)
        check('R2 busca por nome', page.locator('#conf-lista .ad-card').count() == 1)
        page.locator('.ad-card', has_text='Carla').get_by_role('button', name='Cancelar reserva').click(); confirm_dialog(page, 'Desistiu')
        check('R3 cancelar libera a data no site', by_name('Carla Confirmada Dias')[0]['status'] == 'cancelada' and d_conf not in public_unavailable())
        page.fill('#conf-busca', '')

        # ---- 6) bloquear / liberar ----
        page.click('#tab-cal'); goto_month(page, d_free)
        page.click('.ad-day[data-iso="%s"]' % d_free); page.fill('#dia-motivo', 'Uso da família'); page.click('#dia-painel >> text=Bloquear data'); page.wait_for_timeout(700)
        check('B1 bloquear data pelo painel: aparece bloqueada no site', d_free in public_unavailable() and any(b['data'] == d_free and b['motivo'] == 'Uso da família' for b in ctl('blocks')))
        check('B1b calendário do painel mostra BLOQUEADO', 'ad-day--bloqueado' in day_cls(page, d_free))
        page.click('.ad-day[data-iso="%s"]' % d_free); page.click('#dia-painel >> text=Liberar data'); page.wait_for_timeout(700)
        check('B2 liberar data: volta a ficar disponível no site', d_free not in public_unavailable())
        # período com conflito (d_pend está confirmada) => nada é bloqueado
        page.click('summary:has-text("Bloquear um período")')
        page.fill('#per-de', fut(8)); page.fill('#per-ate', fut(12)); page.click('#form-periodo button[type=submit]'); confirm_dialog(page)
        check('B3 período que inclui reserva aprovada: negado e nada bloqueado', fut(9) not in public_unavailable() and fut(8) not in {b['data'] for b in ctl('blocks')} and 'aprovada' in page.inner_text('#toast'))
        page.fill('#per-de', fut(60)); page.fill('#per-ate', fut(63)); page.fill('#per-motivo', 'Reforma'); page.click('#form-periodo button[type=submit]'); confirm_dialog(page)
        check('B4 bloquear período de 4 dias', {fut(60), fut(61), fut(62), fut(63)} <= public_unavailable())

        # ---- 10) v5: períodos de várias diárias no painel ----
        e_p, s_p = fut(80), fut(83)                          # 3 diárias: noites +80, +81, +82; saída +83
        sql("""insert into public.reservas(data,data_saida,adultos,criancas,taxa_limpeza,valor_diaria,valor_limpeza,valor_total,nome,telefone,status) values
          ('%s','%s',2,0,true,85000,15000,270000,'Periodo Tres Noites','42988880001','pendente'),
          ('%s','%s',2,0,false,85000,0,170000,'Periodo Sobreposto','42988880002','pendente');""" % (e_p, s_p, fut(82), fut(84)))
        pg = ctx.new_page(); setup(ctx); pg.goto(SITE); pg.wait_for_selector('#tela-login:not([hidden])'); login(pg); pg.wait_for_selector('#tela-app:not([hidden])'); pg.wait_for_timeout(600)
        pg.click('#tab-sol'); pg.wait_for_timeout(300)
        card = pg.locator('.ad-card', has_text='Periodo Tres Noites'); txt = card.inner_text()
        check('V1 card mostra entrada, saída, nº de diárias e valor com limpeza', 'Entrada' in txt and 'Saída' in txt and '3 diárias' in txt and 'R$ 2.700,00' in txt and '3 × R$ 850,00 + limpeza R$ 150,00' in txt, txt)
        card.get_by_role('button', name='Aprovar').click(); confirm_dialog(pg)
        check('V2 aprovar período bloqueia as 3 noites no site e não a saída', {e_p, fut(81), fut(82)} <= public_unavailable() and s_p not in public_unavailable())
        pg.click('#tab-cal'); goto_month(pg, e_p)
        check('V3 calendário do painel: as 3 noites RESERVADO, a saída LIVRE', all('ad-day--reservado' in day_cls(pg, fut(i)) for i in (80, 81, 82)) and 'ad-day--livre' in day_cls(pg, s_p))
        pg.click('#tab-sol'); pg.wait_for_timeout(200)
        c2 = pg.locator('.ad-card', has_text='Periodo Sobreposto')
        check('V4 pedido que sobrepõe parcialmente: Aprovar desabilitado + aviso', c2.get_by_role('button', name='Aprovar').is_disabled() and 'noites já reservadas' in c2.inner_text())
        pg.click('#tab-cal'); goto_month(pg, fut(81)); pg.click('.ad-day[data-iso="%s"]' % fut(81)); pg.wait_for_timeout(200)
        check('V5 painel do dia mostra a reserva inteira do período', 'Periodo Tres Noites' in pg.inner_text('#dia-painel') and '3 diárias' in pg.inner_text('#dia-painel'))
        pg.click('#tab-conf'); pg.wait_for_timeout(300)
        pg.locator('.ad-card', has_text='Periodo Tres Noites').get_by_role('button', name='Cancelar reserva').click(); confirm_dialog(pg, 'teste')
        check('V6 cancelar libera TODAS as noites do período', not ({e_p, fut(81), fut(82)} & public_unavailable()))
        pg.click('#tab-cal'); goto_month(pg, e_p)
        check('V7 painel volta a mostrar as noites como LIVRES', all('ad-day--livre' in day_cls(pg, fut(i)) for i in (80, 81, 82)))
        pg.close()

        # ---- 7) sessão ----
        page.reload(); page.wait_for_selector('#tela-app:not([hidden])', timeout=8000)
        check('N1 recarregar a página mantém a sessão', page.inner_text('#user-email') == 'dono@elshaday.test')
        ctl('expire')                                         # access token vence: o painel renova com o refresh token
        page.click('#btn-atualizar'); page.wait_for_timeout(1200)
        check('N2 token vencido é renovado sem pedir senha de novo', page.is_visible('#tela-app') and 'Falha' not in page.inner_text('#toast'))
        page.click('#btn-sair'); page.wait_for_selector('#tela-login:not([hidden])')
        page.reload(); page.wait_for_selector('#tela-login:not([hidden])')
        check('N3 sair encerra a sessão (recarregar volta ao login)', page.is_hidden('#tela-app'))
        check('N4 sem erros de JavaScript', not errs, errs)

        # ---- 8) acesso direto à API sem ser admin ----
        def call(name, body, tok=None):
            h = {'apikey': 'k', 'Content-Type': 'application/json'}
            if tok: h['Authorization'] = 'Bearer ' + tok
            try: return json.loads(urllib.request.urlopen(urllib.request.Request(MOCK + '/rest/v1/rpc/' + name, json.dumps(body).encode(), h)).read()), 200
            except urllib.error.HTTPError as e: return None, e.code
        _, st = call('admin_dados', {}); check('P1 visitante anônimo não chama admin_dados', st in (401, 403), st)
        vt = json.loads(urllib.request.urlopen(urllib.request.Request(MOCK + '/auth/v1/token?grant_type=password', json.dumps({'email': 'visita@elshaday.test', 'password': 'outra-senha-123'}).encode(), {'apikey': 'k', 'Content-Type': 'application/json'})).read())['access_token']
        _, st = call('admin_dados', {}, vt); check('P2 logado não-admin recebe 403', st == 403, st)
        _, st = call('admin_bloquear_datas', {'p_datas': [fut(200)]}, vt); check('P3 logado não-admin não bloqueia datas', st == 403 and fut(200) not in {b['data'] for b in ctl('blocks')}, st)

        # ---- 9) celular ----
        ctxM = br.new_context(viewport={'width': 390, 'height': 800}, is_mobile=True, has_touch=True); setup(ctxM)
        pm = ctxM.new_page(); pm.goto(SITE); pm.wait_for_selector('#tela-login:not([hidden])')
        check('M1 login no celular sem rolagem horizontal', pm.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'))
        login(pm); pm.wait_for_selector('#tela-app:not([hidden])'); pm.wait_for_timeout(700)
        check('M2 painel no celular sem rolagem horizontal', pm.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'))
        pm.screenshot(path='/tmp/admin_mobile.png', full_page=True)
        page.screenshot(path='/tmp/admin_desktop.png')
        br.close()
    bad = [n for n, ok in results if not ok]
    print('\n%d testes, %d falhas' % (len(results), len(bad))); sys.exit(1 if bad else 0)

main()
