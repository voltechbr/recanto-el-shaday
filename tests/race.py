"""Corrida real: N sessões de navegador (contextos isolados) escolhem a MESMA data, chegam à revisão
(todas viram a data livre) e clicam em "Confirmar pelo WhatsApp" ao mesmo tempo (asyncio.gather).
Regra v4: solicitação pendente NÃO bloqueia a data. Esperado: as N sessões chegam ao sucesso, existem N
solicitações pendentes, nenhuma confirmada, e a data continua disponível no calendário público.
(A garantia de "uma só aprovada por data" é testada em e2e.py, seção E, e em tests/sql_tests.sql.)"""
import asyncio, json, re, datetime, urllib.request, sys
from playwright.async_api import async_playwright

SITE, MOCK, FAKE = 'http://localhost:8000/index.html', 'http://localhost:54321', 'https://mock.supabase.co'
CFG = "window.ELSHADAY_SUPABASE={url:'%s',anonKey:'%s'};" % (FAKE, 'k' * 40)
N = int(sys.argv[1]) if len(sys.argv) > 1 else 4

async def setup(ctx):
    async def cfg(r): await r.fulfill(status=200, content_type='application/javascript', body=CFG)
    async def sb(r):
        cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS'}
        if r.request.method == 'OPTIONS': return await r.fulfill(status=204, headers=cors)
        resp = await r.fetch(url=r.request.url.replace(FAKE, MOCK))
        await r.fulfill(response=resp, headers={**resp.headers, **cors})
    async def wa(r): await r.fulfill(status=200, content_type='text/html', body='wa')
    await ctx.route('**/js/reservas-config.js', cfg); await ctx.route(FAKE + '/**', sb); await ctx.route('https://wa.me/**', wa)
    await ctx.route(re.compile(r'https://(fonts\.|cdnjs\.).*'), lambda r: r.abort())

async def prepare(br, i, iso):
    ctx = await br.new_context(viewport={'width': 1280, 'height': 900}); await setup(ctx)
    pg = await ctx.new_page(); await pg.goto(SITE)
    await pg.evaluate("document.querySelector('[data-reserva-open]').click()"); await pg.wait_for_selector('#reserva:not([hidden])'); await pg.wait_for_timeout(400)
    for _ in range(14):
        if await pg.query_selector('.rv__day[data-iso="%s"]' % iso): break
        await pg.click('[data-rv="next"]'); await pg.wait_for_timeout(120)
    await pg.click('.rv__day[data-iso="%s"]' % iso)
    await pg.click('[data-rv="confirm"]'); await pg.wait_for_selector('[data-view="review"]:not([hidden])')
    await pg.fill('#rv-name', 'Visitante Numero%s Teste' % 'ABCDEFGH'[i]); await pg.fill('#rv-phone', '4190000%04d' % i)
    return ctx, pg

async def main():
    urllib.request.urlopen(MOCK + '/__admin/reset'); iso = (datetime.date.today() + datetime.timedelta(days=90)).isoformat()
    async with async_playwright() as p:
        br = await p.chromium.launch()
        sess = await asyncio.gather(*[prepare(br, i, iso) for i in range(N)])
        free = [await pg.get_attribute('.rv__recap', 'class') is not None for _, pg in sess]  # todas estão na revisão
        # clique simultâneo: todos disparam no mesmo "tick"
        await asyncio.gather(*[pg.evaluate("document.querySelector('[data-rv=submit]').click()") for _, pg in sess])
        await asyncio.sleep(2.5)
        done = [await pg.is_visible('[data-view="done"]') for _, pg in sess]
        form = [await pg.is_visible('[data-view="form"]') for _, pg in sess]
        msgs = [(await pg.inner_text('[data-rv="msg"]')) if f else '' for (_, pg), f in zip(sess, form)]
        rows = json.loads(urllib.request.urlopen(MOCK + '/__admin/rows').read())
        active = [r for r in rows if r['data'] == iso and r['status'] == 'pendente']
        conf = [r for r in rows if r['data'] == iso and r['status'] == 'confirmada']
        ok = len(active) == N and not conf and sum(done) == N and sum(form) == 0
        print('sessões:', N, '| na revisão antes do clique:', all(free), '| sucesso:', sum(done), '| voltaram ao calendário:', sum(form), '| pendentes:', len(active), '| confirmadas:', len(conf))
        print('PASS corrida real' if ok else 'FAIL corrida real', msgs)
        await br.close(); sys.exit(0 if ok else 1)
asyncio.run(main())
