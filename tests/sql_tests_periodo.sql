-- Testes da v5: antecedência mínima de 24 h + reservas de várias diárias. Imprime PASS/FAIL. Termina em ROLLBACK.
\set ON_ERROR_STOP 1
begin;
create temp table res(n text, ok boolean);
create temp table ctx(adm uuid);
grant all on res, ctx to public;

-- relógio congelado (função interna _agora): terça 2026-11-10, 10:00 em Brasília
create or replace function public._agora() returns timestamptz language sql stable set search_path = '' as $$ select timestamptz '2026-11-10 10:00:00-03' $$;
create function pg_temp.relogio(t text) returns void language plpgsql as $$ begin
  execute format('create or replace function public._agora() returns timestamptz language sql stable set search_path = %L as %L', '', 'select timestamptz ' || quote_literal(t)); end $$;
create function pg_temp.t(n text, c boolean) returns void language sql as $$ insert into res values (n, coalesce(c,false)) $$;
create function pg_temp.sol(p_ini date, p_fim date, p_limpeza boolean, p_tel text, p_nome text default 'Fulano de Tal') returns jsonb language plpgsql as $$
declare j jsonb; begin
  set local role anon; j := public.solicitar_reserva(p_ini, 2, 1, p_limpeza, p_nome, p_tel, null, null, p_fim); reset role; return j; end $$;
create function pg_temp.indisp() returns date[] language plpgsql as $$
declare a date[]; begin set local role anon; select coalesce(array_agg(data order by data),'{}') into a from public.datas_indisponiveis(); reset role; return a; end $$;
create function pg_temp.adm(op text, a uuid default null, d date[] default null) returns jsonb language plpgsql as $$
declare j jsonb; u uuid := (select adm from ctx); begin
  perform set_config('request.jwt.claims', json_build_object('sub',u,'role','authenticated')::text, true);
  set local role authenticated;
  if op = 'aprovar' then j := public.admin_aprovar_reserva(a);
  elsif op = 'recusar' then j := public.admin_recusar_reserva(a, 'teste');
  elsif op = 'cancelar' then j := public.admin_cancelar_reserva(a, 'teste');
  elsif op = 'bloquear' then j := public.admin_bloquear_datas(d, 'teste');
  elsif op = 'liberar' then j := public.admin_liberar_datas(d);
  elsif op = 'dados' then j := public.admin_dados(); end if;
  reset role; return j; end $$;

do $$
declare
  adm uuid := gen_random_uuid(); j jsonb; j2 jsonb; r record; id1 uuid; id2 uuid; id3 uuid; ok boolean;
  D date := date '2027-03-10';                      -- entrada base (bem depois do "agora" congelado)
