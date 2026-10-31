#!/usr/bin/env bash
# Testes automáticos (opcionais — NÃO vão para o ar). Precisam de: Python 3 + Flask + Playwright (Chromium) e PostgreSQL
# instalado localmente (initdb/pg_ctl/psql). Sobem um banco TEMPORÁRIO, aplicam supabase/schema.sql de verdade,
# ligam uma ponte que imita a API do Supabase (tests/pg_gateway.py) e rodam:
#   sql_tests.sql + sql_tests_periodo.sql (banco) · test_migracao.sh roda à parte · e2e.py + race.py (site público) · admin_e2e.py (painel) · diag.py (diagnóstico)
set -u
cd "$(dirname "$0")/.."
ROOT="$PWD"
PGBIN="$(pg_config --bindir 2>/dev/null || ls -d /usr/lib/postgresql/*/bin 2>/dev/null | tail -1)"
export PATH="$PGBIN:$PATH"
TMP="$(mktemp -d)"; PORT=55439
RUN=""; if [ "$(id -u)" = "0" ]; then chown postgres "$TMP"; chmod 755 "$TMP"; RUN="runuser -u postgres --"; fi
$RUN initdb -D "$TMP/data" -A trust -E UTF8 >/dev/null
$RUN pg_ctl -D "$TMP/data" -o "-p $PORT -k /tmp -c listen_addresses=''" -l "$TMP/log" -w start >/dev/null
export PGHOST=/tmp PGPORT=$PORT PGUSER=postgres PGDATABASE=elt
psql -X -q -d postgres -c "create database elt" 
psql -X -q -v ON_ERROR_STOP=1 -f tests/pg_stub.sql && psql -X -q -v ON_ERROR_STOP=1 -f supabase/schema.sql 2>&1 | grep -v NOTICE
python3 -m http.server 8000 >"$TMP/http.log" 2>&1 & P1=$!
python3 tests/pg_gateway.py 54321 >"$TMP/gw.log" 2>&1 & P2=$!
cleanup(){ kill $P1 $P2 2>/dev/null; $RUN pg_ctl -D "$TMP/data" -m immediate stop >/dev/null 2>&1; rm -rf "$TMP"; }
trap cleanup EXIT
for i in $(seq 1 40); do curl -s -o /dev/null localhost:54321/__admin/up && curl -s -o /dev/null localhost:8000/ && break; sleep 0.3; done
FAIL=0
if [ -n "${ONLY:-}" ]; then python3 "$ONLY"; exit $?; fi   # uso: ONLY=meu_teste.py bash tests/run.sh
echo "== banco =="; for f in sql_tests sql_tests_periodo; do R=$(psql -X -q -t -A -f tests/$f.sql 2>&1 | grep -E "^(PASS|FAIL)"); echo "$f: $(echo "$R" | grep -c ^PASS) ok"; echo "$R" | grep "^FAIL" && FAIL=1; done
echo "== site público =="; python3 tests/e2e.py || FAIL=1; python3 tests/race.py 6 || FAIL=1; python3 tests/diag.py || FAIL=1
echo "== painel /admin =="; python3 tests/admin_e2e.py || FAIL=1
[ $FAIL = 0 ] && echo "TUDO OK" || echo "HÁ FALHAS"
exit $FAIL
