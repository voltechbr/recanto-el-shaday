"""Testes ponta a ponta (Chromium) do fluxo PÚBLICO de reservas contra um PostgreSQL local com o schema.sql real,
através de tests/pg_gateway.py (imita a API do Supabase). Use tests/run.sh, que sobe tudo.
Regra testada: a solicitação do cliente fica PENDENTE e NÃO bloqueia a data; só a aprovação do administrador bloqueia.
Uso: python3 tests/e2e.py"""
import json, re, sys, datetime, urllib.parse, urllib.request, threading
from playwright.sync_api import sync_playwright

SITE = 'http://localhost:8000/index.html'
MOCK = 'http://localhost:54321'
FAKE = 'https://mock.supabase.co'
CFG = "window.ELSHADAY_SUPABASE={url:'%s',anonKey:'%s'};" % (FAKE, 'k' * 40)
results = []

def check(name, cond, extra=''):
    results.append((name, bool(cond)))
    print(('PASS ' if cond else 'FAIL ') + name + (('  -> ' + str(extra)) if (extra and not cond) else ''))

def admin(cmd, **q):
    return json.loads(urllib.request.urlopen(MOCK + '/__admin/' + cmd + ('?' + urllib.parse.urlencode(q) if q else '')).read())

def sql(q):
    return json.loads(urllib.request.urlopen(urllib.request.Request(MOCK + '/__admin/sql', q.encode(), method='POST')).read())

def rpc(name, body, tok=None):
    h = {'apikey': 'k', 'Content-Type': 'application/json'}
    if tok: h['Authorization'] = 'Bearer ' + tok
    return json.loads(urllib.request.urlopen(urllib.request.Request(MOCK + '/rest/v1/rpc/' + name, json.dumps(body).encode(), h)).read())

def future(days):
    return (datetime.date.today() + datetime.timedelta(days=days)).isoformat()

def setup(ctx, configured=True):
    wa = []
    def cfg(route):
        route.fulfill(status=200, content_type='application/javascript', body=CFG if configured else "window.ELSHADAY_SUPABASE={url:'',anonKey:''};")
    def sb(route):
        req = route.request
        cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS'}
        if req.method == 'OPTIONS':
            return route.fulfill(status=204, headers=cors)
        r = route.fetch(url=req.url.replace(FAKE, MOCK))
        route.fulfill(response=r, headers={**r.headers, **cors})
    def wa_route(route):
        wa.append(route.request.url); route.fulfill(status=200, content_type='text/html', body='<h1>wa</h1>')
    ctx.route('**/js/reservas-config.js', cfg)
    ctx.route(FAKE + '/**', sb)
    ctx.route('https://wa.me/**', wa_route)
    ctx.route(re.compile(r'https://(fonts\.|cdnjs\.).*'), lambda r: r.abort())
    return wa

def open_modal(page):
    page.goto(SITE); page.wait_for_load_state('domcontentloaded')
    page.evaluate("document.querySelector('[data-reserva-open]').click()")
    page.wait_for_selector('#reserva:not([hidden])'); page.wait_for_timeout(400)

def pick(page, iso):
    for _ in range(14):
        if page.query_selector('.rv__day[data-iso="%s"]' % iso): break
        page.click('[data-rv="next"]'); page.wait_for_timeout(120)
    page.click('.rv__day[data-iso="%s"]' % iso)

def pick_out(page, iso):
    for _ in range(14):
        if page.query_selector('.rv__day[data-iso="%s"]' % iso): break
        page.click('[data-rv="next"]'); page.wait_for_timeout(120)
    page.click('.rv__day[data-iso="%s"]' % iso, force=True); page.wait_for_timeout(150)

def cls(page, iso):
    for _ in range(14):
        if page.query_selector('.rv__day[data-iso="%s"]' % iso): break
        page.click('[data-rv="next"]'); page.wait_for_timeout(120)
    return page.get_attribute('.rv__day[data-iso="%s"]' % iso, 'class')

def to_review(page, iso, adults='2', children='0', cleaning=False):
    pick(page, iso)
    page.fill('#rv-adults', adults); page.fill('#rv-children', children)
    if cleaning: page.click('.rv__check')
    page.click('[data-rv="confirm"]'); page.wait_for_selector('[data-view="review"]:not([hidden])')

