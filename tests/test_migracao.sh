#!/usr/bin/env bash
# Testa a MIGRATION v4 -> v5 num PostgreSQL temporário: reservas antigas, clientes, administradores, RLS e permissões
# precisam sobreviver intactos; depois roda sql_tests.sql no banco migrado. Também testa schema.sql v5 por cima do v4 e instalação nova.
# Não toca em nenhum banco real.
set -u
cd "$(dirname "$0")/.."
PGBIN="$(pg_config --bindir 2>/dev/null || ls -d /usr/lib/postgresql/*/bin 2>/dev/null | tail -1)"; export PATH="$PGBIN:$PATH"
TMP="$(mktemp -d)"; PORT=55437; RUN=""
if [ "$(id -u)" = "0" ]; then chown postgres "$TMP"; chmod 755 "$TMP"; RUN="runuser -u postgres --"; fi
$RUN initdb -D "$TMP/data" -A trust -E UTF8 >/dev/null
$RUN pg_ctl -D "$TMP/data" -o "-p $PORT -k /tmp -c listen_addresses=''" -l "$TMP/log" -w start >/dev/null
trap '$RUN pg_ctl -D "$TMP/data" -m immediate stop >/dev/null 2>&1; rm -rf "$TMP"' EXIT
export PGHOST=/tmp PGPORT=$PORT PGUSER=postgres
MIG=supabase/migracoes/2026-10-31_antecedencia-24h-e-varias-diarias.sql
P="psql -X -q -v ON_ERROR_STOP=1"; FAIL=0
ok(){ if [ "$2" = "t" ]; then echo "PASS $1"; else echo "FAIL $1 ($2)"; FAIL=1; fi; }
q(){ $P -t -A -d "$1" -c "$2"; }

prepara_v4(){   # $1 = banco ; cria um banco v4 com dados "de produção"
  $P -d postgres -c "create database $1" && $P -d "$1" -f tests/pg_stub.sql && $P -d "$1" -f tests/fixtures/schema_v4.sql 2>&1 | grep -v NOTICE
  $P -d "$1" <<'SQL'
insert into auth.users(id,email,senha_teste) values ('11111111-1111-1111-1111-111111111111','dono@x.com','s');
insert into public.administradores(user_id,email) values ('11111111-1111-1111-1111-111111111111','dono@x.com');
insert into public.reservas (id,data,adultos,criancas,taxa_limpeza,valor_diaria,valor_limpeza,valor_total,nome,telefone,email,status,token,criada_em,atualizada_em,observacao_interna,decidida_em) values
 ('a0000000-0000-0000-0000-000000000001', current_date+10,2,0,false,85000,0,85000,'Cliente Pendente','42988000001','p@x.com','pendente','tok1xxxxxx', now()-interval '5 days', now()-interval '4 days', null, null),
 ('a0000000-0000-0000-0000-000000000002', current_date+20,4,1,true,85000,15000,100000,'Cliente Confirmado','42988000002',null,'confirmada',null, now()-interval '3 days', now()-interval '2 days','nota antiga', now()-interval '2 days'),
 ('a0000000-0000-0000-0000-000000000003', current_date+30,4,1,true,85000,15000,100000,'Cliente Recusado','42988000004',null,'recusada',null, now()-interval '9 days', now()-interval '8 days','Recusada: teste', now()-interval '8 days'),
 ('a0000000-0000-0000-0000-000000000004', current_date-30,2,2,false,85000,0,85000,'Cliente Passado','42988000005',null,'confirmada',null, now()-interval '60 days', now()-interval '50 days',null, null),
 ('a0000000-0000-0000-0000-000000000005', current_date+40,2,0,false,85000,0,85000,'Cliente Expirado','42988000006',null,'expirada',null, now()-interval '20 days', now()-interval '18 days',null, null);
insert into public.datas_bloqueadas(data,motivo) values (current_date+50,'Família');
SQL
}
HASH="select md5(string_agg(concat_ws('|',id,data,adultos,criancas,taxa_limpeza,valor_diaria,valor_limpeza,valor_total,nome,telefone,email,status,token,criada_em,atualizada_em,observacao_interna,decidida_em,decidida_por), ';' order by id)) from public.reservas"
SNAP="select (select count(*) from public.reservas)||'/'||(select count(*) from public.datas_bloqueadas)||'/'||(select count(*) from public.administradores)||'/'||(select count(*) from auth.users)||'/'||(select count(*) from pg_policies where schemaname='public')"
PRIV="select concat_ws(',', has_table_privilege('anon','public.reservas','select'), has_table_privilege('authenticated','public.reservas','select'), has_table_privilege('authenticated','public.administradores','select'), has_function_privilege('anon','public.admin_dados()','execute'), has_function_privilege('authenticated','public.admin_dados()','execute'), has_function_privilege('anon','public.datas_indisponiveis()','execute'), has_function_privilege('anon','public.eh_admin()','execute'))"
RLS="select string_agg(relname||'='||relrowsecurity, ',' order by relname) from pg_class where relnamespace='public'::regnamespace and relname in ('reservas','datas_bloqueadas','administradores')"
PUB="select string_agg(data::text, ',' order by data) from public.datas_indisponiveis()"

