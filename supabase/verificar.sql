-- =========================================================
-- Conferência da instalação (v5) — rode DEPOIS do schema.sql e do criar-admin.sql.
-- No SQL Editor, rode UM bloco por vez (selecione o bloco e clique em Run).
-- Os blocos 4 e 5 usam "rollback": não deixam nenhum registro de teste.
-- =========================================================

-- BLOCO 1 — RLS ligado nas 3 tabelas (esperado: rls_ligado = true nas três)
select c.relname, c.relrowsecurity as rls_ligado
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname in ('reservas','datas_bloqueadas','administradores');

-- BLOCO 2 — privilégios do público. Esperado:
--   anon_le_reservas=false, anon_grava_reservas=false, anon_le_admins=false, auth_le_reservas=false,
--   anon_executa_datas=true, anon_executa_solicitar=true,
--   anon_executa_admin_dados=false, auth_executa_admin_dados=true, anon_executa_eh_admin=false
select has_table_privilege('anon', 'public.reservas', 'select')                        as anon_le_reservas,
       has_table_privilege('anon', 'public.reservas', 'insert')                        as anon_grava_reservas,
       has_table_privilege('anon', 'public.administradores', 'select')                 as anon_le_admins,
       has_table_privilege('authenticated', 'public.reservas', 'select')               as auth_le_reservas,
       has_function_privilege('anon', 'public.datas_indisponiveis()', 'execute')       as anon_executa_datas,
       has_function_privilege('anon', 'public.solicitar_reserva(date,integer,integer,boolean,text,text,text,text,date)', 'execute') as anon_executa_solicitar,
       has_function_privilege('anon', 'public.admin_dados()', 'execute')               as anon_executa_admin_dados,
       has_function_privilege('authenticated', 'public.admin_dados()', 'execute')      as auth_executa_admin_dados,
       has_function_privilege('anon', 'public.eh_admin()', 'execute')                  as anon_executa_eh_admin;

-- BLOCO 3 — funções com search_path vazio e SECURITY DEFINER (esperado: todas com prosecdef = true e proconfig = {search_path=""})
select p.proname, p.prosecdef as security_definer, p.proconfig
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('datas_indisponiveis','solicitar_reserva','eh_admin','admin_dados',
       'admin_aprovar_reserva','admin_recusar_reserva','admin_cancelar_reserva','admin_bloquear_datas','admin_liberar_datas')
 order by 1;

-- BLOCO 3b — administradores cadastrados (esperado: o e-mail do proprietário, e só ele)
select email, criado_em from public.administradores;

-- BLOCO 3c — índice da trava (esperado: 1 linha, "... WHERE status = 'confirmada'"; o índice antigo reservas_data_ativa_unica não deve existir)
select indexname, indexdef from pg_indexes where schemaname = 'public' and indexname like 'reservas_data_%';

-- BLOCO 4 — teste funcional como visitante (anon). Esperado, na ordem:
--   1) {"ok": true, ...}   2) {"ok": true, ...} (duas pendentes na mesma data são aceitas)
--   3) ZERO linhas (pendente NÃO bloqueia a data)
begin;
set local role anon;
select public.solicitar_reserva(current_date + 40, 2, 0, false, 'Teste Um Silva',  '42988437101');
select public.solicitar_reserva(current_date + 40, 3, 1, true,  'Teste Dois Souza', '42988437102');
select * from public.datas_indisponiveis() where data = current_date + 40;
rollback;

-- BLOCO 5 — o visitante NÃO pode ler os dados pessoais.
--           Esperado: ERRO "permission denied for table reservas" (isso é o resultado correto!)
begin;
set local role anon;
select nome, telefone from public.reservas;
rollback;

-- BLOCO 6 — o visitante NÃO pode usar o painel.
--           Esperado: ERRO "permission denied for function admin_dados" (resultado correto!)
begin;
set local role anon;
select public.admin_dados();
rollback;

-- BLOCO 7 — (v5) colunas e regras do período. Esperado: 2 linhas de colunas (data_saida, diarias),
--           e as constraints reservas_periodo_chk e reservas_sem_sobreposicao presentes.
select column_name from information_schema.columns
 where table_schema='public' and table_name='reservas' and column_name in ('data_saida','diarias') order by 1;
select conname from pg_constraint
 where conrelid='public.reservas'::regclass and conname in ('reservas_periodo_chk','reservas_sem_sobreposicao') order by 1;

-- BLOCO 8 — (v5) reservas antigas: esperado 0 linhas sem período (todas viram 1 diária).
select count(*) as sem_periodo from public.reservas where data_saida is null or diarias is null;

-- BLOCO 9 — (v5) 24 h e 2 diárias, como visitante. Esperado, na ordem:
--   1) {"ok": false, "codigo": "antecedencia", ...}   2) {"ok": true, ... total 185000 (centavos)}
--   (nada fica gravado por causa do rollback)
begin;
set local role anon;
select public.solicitar_reserva(current_date, 2, 0, false, 'Teste Hoje Silva', '42988437103');
select public.solicitar_reserva(current_date + 60, 2, 0, true, 'Teste Dois Dias', '42988437104', null, null, current_date + 62);
rollback;