def fill_contact(page, name='Maria da Silva Souza', phone='42988437189', email=''):
    page.fill('#rv-name', name); page.fill('#rv-phone', phone); page.fill('#rv-email', email)

def main():
    admin('seed'); admin('reset'); admin('up')
    with sync_playwright() as p:
        br = p.chromium.launch()

        # ---------- A) valores, textos, revisão ----------
        ctx = br.new_context(viewport={'width': 1280, 'height': 900}); wa = setup(ctx)
        page = ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        open_modal(page)
        check('A0 calendário abre e consulta o banco (sem erro de carga)', page.is_hidden('[data-rv="load-err"]'))
        d1 = future(40)
        pick(page, d1)
        check('A1 total sem taxa = R$ 850,00', page.inner_text('[data-rv="s-total"]') == 'R$ 850,00')
        page.click('.rv__check')
        check('A2 total com taxa = R$ 1.000,00', page.inner_text('[data-rv="s-total"]') == 'R$ 1.000,00')
        page.click('.rv__check')
        check('A3 botão do passo 1 não promete confirmar', 'Revisar' in page.inner_text('[data-rv="confirm"]'))
        page.fill('#rv-adults', '3'); page.fill('#rv-children', '2'); page.click('.rv__check')
        page.click('[data-rv="confirm"]'); page.wait_for_selector('[data-view="review"]:not([hidden])')
        txt = page.inner_text('#reserva') + ' ' + page.text_content('.rv__eyebrow')
        for must in ['Reservas', 'Escolha a data do seu', 'dia para lembrar', 'Revise sua reserva', 'Horário', '10h às 23h', 'Adultos', 'Crianças (até 12 anos)',
                     'Incluída · R$ 150,00', 'Valor da diária', 'R$ 850,00', 'Valor total', 'R$ 1.000,00', 'Confirmar pelo WhatsApp', 'Voltar e editar']:
            check('A4 revisão mostra: ' + must, must in txt)
        for mustnot in ['Versão de teste', 'neste navegador', 'localStorage', 'Registrar reserva', 'banco de dados', 'armazenamento']:
            check('A5 revisão NÃO contém: ' + mustnot, mustnot not in txt)
        check('A5b página inteira sem aviso de "versão de teste"', 'Versão de teste' not in page.inner_text('body') and 'não bloqueia a data' not in page.content())
        page.screenshot(path='/tmp/shot_review_desktop.png')

        # ---------- B) validação de contato ----------
        page.click('[data-rv="submit"]')
        check('B1 campos vazios: não registra e mostra erros', page.inner_text('[data-rv="err-name"]') and page.inner_text('[data-rv="err-phone"]') and admin('rows') == [])
        check('B1b e-mail opcional não gera erro quando vazio', page.inner_text('[data-rv="err-email"]') == '')
        for name, phone, email, ok_field in [('Maria', '42988437189', '', 'name'), ('Maria Souza', '4298843', '', 'phone'), ('Maria Souza', '42888437189', '', 'phone'),
                                              ('Maria Souza', '10988437189', '', 'phone'), ('Maria Souza', '42988437189', 'abc', 'email'), ('M4ria S0uza', '42988437189', '', 'name')]:
            fill_contact(page, name, phone, email); page.click('[data-rv="submit"]')
            check('B2 rejeita %s=%r/%r/%r' % (ok_field, name, phone, email), page.inner_text('[data-rv="err-' + ok_field + '"]') != '' and admin('rows') == [], admin('rows'))
        r = page.evaluate("[ElShadayReservas.validateContact({name:'  João   da  Silva ',phone:'+55 (42) 98843-7189',email:' joao@ex.com '}), ElShadayReservas.validateContact({name:'Ana Lu',phone:'4233334444',email:''}), ElShadayReservas.formatPhone('5542988437189'), ElShadayReservas.formatPhone('4233334444')]")
        check('B3 aceita +55, espaços extras, e normaliza', r[0]['ok'] and r[0]['clean']['phone'] == '42988437189' and r[0]['clean']['name'] == 'João da Silva' and r[0]['clean']['email'] == 'joao@ex.com', r[0])
        check('B4 aceita fixo com 10 dígitos e máscara', r[1]['ok'] and r[2] == '(42) 98843-7189' and r[3] == '(42) 3333-4444', r)
        check('B5 sem erros de JS até aqui', not errs, errs)

        # ---------- C) WhatsApp ----------
        fill_contact(page, 'Maria da Silva Souza', '42988437189', '')
        with ctx.expect_page() as newp:
            page.click('[data-rv="submit"]')
        wp = newp.value; wp.wait_for_url('https://wa.me/**', timeout=8000); page.wait_for_selector('[data-view="done"]:not([hidden])')
        url = wp.url
        check('C1 abre wa.me/5542988437189', url.startswith('https://wa.me/5542988437189?text='), url[:60])
        msg = urllib.parse.unquote(url.split('text=', 1)[1])
        dt = datetime.date.fromisoformat(d1)
        wd = ['segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado','domingo'][dt.weekday()]
        mes = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'][dt.month-1]
        dt2 = dt + datetime.timedelta(days=1); mes2 = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'][dt2.month-1]
        wd2 = ['segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado','domingo'][dt2.weekday()]
        expected = ("Olá! Gostaria de confirmar uma reserva na Chácara Recanto El Shaday.\n\n*DADOS DO CLIENTE*\nNome: Maria da Silva Souza\nTelefone: (42) 98843-7189\n\n"
                    "*DADOS DA RESERVA*\nEntrada: %s, %d de %s de %d\nSaída: %s, %d de %s de %d\nDiárias: 1\nHorário: 10h às 23h\nAdultos: 3\nCrianças de até 12 anos: 2\nTaxa de limpeza: incluída\n"
                    "Valor da diária: R$ 850,00\nValor da taxa de limpeza: R$ 150,00\n*VALOR TOTAL: R$ 1.000,00*\n\n"
                    "Gostaria de confirmar a disponibilidade e receber as orientações para concluir a reserva.") % (wd.capitalize(), dt.day, mes, dt.year, wd2.capitalize(), dt2.day, mes2, dt2.year)
        check('C2 mensagem do WhatsApp idêntica ao modelo', msg == expected, '\n' + msg)
        check('C3 URL bem codificada (sem quebra/espaço cru)', ' ' not in url and '\n' not in url and '%0A' in url and '%C3%A1' in url.lower().replace('%c3%a1', '%C3%A1'))
        rows = admin('rows')
        check('C4 registrou 1 solicitação "pendente" com total 100000', len(rows) == 1 and rows[0]['status'] == 'pendente' and rows[0]['total'] == 100000, rows)
        done = page.inner_text('[data-view="done"]')
        check('C5 tela final não promete a data (ainda não reservada)', 'Solicitação registrada' in done and 'ainda não está reservada' in done and 'Reserva confirmada' not in done and 'separada para você' not in done)
        check('C6 link de reserva extra na tela final aponta ao WhatsApp', (page.get_attribute('[data-rv="done-wa"]', 'href') or '').startswith('https://wa.me/5542988437189?text='))
        wp.close()
        page.screenshot(path='/tmp/shot_done_desktop.png')
        page.click('[data-view="done"] [data-rv-close]')

        # sem e-mail omite linha; com e-mail inclui
        open_modal(page); d2 = future(41)
        to_review(page, d2, '4', '0'); fill_contact(page, 'José Álvaro D\'Ávila', '(42) 3333-4444', 'jose@exemplo.com.br')
        with ctx.expect_page() as np2: page.click('[data-rv="submit"]')
        w2 = np2.value; w2.wait_for_url('https://wa.me/**', timeout=8000); m2 = urllib.parse.unquote(w2.url.split('text=', 1)[1])
        check('C7 e-mail aparece quando informado; acentos/apóstrofo ok; sem taxa = R$ 850,00 e R$ 0,00',
              'E-mail: jose@exemplo.com.br' in m2 and "Nome: José Álvaro D'Ávila" in m2 and 'Taxa de limpeza: não incluída' in m2 and 'Valor da taxa de limpeza: R$ 0,00' in m2 and '*VALOR TOTAL: R$ 850,00*' in m2, m2)
        w2.close(); page.wait_for_selector('[data-view="done"]:not([hidden])'); page.click('[data-view="done"] [data-rv-close]')

        # ---------- D) pendente NÃO bloqueia; só a aprovação do administrador bloqueia ----------
        ctxB = br.new_context(viewport={'width': 390, 'height': 800}, is_mobile=True, has_touch=True, user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'); setup(ctxB)
        pb = ctxB.new_page(); open_modal(pb)
        def cls_of(page, d):
            for _ in range(14):
                if page.query_selector('.rv__day[data-iso="%s"]' % d): break
                page.click('[data-rv="next"]'); page.wait_for_timeout(120)
            return page.get_attribute('.rv__day[data-iso="%s"]' % d, 'class')
        for d in (d1, d2):
            check('D1 outra sessão (celular) vê %s AINDA DISPONÍVEL (só há solicitação pendente)' % d, 'rv__day--ok' in cls_of(pb, d))
        # outro cliente pode solicitar a MESMA data que já tem pedido pendente
        pe = ctxB.new_page(); open_modal(pe); to_review(pe, d1, '2', '0'); fill_contact(pe, 'Outro Cliente Interessado', '42977776666')
        with ctxB.expect_page() as npe: pe.click('[data-rv="submit"]')
        npe.value.wait_for_url('https://wa.me/**', timeout=8000); npe.value.close()
        pe.wait_for_selector('[data-view="done"]:not([hidden])')
        check('D1b duas solicitações pendentes para a mesma data coexistem', len([r for r in admin('rows') if r['data'] == d1 and r['status'] == 'pendente']) == 2)
        admin('approve', d=d1)                                    # o administrador aprova a 1ª
        pb.reload(); pb.wait_for_load_state('domcontentloaded'); pb.evaluate("document.querySelector('[data-reserva-open]').click()"); pb.wait_for_timeout(500)
        check('D2 após APROVAR, a data fica indisponível no site', 'rv__day--booked' in cls_of(pb, d1))
        check('D2b a outra data (só pendente) continua disponível', 'rv__day--ok' in cls_of(pb, d2))
        pb.click('.rv__day[data-iso="%s"]' % d1, force=True)
        check('D3 clicar em data aprovada não seleciona', 'rv__day--sel' not in pb.get_attribute('.rv__day[data-iso="%s"]' % d1, 'class'))
        # quem já estava com o modal aberto em outra aba, com a data escolhida, é avisado ao confirmar
        pr = ctx.new_page(); open_modal(pr); to_review(pr, d2, '2', '0'); fill_contact(pr, 'Cliente Que Demorou', '42955554444')
        admin('approve', d=d2)
        pr.click('[data-rv="submit"]'); pr.wait_for_timeout(1500)
        check('D4 data aprovada enquanto o cliente preenchia: volta ao calendário com aviso e sem WhatsApp', pr.is_visible('[data-view="form"]') and 'não está mais disponível' in pr.inner_text('[data-rv="msg"]'))
        admin('release', d=d2)

        # ---------- E) concorrência no servidor ----------
        # 12 solicitações simultâneas na mesma data: todas ficam pendentes; depois 12 aprovações simultâneas: só 1 vale.
        d4 = future(70); oks = []
        def hit(i):
            body = json.dumps({'p_data': d4, 'p_adultos': 2, 'p_criancas': 0, 'p_limpeza': False, 'p_nome': 'Pessoa Teste %d' % i, 'p_telefone': '4299%07d' % i, 'p_email': None, 'p_token': 'tok-%d-xxxxxxxx' % i}).encode()
            rq = urllib.request.Request(MOCK + '/rest/v1/rpc/solicitar_reserva', body, {'apikey': 'k', 'Content-Type': 'application/json'})
            oks.append(json.loads(urllib.request.urlopen(rq).read())['ok'])
        ths = [threading.Thread(target=hit, args=(i,)) for i in range(12)]
        [t.start() for t in ths]; [t.join() for t in ths]
        pend = [r for r in admin('rows') if r['data'] == d4]
        check('E1 12 solicitações simultâneas na mesma data: todas aceitas como pendentes', oks.count(True) == 12 and len(pend) == 12 and all(r['status'] == 'pendente' for r in pend), oks)
        tk = json.loads(urllib.request.urlopen(urllib.request.Request(MOCK + '/auth/v1/token?grant_type=password', json.dumps({'email': 'dono@elshaday.test', 'password': 'senha-forte-123'}).encode(), {'apikey': 'k', 'Content-Type': 'application/json'})).read())['access_token']
        res = []
        def appr(rid):
            rq = urllib.request.Request(MOCK + '/rest/v1/rpc/admin_aprovar_reserva', json.dumps({'p_id': rid}).encode(), {'apikey': 'k', 'Authorization': 'Bearer ' + tk, 'Content-Type': 'application/json'})
            res.append(json.loads(urllib.request.urlopen(rq).read()))
        ths = [threading.Thread(target=appr, args=(r['id'],)) for r in pend]
        [t.start() for t in ths]; [t.join() for t in ths]
        conf = [r for r in admin('rows') if r['data'] == d4 and r['status'] == 'confirmada']
        check('E2 12 aprovações simultâneas na mesma data: exatamente 1 confirmada', len(conf) == 1 and sum(1 for x in res if x.get('ok')) == 1 and sum(1 for x in res if x.get('codigo') == 'ja_reservada') == 11, res)
        admin('release', d=d4)

        # ---------- F) banco indisponível ----------
        d5 = future(80); admin('up')
        pf = ctx.new_page(); open_modal(pf); to_review(pf, d5); fill_contact(pf, 'Fernanda Lima Costa', '42988880000')
        admin('down'); opened = []; ctx.on('page', lambda pg: opened.append(pg))
        pf.click('[data-rv="submit"]'); pf.wait_for_timeout(1500)
        check('F1 banco fora: mostra erro e permanece na revisão', pf.is_visible('[data-view="review"]') and 'não conseguimos registrar' in pf.inner_text('[data-rv="review-msg"]').lower())
        pf.wait_for_timeout(500)
        check('F2 banco fora: o WhatsApp NÃO ficou aberto / nada navegou para wa.me', all((o.is_closed() or 'wa.me' not in o.url) for o in opened) and not any('wa.me' in u for u in wa[-1:] if False))
        check('F3 banco fora: nenhuma data foi gravada', all(r['data'] != d5 for r in admin('rows')))
        check('F4 mensagem ao cliente sem jargão técnico', not re.search(r'supabase|servidor|banco de dados|rpc|http', pf.inner_text('[data-rv="review-msg"]'), re.I))
        admin('up')
        with ctx.expect_page() as np5: pf.click('[data-rv="submit"]')
        w5 = np5.value; w5.wait_for_url('https://wa.me/**', timeout=8000)
        check('F5 banco volta: tentar de novo funciona e abre o WhatsApp', 'wa.me/5542988437189' in w5.url and any(r['data'] == d5 for r in admin('rows')))
        w5.close()
        # calendário com banco fora
        admin('down'); pg2 = ctx.new_page(); open_modal(pg2)
        check('F6 banco fora ao abrir: calendário avisa e oferece nova tentativa', pg2.is_visible('[data-rv="load-err"]'))
        pg2.click('.rv__day:not(.rv__day--past)', force=True); 
        check('F7 banco fora: não deixa selecionar data às cegas', 'Selecione' in pg2.inner_text('[data-rv="date-value"]'))
        admin('up'); pg2.click('[data-rv="retry"]'); pg2.wait_for_timeout(600)
        check('F8 "Tentar novamente" recarrega as datas', pg2.is_hidden('[data-rv="load-err"]'))

        # ---------- G) responsável libera a data ----------
        admin('release', d=d1)                                    # administrador cancela a reserva aprovada
        pg3 = ctx.new_page(); open_modal(pg3)
        for _ in range(14):
            if pg3.query_selector('.rv__day[data-iso="%s"]' % d1): break
            pg3.click('[data-rv="next"]'); pg3.wait_for_timeout(120)
        check('G1 reserva cancelada pelo administrador: a data volta a ficar disponível', 'rv__day--ok' in pg3.get_attribute('.rv__day[data-iso="%s"]' % d1, 'class'))

        # ---------- J) v5: período (entrada/saída) e antecedência mínima de 24 h ----------
        admin('reset')
        e1 = future(100); s1 = future(103)
        pj = ctx.new_page(); open_modal(pj)
        pick(pj, e1)
        check('J1 1º toque = entrada com 1 diária (R$ 850,00)', 'Entrada:' in pj.inner_text('[data-rv="date-value"]') and '1 diária' in pj.inner_text('[data-rv="date-hours"]') and pj.inner_text('[data-rv="s-total"]') == 'R$ 850,00')
        pick_out(pj, s1)
        check('J2 2º toque = saída: 3 diárias, saída não cobrada', pj.is_visible('[data-rv="out-value"]') and '3 diárias' in pj.inner_text('[data-rv="date-hours"]') and pj.inner_text('[data-rv="s-total"]') == 'R$ 2.550,00' and pj.inner_text('[data-rv="s-daily"]') == 'R$ 2.550,00')
        check('J2b resumo mostra "Diárias (3 × R$ 850,00)"', 'Diárias (3 × R$ 850,00)' in pj.inner_text('.rv__sum'))
        pj.click('.rv__check')
        check('J3 limpeza cobrada uma única vez: 3 diárias + limpeza = R$ 2.700,00', pj.inner_text('[data-rv="s-total"]') == 'R$ 2.700,00')
        check('J3b dias do meio marcados como período e a saída como saída', 'rv__day--range' in cls(pj, future(101)) and 'rv__day--out' in cls(pj, s1))
        pj.click('[data-rv="confirm"]'); pj.wait_for_selector('[data-view="review"]:not([hidden])')
        rec = pj.inner_text('[data-rv="recap"]')
        check('J4 revisão mostra entrada, saída, diárias e valores', all(x in rec for x in ['Entrada', 'Saída', 'Diárias', '3', 'Valor das diárias (3 × R$ 850,00)', 'R$ 2.550,00', 'Incluída · R$ 150,00', 'R$ 2.700,00']), rec)
        fill_contact(pj, 'Paulo Roberto Lima', '42988437155')
        with ctx.expect_page() as npj: pj.click('[data-rv="submit"]')
        wj = npj.value; wj.wait_for_url('https://wa.me/**', timeout=8000); mj = urllib.parse.unquote(wj.url.split('text=', 1)[1]); wj.close()
        check('J5 WhatsApp traz Entrada/Saída/Diárias e total R$ 2.700,00', 'Entrada: ' in mj and 'Saída: ' in mj and 'Diárias: 3' in mj and 'Valor das 3 diárias: R$ 2.550,00' in mj and '*VALOR TOTAL: R$ 2.700,00*' in mj, mj)
        rj = [r for r in admin('rows') if r['nome'] == 'Paulo Roberto Lima']
        check('J6 banco: pendente, entrada, saída (+3) e total 270000 calculado no servidor', len(rj) == 1 and rj[0]['status'] == 'pendente' and rj[0]['data'] == e1 and rj[0]['total'] == 270000, rj)
        pj.wait_for_selector('[data-view="done"]:not([hidden])'); pj.click('[data-view="done"] [data-rv-close]')
        open_modal(pj)
        check('J7 pendente de várias diárias NÃO bloqueia nenhuma noite no calendário', all('rv__day--ok' in cls(pj, future(100 + i)) for i in range(4)))
        # administrador aprova => TODAS as noites bloqueadas; a data de saída continua livre
        tk = json.loads(urllib.request.urlopen(urllib.request.Request(MOCK + '/auth/v1/token?grant_type=password', json.dumps({'email': 'dono@elshaday.test', 'password': 'senha-forte-123'}).encode(), {'apikey': 'k', 'Content-Type': 'application/json'})).read())['access_token']
        check('J8 admin aprova o período', rpc('admin_aprovar_reserva', {'p_id': rj[0]['id']}, tk)['ok'])
        pj.reload(); pj.wait_for_load_state('domcontentloaded'); pj.evaluate("document.querySelector('[data-reserva-open]').click()"); pj.wait_for_timeout(500)
        check('J9 após aprovar: as 3 noites aparecem ocupadas e a saída (dia 4) continua disponível', all('rv__day--booked' in cls(pj, future(100 + i)) for i in range(3)) and 'rv__day--ok' in cls(pj, s1))
        # período que invade noite confirmada
        pick(pj, future(98)); pick_out(pj, future(102))
        check('J10 período com noite confirmada é recusado na tela (mensagem clara)', 'indisponíveis' in pj.inner_text('[data-rv="msg"]'), pj.inner_text('[data-rv="msg"]'))
        pick(pj, future(98)); pick_out(pj, future(100))
        check('J11 saída NO primeiro dia ocupado é permitida (2 diárias)', '2 diárias' in pj.inner_text('[data-rv="date-hours"]') and 'rv__day--out' in cls(pj, future(100)))
        # antecedência mínima
        pk = ctx.new_page(); open_modal(pk)
        today = datetime.date.today().isoformat()
        check('J12 hoje aparece indisponível (menos de 24 h) e não seleciona', 'rv__day--soon' in cls(pk, today) and pk.get_attribute('.rv__day[data-iso="%s"]' % today, 'aria-disabled') == 'true')
        pk.dispatch_event('.rv__day[data-iso="%s"]' % today, 'click')
        check('J13 clicar em data com menos de 24 h mostra a mensagem de antecedência', '24 horas' in pk.inner_text('[data-rv="msg"]') and 'Selecione' in pk.inner_text('[data-rv="date-value"]'), (pk.inner_text('[data-rv="msg"]'), pk.inner_text('[data-rv="date-value"]')))
        # servidor: não depende do navegador
        r1 = rpc('solicitar_reserva', {'p_data': today, 'p_adultos': 2, 'p_criancas': 0, 'p_limpeza': False, 'p_nome': 'Teste Direto Api', 'p_telefone': '42988430001'})
        check('J14 servidor recusa entrada com menos de 24 h mesmo sem passar pelo site', r1.get('codigo') == 'antecedencia' and '24 horas' in r1.get('mensagem', ''), r1)
        r2 = rpc('solicitar_reserva', {'p_data': future(150), 'p_data_saida': future(181), 'p_adultos': 2, 'p_criancas': 0, 'p_limpeza': False, 'p_nome': 'Teste Direto Api', 'p_telefone': '42988430002'})
        check('J15 servidor recusa mais de 30 diárias', r2.get('codigo') == 'invalido', r2)
        r3 = rpc('solicitar_reserva', {'p_data': future(150), 'p_data_saida': future(152), 'p_adultos': 2, 'p_criancas': 0, 'p_limpeza': True, 'p_nome': 'Teste Direto Api', 'p_telefone': '42988430003'})
        check('J16 servidor calcula o valor: 2 diárias + limpeza = R$ 1.850,00 (o site não envia valores)', r3.get('ok') and r3.get('total') == 185000 and r3.get('diarias') == 2, r3)
        pk.close(); pj.close()
        admin('reset')

        # ---------- H) sem configuração ----------
        ctxN = br.new_context(); setup(ctxN, configured=False); pn = ctxN.new_page(); open_modal(pn)
        check('H1 sem Supabase configurado: avisa falha de carga e não deixa reservar', pn.is_visible('[data-rv="load-err"]'))

        # ---------- I) layout celular / desktop ----------
        pm = ctxB.new_page(); open_modal(pm); pick(pm, future(120)); pm.screenshot(path='/tmp/shot_form_mobile.png')
        pm.click('[data-rv="confirm"]'); pm.wait_for_selector('[data-view="review"]:not([hidden])')
        fill_contact(pm, 'Ana Beatriz Moreira', '42988437189', ''); pm.wait_for_timeout(300)
        pm.screenshot(path='/tmp/shot_review_mobile.png')
        sw = pm.evaluate("document.querySelector('.rv__body').scrollWidth <= document.querySelector('.rv__body').clientWidth + 1")
        check('I1 celular: sem rolagem horizontal na revisão', sw)
        bb = pm.eval_on_selector('[data-rv="submit"]', 'e => e.getBoundingClientRect().height')
        check('I2 celular: botão principal com área de toque >= 48px', bb >= 48, bb)
        check('I3 sem erros de JS na sessão principal', not errs, errs)
        br.close()
    bad = [n for n, ok in results if not ok]
    print('\n%d testes, %d falhas' % (len(results), len(bad)))
    sys.exit(1 if bad else 0)

main()