for MODO in migration schema; do
  DB=m_$MODO; prepara_v4 $DB
  H0=$(q $DB "$HASH"); S0=$(q $DB "$SNAP"); P0=$(q $DB "$PRIV"); R0=$(q $DB "$RLS"); U0=$(q $DB "$PUB")
  if [ $MODO = migration ]; then $P -d $DB -f $MIG 2>&1 | grep -v NOTICE; else $P -d $DB -f supabase/schema.sql 2>&1 | grep -v NOTICE; fi
  ok "[$MODO] aplicou sem erro" "t"
  ok "[$MODO] reservas antigas idênticas (inclusive atualizada_em e dados dos clientes)" "$([ "$(q $DB "$HASH")" = "$H0" ] && echo t || echo diferente)"
  ok "[$MODO] contagens iguais (reservas/bloqueios/admins/usuários/políticas): $S0" "$([ "$(q $DB "$SNAP")" = "$S0" ] && echo t || echo diferente)"
  ok "[$MODO] permissões iguais às de antes" "$([ "$(q $DB "$PRIV")" = "$P0" ] && echo t || echo "$(q $DB "$PRIV") != $P0")"
  ok "[$MODO] RLS continua ligado nas 3 tabelas" "$([ "$(q $DB "$RLS")" = "$R0" ] && [ "$(q $DB "$RLS")" = "administradores=true,datas_bloqueadas=true,reservas=true" ] && echo t || echo "$(q $DB "$RLS")")"
  ok "[$MODO] calendário público devolve as mesmas datas de antes" "$([ "$(q $DB "$PUB")" = "$U0" ] && echo t || echo "$(q $DB "$PUB") != $U0")"
  ok "[$MODO] todas as reservas antigas viraram 1 diária (saída = entrada + 1)" "$(q $DB "select (count(*)=5 and bool_and(diarias=1 and data_saida=data+1))::text from public.reservas" | sed 's/true/t/')"
  ok "[$MODO] valores antigos preservados" "$(q $DB "select (sum(valor_total)=85000+100000+100000+85000+85000)::text from public.reservas" | sed 's/true/t/')"
  ok "[$MODO] assinatura antiga de solicitar_reserva removida (sem ambiguidade)" "$(q $DB "select (count(*)=1)::text from pg_proc where proname='solicitar_reserva'" | sed 's/true/t/')"
  $P -d $DB -f $( [ $MODO = migration ] && echo $MIG || echo supabase/schema.sql ) 2>&1 | grep -v NOTICE; ok "[$MODO] roda de novo sem erro (idempotente)" "t"
  ok "[$MODO] ... e as reservas continuam idênticas" "$([ "$(q $DB "$HASH")" = "$H0" ] && echo t || echo diferente)"
  R=$( ($P -d $DB -t -A -f tests/sql_tests.sql; $P -d $DB -t -A -f tests/sql_tests_periodo.sql) 2>&1 | grep -E "^FAIL|^PASS" ); echo "$R" | grep -q "^FAIL" && { echo "$R" | grep "^FAIL"; FAIL=1; }
  ok "[$MODO] sql_tests + sql_tests_periodo no banco migrado: $(echo "$R" | grep -c '^PASS') ok" "$(echo "$R" | grep -q '^FAIL' && echo falhou || echo t)"
done
# instalação nova (sem v4): schema.sql v5 direto
$P -d postgres -c "create database m_novo" && $P -d m_novo -f tests/pg_stub.sql && $P -d m_novo -f supabase/schema.sql 2>&1 | grep -v NOTICE
R=$( ($P -d m_novo -t -A -f tests/sql_tests.sql; $P -d m_novo -t -A -f tests/sql_tests_periodo.sql) 2>&1 | grep -E "^FAIL|^PASS"); echo "$R" | grep "^FAIL"
ok "[instalação nova] schema.sql v5 + sql_tests + sql_tests_periodo: $(echo "$R" | grep -c '^PASS') ok" "$(echo "$R" | grep -q '^FAIL' && echo falhou || echo t)"
[ $FAIL = 0 ] && echo "MIGRAÇÃO OK" || echo "MIGRAÇÃO COM FALHAS"; exit $FAIL
