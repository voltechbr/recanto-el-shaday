-- Testes do banco (rodar em um Postgres de teste com tests/pg_stub.sql + supabase/schema.sql aplicados).
-- Imprime PASS/FAIL por verificação. Tudo roda numa transação que termina em ROLLBACK.
\set ON_ERROR_STOP 1
begin;
create temp table res(n text, ok boolean);
grant all on res to public;

do $$
declare
  adm uuid := gen_random_uuid(); usr uuid := gen_random_uuid();
  j jsonb; j2 jsonb; n int; ok boolean; v_id uuid; v_id2 uuid; d date;
  hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  d_pend date := hoje + 210; d_conf date := hoje + 220; d_new date := hoje + 230; d_blk date := hoje + 250;
  d_t date := hoje + 100;
  procedure_dummy int;
begin
  insert into auth.users(id,email) values (adm,'dono@exemplo.com'),(usr,'intruso@exemplo.com');
  insert into public.administradores(user_id,email) values (adm,'dono@exemplo.com');
  -- dados "antigos" próprios deste teste (pendente, confirmada, recusada e um bloqueio manual)
  insert into public.reservas (data,adultos,criancas,taxa_limpeza,valor_diaria,valor_limpeza,valor_total,nome,telefone,status) values
    (d_pend,2,0,false,85000,0,85000,'Cliente Pendente Antigo','42988000001','pendente'),
    (d_conf,4,1,true,85000,15000,100000,'Cliente Confirmado','42988000002','confirmada'),
    (d_new,4,1,true,85000,15000,100000,'Cliente Pendente Novo','42988000003','pendente'),
    (d_new+10,4,1,true,85000,15000,100000,'Cliente Recusado','42988000004','recusada');
  insert into public.datas_bloqueadas(data,motivo) values (d_blk,'Família');

  -- ===== visitante (anon) =====
  set local role anon;
  perform set_config('request.jwt.claims','',true);
  j := public.solicitar_reserva(d_t, 2, 0, false, 'Ana Souza', '42991110001');
  reset role; insert into res values ('anon: solicitação em data livre -> ok', (j->>'ok')::boolean);
  v_id := (j->>'id')::uuid;
  insert into res select 'solicitação nasce PENDENTE', status='pendente' from public.reservas where id=v_id;

  set local role anon;
  select count(*) into n from public.datas_indisponiveis() where data = d_t;
  reset role; insert into res values ('pendente NÃO bloqueia a data no calendário público', n=0);

  set local role anon;
  j := public.solicitar_reserva(d_t, 5, 2, true, 'Bruno Lima', '42991110002');
  reset role; insert into res values ('2ª solicitação PENDENTE na mesma data é aceita', (j->>'ok')::boolean);
  v_id2 := (j->>'id')::uuid;

  set local role anon;
  j := public.solicitar_reserva(d_t, 5, 2, true, 'Bruno Lima', '(42) 99111-0002');
  reset role; insert into res values ('mesmo telefone + mesma data: "duplicada"', j->>'codigo' = 'duplicada');

  set local role anon;
  j := public.solicitar_reserva(d_conf, 2, 0, false, 'Carla Dias', '42991110003');
  reset role; insert into res values ('data com reserva confirmada -> indisponivel', j->>'codigo' = 'indisponivel');
  set local role anon;
  j := public.solicitar_reserva(d_blk, 2, 0, false, 'Carla Dias', '42991110003');
  reset role; insert into res values ('data bloqueada à mão -> indisponivel', j->>'codigo' = 'indisponivel');

  set local role anon;
  select count(*) into n from public.datas_indisponiveis() where data in (d_conf, d_blk);
  reset role; insert into res values ('calendário público mostra confirmada + bloqueio manual', n=2);
  set local role anon;
  select count(*) into n from public.datas_indisponiveis() where data in (d_pend, d_new);
  reset role; insert into res values ('pendentes legadas NÃO aparecem no calendário público', n=0);

  -- anon não lê nem grava tabelas, nem chama o painel
  ok := false; begin set local role anon; perform 1 from public.reservas; exception when insufficient_privilege then ok := true; end; reset role;
  insert into res values ('anon NÃO lê reservas', ok);
  ok := false; begin set local role anon; insert into public.reservas(data,adultos,criancas,valor_diaria,valor_limpeza,valor_total,nome,telefone) values (hoje+1,1,0,1,0,1,'Xx Yy','42999999999'); exception when insufficient_privilege then ok := true; end; reset role;
  insert into res values ('anon NÃO grava em reservas', ok);
  ok := false; begin set local role anon; perform public.admin_dados(); exception when insufficient_privilege then ok := true; end; reset role;
  insert into res values ('anon NÃO executa admin_dados', ok);
  ok := false; begin set local role anon; perform public.admin_aprovar_reserva(v_id); exception when insufficient_privilege then ok := true; end; reset role;
  insert into res values ('anon NÃO executa admin_aprovar_reserva', ok);
  ok := false; begin set local role anon; perform public.eh_admin(); exception when insufficient_privilege then ok := true; end; reset role;
  insert into res values ('anon NÃO executa eh_admin', ok);

  -- ===== usuário logado que NÃO é admin =====
  perform set_config('request.jwt.claims', json_build_object('sub',usr,'role','authenticated')::text, true);
  set local role authenticated;
  ok := public.eh_admin(); reset role;
  insert into res values ('logado não-admin: eh_admin() = false', ok = false);
  foreach d in array array[hoje] loop
    ok := false; begin set local role authenticated; perform public.admin_dados(); exception when insufficient_privilege then ok := true; end; reset role;
    insert into res values ('logado não-admin: admin_dados -> acesso_negado', ok);
    ok := false; begin set local role authenticated; perform public.admin_aprovar_reserva(v_id); exception when insufficient_privilege then ok := true; end; reset role;
    insert into res values ('logado não-admin: aprovar -> acesso_negado', ok);
    ok := false; begin set local role authenticated; perform public.admin_bloquear_datas(array[hoje+300], 'x'); exception when insufficient_privilege then ok := true; end; reset role;
    insert into res values ('logado não-admin: bloquear -> acesso_negado', ok);
    ok := false; begin set local role authenticated; perform public.admin_liberar_datas(array[d_blk]); exception when insufficient_privilege then ok := true; end; reset role;
    insert into res values ('logado não-admin: liberar -> acesso_negado', ok);
    ok := false; begin set local role authenticated; perform 1 from public.reservas; exception when insufficient_privilege then ok := true; end; reset role;
    insert into res values ('logado não-admin NÃO lê reservas', ok);
    ok := false; begin set local role authenticated; perform 1 from public.administradores; exception when insufficient_privilege then ok := true; end; reset role;
    insert into res values ('logado NÃO lê administradores', ok);
  end loop;
  select count(*) into n from public.datas_bloqueadas where data = hoje+300;
  insert into res values ('tentativa de não-admin não bloqueou nada', n=0);

  -- ===== administrador =====
  perform set_config('request.jwt.claims', json_build_object('sub',adm,'role','authenticated')::text, true);
  set local role authenticated;
  ok := public.eh_admin(); j := public.admin_dados(); reset role;
  insert into res values ('admin: eh_admin() = true', ok);
  insert into res values ('admin_dados traz reservas e bloqueios', jsonb_array_length(j->'reservas') >= 6 and jsonb_array_length(j->'bloqueios') >= 1);
  insert into res values ('admin_dados NÃO expõe token', not (j::text like '%"token"%'));

  -- aprovar -> bloqueia a data no site
  set local role authenticated; j := public.admin_aprovar_reserva(v_id); reset role;
  insert into res values ('admin aprova pendente', (j->>'ok')::boolean);
  set local role anon; select count(*) into n from public.datas_indisponiveis() where data = d_t; reset role;
  insert into res values ('após aprovar: data bloqueada no site público', n=1);
  -- 2ª aprovação da mesma data
  set local role authenticated; j := public.admin_aprovar_reserva(v_id2); reset role;
  insert into res values ('2ª aprovação na mesma data é recusada (ja_reservada)', j->>'codigo'='ja_reservada');
  set local role authenticated; j := public.admin_aprovar_reserva(v_id); reset role;
  insert into res values ('aprovar de novo é idempotente', (j->>'ok')::boolean);
  -- recusar a 2ª
  set local role authenticated; j := public.admin_recusar_reserva(v_id2, 'Data já fechada'); reset role;
  insert into res values ('admin recusa pendente', (j->>'ok')::boolean);
  insert into res select 'recusada guarda motivo nas notas', observacao_interna like '%Data já fechada%' from public.reservas where id=v_id2;
  set local role authenticated; j := public.admin_recusar_reserva(v_id, null); reset role;
  insert into res values ('recusar uma aprovada é negado (usar cancelar)', j->>'codigo'='status_invalido');
  -- cancelar -> libera
  set local role authenticated; j := public.admin_cancelar_reserva(v_id, 'Cliente desistiu'); reset role;
  insert into res values ('admin cancela aprovada', (j->>'ok')::boolean);
  set local role anon; select count(*) into n from public.datas_indisponiveis() where data = d_t; reset role;
  insert into res values ('após cancelar: data liberada no site', n=0);
  -- recusada pode ser reaprovada (clique errado)
  set local role authenticated; j := public.admin_aprovar_reserva(v_id2); reset role;
  insert into res values ('recusada pode ser reaprovada se a data está livre', (j->>'ok')::boolean);
  set local role authenticated; j := public.admin_aprovar_reserva(v_id); reset role;
  insert into res values ('cancelada NÃO pode ser aprovada', j->>'codigo'='status_invalido');

  -- bloqueios manuais
  set local role authenticated; j := public.admin_bloquear_datas(array[hoje+60, hoje+61, hoje+62, hoje+60], 'Manutenção'); reset role;
  insert into res values ('admin bloqueia várias datas', (j->>'ok')::boolean and (j->>'total')::int = 3);
  set local role anon; select count(*) into n from public.datas_indisponiveis() where data between hoje+60 and hoje+62; reset role;
  insert into res values ('bloqueio manual aparece no site público', n=3);
  set local role authenticated; j := public.admin_bloquear_datas(array[hoje+70, d_t], 'x'); reset role;   -- d_t tem reserva aprovada (v_id2)
  insert into res values ('bloquear data com reserva aprovada é negado', j->>'codigo'='reservada');
  select count(*) into n from public.datas_bloqueadas where data = hoje+70;
  insert into res values ('...e é tudo-ou-nada (nada foi bloqueado)', n=0);
  set local role authenticated; j := public.admin_bloquear_datas(array[hoje-1], 'x'); reset role;
  insert into res values ('bloquear data passada é negado', j->>'codigo'='passada');
  set local role authenticated; j := public.admin_liberar_datas(array[hoje+61]); reset role;
  insert into res values ('admin libera data bloqueada', (j->>'ok')::boolean and (j->>'liberadas')::int = 1);
  set local role anon; select count(*) into n from public.datas_indisponiveis() where data = hoje+61; reset role;
  insert into res values ('data liberada volta a ficar disponível no site', n=0);
  -- aprovar em data bloqueada
  insert into public.reservas(data,adultos,criancas,valor_diaria,valor_limpeza,valor_total,nome,telefone) values (hoje+60,2,0,85000,0,85000,'Dora Alves','42991110009') returning id into v_id;
  set local role authenticated; j := public.admin_aprovar_reserva(v_id); reset role;
  insert into res values ('aprovar em data bloqueada é negado (bloqueada)', j->>'codigo'='bloqueada');

  -- rede de segurança no banco (Table Editor / SQL direto)
  ok := false; begin update public.reservas set status='confirmada' where id=v_id; exception when raise_exception then ok := true; end;
  insert into res values ('trigger: confirmar em data bloqueada falha mesmo por SQL direto', ok);
  ok := false; begin insert into public.datas_bloqueadas(data) values (d_conf); exception when raise_exception then ok := true; end;
  insert into res values ('trigger: bloquear data com confirmada falha mesmo por SQL direto', ok);
  ok := false; begin insert into public.reservas(data,adultos,criancas,valor_diaria,valor_limpeza,valor_total,nome,telefone,status) values (d_conf,1,0,1,0,1,'Eva Reis','42991110010','confirmada'); exception when unique_violation then ok := true; end;
  insert into res values ('índice único: 2 confirmadas na mesma data falha', ok);
  select count(*) into n from public.reservas where data = d_conf and status='pendente';
  -- pendentes múltiplas continuam permitidas no banco
  insert into public.reservas(data,adultos,criancas,valor_diaria,valor_limpeza,valor_total,nome,telefone) values (d_conf,1,0,1,0,1,'Fia Cruz','42991110011'),(d_conf,1,0,1,0,1,'Gil Melo','42991110012');
  insert into res values ('índice único NÃO impede várias pendentes', true);

end $$;

select case when ok then 'PASS ' else 'FAIL ' end || n as resultado from res order by ok, n;
select count(*) filter (where not ok) as falhas, count(*) as total from res;
rollback;