begin
  insert into auth.users(id,email) values (adm,'dono@exemplo.com'); insert into ctx values (adm);
  insert into public.administradores(user_id,email) values (adm,'dono@exemplo.com');

  -- ===== 1) 24 h de antecedência (agora = 10/11 10:00 BRT; entrada às 10:00 BRT) =====
  j := pg_temp.sol(date '2026-11-11', null, false, '42990000001');
  perform pg_temp.t('24h: exatamente 24 h de antecedência é PERMITIDO', (j->>'ok')::boolean);
  perform pg_temp.relogio('2026-11-10 10:00:01-03');
  j := pg_temp.sol(date '2026-11-11', null, false, '42990000002');
  perform pg_temp.t('24h: 23 h 59 min 59 s de antecedência é RECUSADO (codigo antecedencia)', j->>'codigo' = 'antecedencia' and (j->>'mensagem') like '%24 horas%');
  perform pg_temp.relogio('2026-11-10 10:00:00-03');
  j := pg_temp.sol(date '2026-11-10', null, false, '42990000003');
  perform pg_temp.t('24h: entrada no mesmo dia é recusada', j->>'codigo' = 'antecedencia');
  j := pg_temp.sol(date '2026-11-09', null, false, '42990000004');
  perform pg_temp.t('24h: data passada continua inválida', j->>'codigo' = 'invalido');
  perform pg_temp.relogio('2026-11-11 02:30:00+00');                       -- = 10/11 23:30 em Brasília
  j := pg_temp.sol(date '2026-11-11', null, false, '42990000005');
  perform pg_temp.t('24h: fuso de Brasília (23:30 BRT = 02:30 UTC do dia seguinte): entrada de amanhã às 10h é recusada', j->>'codigo' = 'antecedencia');
  j := pg_temp.sol(date '2026-11-12', null, false, '42990000005');
  perform pg_temp.t('24h: ... e a entrada do dia depois é aceita (34 h 30 min)', (j->>'ok')::boolean);
  perform pg_temp.relogio('2026-11-10 10:00:00-03');
  j := pg_temp.sol(date '2026-11-11', date '2026-11-14', false, '42990000006');
  perform pg_temp.t('24h: vale para a ENTRADA também em períodos de várias diárias', (j->>'ok')::boolean and (j->>'diarias')::int = 3);
  perform pg_temp.relogio('2026-11-10 12:00:00-03');
  j := pg_temp.sol(date '2026-11-11', date '2026-11-14', false, '42990000007');
  perform pg_temp.t('24h: período com entrada em menos de 24 h é recusado', j->>'codigo' = 'antecedencia');
  perform pg_temp.relogio('2026-11-10 10:00:00-03');
  delete from public.reservas;

  -- ===== 3-5) diárias e valores (calculados pelo banco) =====
  j := pg_temp.sol(D, D+1, true, '42991000001');
  perform pg_temp.t('1 diária + limpeza = R$ 1.000,00', (j->>'ok')::boolean and (j->>'total')::int = 100000 and (j->>'diarias')::int = 1);
  j := pg_temp.sol(D+10, null, true, '42991000002');
  perform pg_temp.t('sem saída informada = 1 diária (compatível com o site antigo)', (j->>'ok')::boolean and (j->>'total')::int = 100000 and (j->>'diarias')::int = 1);
  j := pg_temp.sol(D+20, D+22, true, '42991000003');
  perform pg_temp.t('2 diárias + limpeza = R$ 1.850,00', (j->>'ok')::boolean and (j->>'total')::int = 185000 and (j->>'diarias')::int = 2);
  j := pg_temp.sol(D+30, D+33, true, '42991000004');
  perform pg_temp.t('3 diárias + limpeza = R$ 2.700,00', (j->>'ok')::boolean and (j->>'total')::int = 270000 and (j->>'diarias')::int = 3);
  j := pg_temp.sol(D+40, D+44, true, '42991000005');
  perform pg_temp.t('4 diárias + limpeza = R$ 3.550,00', (j->>'ok')::boolean and (j->>'total')::int = 355000 and (j->>'diarias')::int = 4);
  j := pg_temp.sol(D+50, D+53, false, '42991000006');
  perform pg_temp.t('3 diárias sem limpeza = R$ 2.550,00 (limpeza cobrada só 1 vez e só se marcada)', (j->>'total')::int = 255000);
  j := pg_temp.sol(D+60, D+90, true, '42991000007');
  perform pg_temp.t('30 diárias é o máximo aceito (R$ 25.650,00)', (j->>'ok')::boolean and (j->>'total')::int = 2565000);
  j := pg_temp.sol(D+100, D+131, true, '42991000008');
  perform pg_temp.t('31 diárias é recusado', j->>'codigo' = 'invalido');
  j := pg_temp.sol(D+140, D+140, true, '42991000009');
  perform pg_temp.t('saída igual à entrada é recusada', j->>'codigo' = 'invalido');
  j := pg_temp.sol(D+140, D+139, true, '42991000009');
  perform pg_temp.t('saída antes da entrada é recusada', j->>'codigo' = 'invalido');
  select count(*) = 0 into ok from public.reservas where telefone in ('42991000008','42991000009');
  perform pg_temp.t('pedidos inválidos não gravam nada', ok);
  select bool_and(valor_diaria = 85000 and valor_total = diarias * 85000 + valor_limpeza and valor_limpeza in (0,15000) and data_saida = data + diarias and status = 'pendente') into ok from public.reservas;
  perform pg_temp.t('linhas gravadas: valor_diaria 850, total = diárias x 850 + limpeza, status pendente', ok);
  -- o banco recusa totais/períodos incoerentes mesmo por SQL direto
  ok := false; begin update public.reservas set diarias = 5 where telefone = '42991000001'; select data_saida - data = 1 into ok from public.reservas where telefone='42991000001'; exception when check_violation then ok := true; end;
  perform pg_temp.t('diarias é sempre recalculada a partir de entrada/saída', ok);
  delete from public.reservas;

  -- ===== 6) período com noite já confirmada =====
  insert into public.reservas(data,data_saida,adultos,criancas,taxa_limpeza,valor_diaria,valor_limpeza,valor_total,nome,telefone,status)
    values (D+5, D+8, 2,0,false,85000,0,255000,'Reserva Confirmada','42980000001','confirmada');       -- noites D+5, D+6, D+7
  perform pg_temp.t('calendário público: as 3 noites aparecem ocupadas; a saída (D+8) não', pg_temp.indisp() @> array[D+5, D+6, D+7] and not (pg_temp.indisp() @> array[D+8]) and not (pg_temp.indisp() @> array[D+4]));
  j := pg_temp.sol(D+4, D+9, false, '42992000001');  perform pg_temp.t('período que ENGLOBA a reserva é recusado', j->>'codigo' = 'indisponivel');
  j := pg_temp.sol(D+6, D+7, false, '42992000002');  perform pg_temp.t('1 noite no MEIO da reserva é recusada', j->>'codigo' = 'indisponivel');
  j := pg_temp.sol(D+3, D+6, false, '42992000003');  perform pg_temp.t('período que invade só a PRIMEIRA noite é recusado (todo o período)', j->>'codigo' = 'indisponivel');
  j := pg_temp.sol(D+7, D+10, false, '42992000004'); perform pg_temp.t('período que começa na ÚLTIMA noite é recusado', j->>'codigo' = 'indisponivel');
  select count(*) = 0 into ok from public.reservas where telefone like '4299200%';
  perform pg_temp.t('...e nada foi gravado para esses pedidos', ok);
  j := pg_temp.sol(D+3, D+5, false, '42992000005');  perform pg_temp.t('período que TERMINA na entrada da reserva (saída = D+5) é aceito', (j->>'ok')::boolean);
  j := pg_temp.sol(D+8, D+10, false, '42992000006'); perform pg_temp.t('período que COMEÇA na saída da reserva (entrada = D+8) é aceito', (j->>'ok')::boolean);
  delete from public.reservas where status = 'pendente';

  -- ===== 7) bloqueio manual dentro do período =====
  insert into public.datas_bloqueadas(data,motivo) values (D+21,'Manutenção');
  j := pg_temp.sol(D+20, D+23, false, '42993000001'); perform pg_temp.t('bloqueio manual no MEIO do período: período inteiro recusado', j->>'codigo' = 'indisponivel');
  j := pg_temp.sol(D+21, D+22, false, '42993000002'); perform pg_temp.t('1 diária exatamente na data bloqueada é recusada', j->>'codigo' = 'indisponivel');
  j := pg_temp.sol(D+19, D+21, false, '42993000003'); perform pg_temp.t('saída NA data bloqueada é aceita (saída não ocupa a noite)', (j->>'ok')::boolean);
  j := pg_temp.sol(D+22, D+24, false, '42993000004'); perform pg_temp.t('entrada logo depois da data bloqueada é aceita', (j->>'ok')::boolean);
  delete from public.reservas where status = 'pendente';

  -- ===== 8) pendentes não bloqueiam; duas pendentes para o mesmo período =====
  j  := pg_temp.sol(D+30, D+33, true, '42994000001', 'Ana Primeira');
  j2 := pg_temp.sol(D+30, D+33, true, '42994000002', 'Bia Segunda');
  perform pg_temp.t('duas solicitações pendentes para o MESMO período são aceitas', (j->>'ok')::boolean and (j2->>'ok')::boolean);
  id1 := (j->>'id')::uuid; id2 := (j2->>'id')::uuid;
  j := pg_temp.sol(D+31, D+34, true, '42994000003', 'Caio Parcial');
  perform pg_temp.t('pendente com sobreposição PARCIAL também é aceita', (j->>'ok')::boolean); id3 := (j->>'id')::uuid;
  j := pg_temp.sol(D+31, D+32, true, '42994000001', 'Ana Primeira');
  perform pg_temp.t('mesmo telefone, período sobreposto: "duplicada"', j->>'codigo' = 'duplicada');
  perform pg_temp.t('pendentes NÃO bloqueiam nenhuma noite no calendário público', not (pg_temp.indisp() && array[D+30, D+31, D+32, D+33]));

  -- ===== 9) aprovar bloqueia TODAS as noites =====
  j := pg_temp.adm('aprovar', id1);
  perform pg_temp.t('admin aprova o período de 3 diárias', (j->>'ok')::boolean);
  perform pg_temp.t('após aprovar: as 3 noites ficam bloqueadas no site; a saída (D+33) não', pg_temp.indisp() @> array[D+30, D+31, D+32] and not (pg_temp.indisp() @> array[D+33]));
  j := pg_temp.adm('aprovar', id2);
  perform pg_temp.t('2ª pendente do MESMO período não pode ser aprovada (ja_reservada)', j->>'codigo' = 'ja_reservada');
  j := pg_temp.adm('aprovar', id3);
  perform pg_temp.t('pendente com sobreposição PARCIAL não pode ser aprovada (ja_reservada)', j->>'codigo' = 'ja_reservada');
  j := pg_temp.sol(D+32, D+34, false, '42994000009');
  perform pg_temp.t('novo pedido que invade uma noite aprovada é recusado', j->>'codigo' = 'indisponivel');
  j := pg_temp.sol(D+33, D+35, false, '42994000010');
  perform pg_temp.t('novo pedido começando na saída da aprovada é aceito e pode ser aprovado', (j->>'ok')::boolean and (pg_temp.adm('aprovar', (j->>'id')::uuid)->>'ok')::boolean);
  j := pg_temp.adm('bloquear', null, array[D+31]);
  perform pg_temp.t('admin não consegue bloquear à mão uma noite DENTRO de reserva aprovada', j->>'codigo' = 'reservada');
  j := pg_temp.adm('bloquear', null, array[D+33+2]);   -- D+35 é saída da última aprovada
  perform pg_temp.t('admin bloqueia a data de SAÍDA de uma reserva (não é noite dela)', (j->>'ok')::boolean);
  j := pg_temp.adm('liberar', null, array[D+35]);
  -- aprovar período com bloqueio manual no meio
  insert into public.reservas(data,data_saida,adultos,criancas,valor_diaria,valor_limpeza,valor_total,nome,telefone,status)
    values (D+20, D+24, 2,0,85000,0,340000,'Pendente Com Bloqueio','42995000001','pendente') returning id into id3;
  j := pg_temp.adm('aprovar', id3);
  perform pg_temp.t('aprovar período que contém data bloqueada à mão é negado (bloqueada)', j->>'codigo' = 'bloqueada');
  ok := false; begin update public.reservas set status = 'confirmada' where id = id3; exception when raise_exception then ok := true; end;
  perform pg_temp.t('trigger: confirmar período com data bloqueada falha mesmo por SQL direto', ok);
  ok := false; begin insert into public.datas_bloqueadas(data) values (D+31); exception when raise_exception then ok := true; end;
  perform pg_temp.t('trigger: bloquear noite de reserva aprovada falha mesmo por SQL direto', ok);
  ok := false; begin insert into public.reservas(data,data_saida,adultos,criancas,valor_diaria,valor_limpeza,valor_total,nome,telefone,status)
      values (D+31, D+36, 1,0,85000,0,425000,'Sobreposta Direta','42995000002','confirmada'); exception when exclusion_violation then ok := true; end;
  perform pg_temp.t('constraint: duas confirmadas com noite em comum falha mesmo por SQL direto', ok);
  delete from public.reservas where id = id3;

  -- ===== 10) recusar e cancelar =====
  insert into public.reservas(data,data_saida,adultos,criancas,valor_diaria,valor_limpeza,valor_total,nome,telefone,status)
    values (D+60, D+63, 2,0,85000,0,255000,'Para Recusar','42996000001','pendente') returning id into id3;
  j := pg_temp.adm('recusar', id3);
  perform pg_temp.t('recusar período pendente: ok e as noites seguem livres', (j->>'ok')::boolean and not (pg_temp.indisp() && array[D+60, D+61, D+62]));
  j := pg_temp.adm('aprovar', id3);
  perform pg_temp.t('recusada pode ser reaprovada (período livre) e bloqueia as 3 noites', (j->>'ok')::boolean and pg_temp.indisp() @> array[D+60, D+61, D+62]);
  j := pg_temp.adm('cancelar', id3);
  perform pg_temp.t('cancelar libera TODAS as noites do período', (j->>'ok')::boolean and not (pg_temp.indisp() && array[D+60, D+61, D+62]));
  j := pg_temp.adm('cancelar', id1);
  perform pg_temp.t('cancelar a reserva de D+30 libera as 3 noites', (j->>'ok')::boolean and not (pg_temp.indisp() && array[D+30, D+31, D+32]));
  j := pg_temp.sol(D+30, D+33, false, '42996000009');
  perform pg_temp.t('período liberado volta a aceitar solicitações', (j->>'ok')::boolean);

  -- ===== painel: dados =====
  j := pg_temp.adm('dados');
  select * into r from jsonb_to_recordset(j->'reservas') as x(id uuid, data date, data_saida date, diarias int, valor_total int, nome text) where nome = 'Para Recusar';
  perform pg_temp.t('admin_dados traz data, data_saida e diarias', r.data = D+60 and r.data_saida = D+63 and r.diarias = 3 and r.valor_total = 255000);
  perform pg_temp.t('admin_dados continua sem expor token', not (j::text like '%"token"%'));
  -- segurança preservada
  ok := false; begin set local role anon; perform public._agora(); exception when insufficient_privilege then ok := true; end; reset role;
  perform pg_temp.t('anon NÃO executa funções internas (_agora)', ok);
  ok := false; begin set local role anon; perform 1 from public.reservas; exception when insufficient_privilege then ok := true; end; reset role;
  perform pg_temp.t('anon continua sem ler reservas', ok);
  perform pg_temp.t('RLS continua ligado', (select bool_and(relrowsecurity) from pg_class where relnamespace='public'::regnamespace and relname in ('reservas','datas_bloqueadas','administradores')));
end $$;

select case when ok then 'PASS ' else 'FAIL ' end || n as resultado from res order by ok, n;
select count(*) filter (where not ok) as falhas, count(*) as total from res;
rollback;
