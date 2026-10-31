"""Cenários de falha de configuração: confere se o console e o diagnostico.html apontam a causa certa."""
import re, sys
from playwright.sync_api import sync_playwright
SITE='http://localhost:8000'; FAKE='https://abcd.supabase.co'
def run(name, cfg, handler, expect_console, expect_diag, expect_visible_err):
    with sync_playwright() as p:
        b=p.chromium.launch(); ctx=b.new_context(); logs=[]
        ctx.route('**/js/reservas-config.js', lambda r: r.fulfill(status=200, content_type='application/javascript', body=cfg))
        if handler: ctx.route(FAKE+'/**', handler)
        ctx.route(re.compile(r'https://(fonts\.|cdnjs\.).*'), lambda r: r.abort())
        pg=ctx.new_page(); pg.on('console', lambda m: logs.append(m.text))
        pg.goto(SITE+'/index.html'); pg.evaluate("document.querySelector('[data-reserva-open]').click()"); pg.wait_for_timeout(900)
        vis=pg.is_visible('[data-rv="load-err"]'); con=' '.join(logs)
        d=ctx.new_page(); d.goto(SITE+'/diagnostico.html'); d.wait_for_timeout(900); dt=d.inner_text('#out')
        ok = (vis==expect_visible_err) and (expect_console in con) and (expect_diag in dt)
        print(('PASS ' if ok else 'FAIL ')+name+('' if ok else '\n  console=%s\n  diag=%s vis=%s'%(con[:300],dt[:300],vis))); b.close(); return ok
KEY='k'*40
CFG="window.ELSHADAY_SUPABASE={url:'%s',anonKey:'%s'};"%(FAKE,KEY)
def cors(r,status,body):
    h={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'POST, OPTIONS'}
    if r.request.method=='OPTIONS': return r.fulfill(status=204,headers=h)
    r.fulfill(status=status,headers=h,content_type='application/json',body=body)
res=[]
res.append(run('config vazia', "window.ELSHADAY_SUPABASE={url:'',anonKey:''};", None, 'não configurado', 'está vazio', True))
res.append(run('schema não executado (404 PGRST202)', CFG, lambda r: cors(r,404,'{"code":"PGRST202","message":"Could not find the function public.datas_indisponiveis without parameters in the schema cache","hint":null}'), 'schema.sql não foi executado', 'schema.sql ainda não foi executado', True))
res.append(run('chave inválida (401)', CFG, lambda r: cors(r,401,'{"message":"Invalid API key","hint":"Double check your Supabase `anon` or `service_role` API key."}'), 'chave inválida', 'Chave recusada', True))
res.append(run('chave secreta colada por engano', "window.ELSHADAY_SUPABASE={url:'%s',anonKey:'sb_secret_%s'};"%(FAKE,'x'*30), None, '', 'chave SECRETA', True))
res.append(run('sem rede/URL errada', CFG, lambda r: r.abort(), 'Sem resposta do Supabase', 'Sem resposta do servidor', True))
res.append(run('tudo certo (200 [])', CFG, lambda r: cors(r,200,'[{"data":"2030-01-05"}]'), '', 'Leitura OK', False))
sys.exit(0 if all(res) else 1)
