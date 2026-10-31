"""Ponte de TESTE: imita a API do Supabase (PostgREST + Auth) em cima de um PostgreSQL local que
tem o supabase/schema.sql REAL aplicado. Assim os testes do site e do painel exercitam o SQL de verdade.
NÃO é o Supabase: não use em produção. Precisa do cliente `psql` e das variáveis PGHOST/PGPORT/PGUSER/PGDATABASE.
Uso: python3 tests/pg_gateway.py [porta]"""
import json, os, subprocess, sys, threading, time, uuid
from flask import Flask, request, jsonify, make_response

app = Flask(__name__)
STATE = {'down': False}
TOKENS = {}                    # access_token -> user_id
REFRESH = {}                   # refresh_token -> user_id
LOCK = threading.Lock()
PROCS = {}

def psql(sql, stdin=False):
    r = subprocess.run(['psql', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'],
                       input=sql, capture_output=True, text=True, timeout=30)
    return r.returncode, r.stdout.strip(), r.stderr.strip()

def lit(v):
    if v is None: return 'NULL'
    if isinstance(v, bool): return "'true'" if v else "'false'"
    if isinstance(v, list): return "'{" + ','.join('"%s"' % str(x).replace('"', '\\"') for x in v) + "}'"
    return "'" + str(v).replace("'", "''") + "'"

def cors(r):
    r.headers['Access-Control-Allow-Origin'] = '*'
    r.headers['Access-Control-Allow-Headers'] = 'apikey, authorization, content-type, x-client-info, prefer'
    r.headers['Access-Control-Allow-Methods'] = 'POST, GET, OPTIONS'
    return r

def jerr(status, code, msg): return cors(make_response(json.dumps({'code': code, 'message': msg}), status, {'Content-Type': 'application/json'}))

@app.route('/rest/v1/rpc/<name>', methods=['POST', 'OPTIONS'])
def rpc(name):
    if request.method == 'OPTIONS': return cors(make_response('', 204))
    if STATE['down']: return jerr(503, 'PGRST000', 'down')
    if not request.headers.get('apikey'): return jerr(401, '', 'No API key found in request')
    auth = request.headers.get('Authorization', '')
    uid = None
    if auth.startswith('Bearer ') and not auth[7:].startswith('k') and auth[7:] != '':
        uid = TOKENS.get(auth[7:])
        if uid is None: return jerr(401, 'PGRST301', 'JWT expired')
    args = request.get_json(force=True, silent=True) or {}
    if name not in PROCS:
        _, out, _ = psql("select proretset from pg_proc where proname=%s and pronamespace='public'::regnamespace" % lit(name))
        PROCS[name] = out
    if PROCS[name] == '': return jerr(404, 'PGRST202', 'Could not find the function public.%s' % name)
    call = 'public.%s(%s)' % (name, ', '.join('%s => %s' % (k, lit(v)) for k, v in args.items()))
    expr = ("select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select * from %s) t" % call) if PROCS[name] == 't' else ('select to_jsonb(%s)' % call)
    role = 'authenticated' if uid else 'anon'
    claims = json.dumps({'sub': uid, 'role': 'authenticated'}) if uid else ''
    script = "begin;\nset local role %s;\nselect set_config('request.jwt.claims', %s, true) \\gset\n%s;\ncommit;\n" % (role, lit(claims), expr)
    rc, out, err = psql(script)
    if rc != 0:
        code = ''
        for ln in err.splitlines():
            if ln.startswith('ERROR:'): code = ln.split(':')[1].strip(); msg = ln.split(':', 2)[-1].strip()
        status = 403 if code == '42501' else 400
        return jerr(status, code, msg if code else err[:200])
    return cors(make_response(out or 'null', 200, {'Content-Type': 'application/json'}))

def tokens_for(uid, email):
    at, rt = 'tok-' + uuid.uuid4().hex, 'ref-' + uuid.uuid4().hex
    TOKENS[at] = uid; REFRESH[rt] = uid
    return {'access_token': at, 'refresh_token': rt, 'expires_in': 3600, 'expires_at': int(time.time()) + 3600, 'token_type': 'bearer', 'user': {'id': uid, 'email': email}}

@app.route('/auth/v1/<path:p>', methods=['POST', 'OPTIONS'])
def auth(p):
    if request.method == 'OPTIONS': return cors(make_response('', 204))
    if STATE['down']: return jerr(503, '', 'down')
    b = request.get_json(force=True, silent=True) or {}
    if p == 'logout':
        TOKENS.pop((request.headers.get('Authorization') or '')[7:], None); return cors(make_response('', 204))
    if p == 'token' and request.args.get('grant_type') == 'password':
        _, out, _ = psql("select id||'|'||email from auth.users where lower(email)=lower(%s) and senha_teste=%s" % (lit(b.get('email')), lit(b.get('password'))))
        if not out: return cors(make_response(json.dumps({'code': 400, 'error_code': 'invalid_credentials', 'msg': 'Invalid login credentials'}), 400, {'Content-Type': 'application/json'}))
        uid, email = out.split('|'); return cors(jsonify(tokens_for(uid, email)))
    if p == 'token' and request.args.get('grant_type') == 'refresh_token':
        uid = REFRESH.pop(b.get('refresh_token'), None)
        if not uid: return cors(make_response(json.dumps({'code': 400, 'error_code': 'refresh_token_not_found', 'msg': 'Invalid Refresh Token'}), 400, {'Content-Type': 'application/json'}))
        _, email, _ = psql("select email from auth.users where id=%s" % lit(uid)); return cors(jsonify(tokens_for(uid, email)))
    return jerr(404, '', 'not found')

@app.route('/__admin/<cmd>', methods=['GET', 'POST', 'OPTIONS'])
def ctl(cmd):
    if request.method == 'OPTIONS': return cors(make_response('', 204))
    if cmd == 'down': STATE['down'] = True
    elif cmd == 'up': STATE['down'] = False
    elif cmd == 'expire':           # invalida todos os access tokens (simula JWT vencido)
        TOKENS.clear()
    elif cmd == 'reset':
        psql("delete from public.reservas; delete from public.datas_bloqueadas;"); 
    elif cmd == 'seed':
        psql("""delete from public.administradores; delete from auth.users;
          insert into auth.users(email,senha_teste) values ('dono@elshaday.test','senha-forte-123'),('visita@elshaday.test','outra-senha-123');
          insert into public.administradores(user_id,email) select id,email from auth.users where email='dono@elshaday.test';""")
    elif cmd == 'sql':
        rc, out, err = psql(request.get_data(as_text=True)); return cors(jsonify({'rc': rc, 'out': out, 'err': err}))
    elif cmd == 'rows':
        _, out, _ = psql("select coalesce(jsonb_agg(jsonb_build_object('id',id,'data',data,'status',status,'nome',nome,'tel',telefone,'email',email,'total',valor_total,'token',token,'obs',observacao_interna) order by criada_em),'[]') from public.reservas")
        return cors(make_response(out, 200, {'Content-Type': 'application/json'}))
    elif cmd == 'blocks':
        _, out, _ = psql("select coalesce(jsonb_agg(jsonb_build_object('data',data,'motivo',motivo) order by data),'[]') from public.datas_bloqueadas")
        return cors(make_response(out, 200, {'Content-Type': 'application/json'}))
    elif cmd == 'approve':          # aprova por SQL direto (como o dono faria no Table Editor)
        psql("update public.reservas set status='confirmada' where id=(select id from public.reservas where data=%s and status='pendente' order by criada_em limit 1)" % lit(request.args['d']))
    elif cmd == 'release':          # cancela a reserva confirmada da data
        psql("update public.reservas set status='cancelada' where data=%s and status='confirmada'" % lit(request.args['d']))
    return cors(jsonify({'ok': True}))

if __name__ == '__main__':
    app.run(port=int(sys.argv[1]) if len(sys.argv) > 1 else 54321, threaded=True)
