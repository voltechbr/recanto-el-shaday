-- =========================================================
-- MIGRATION 2026-10-31 — Antecedência mínima de 24 h + reservas de várias diárias
-- Recanto El Shaday (Supabase / PostgreSQL)  ·  v4 -> v5
--
-- COMO APLICAR: Supabase > SQL Editor > New query > cole TUDO > Run.  (veja o README, seção "Atualizar para a v5")
-- NÃO foi executada por ninguém: só roda quando VOCÊ colar e clicar em Run.
--
-- O QUE FAZ
--  1) reservas ganha data_saida e diarias. As reservas que já existem viram "1 diária"
--     (data_saida = data + 1 dia). Nenhuma linha é apagada; nenhum dado de cliente é alterado;
--     "atualizada_em" das reservas antigas NÃO muda.
--  2) A coluna "data" continua sendo a ENTRADA. Cada noite de [data, data_saida) é uma diária;
--     a data de saída NÃO é cobrada nem bloqueada.
--  3) Reserva APROVADA ("confirmada") bloqueia todas as noites do período. O banco impede (constraint
--     de exclusão) duas aprovadas com noites em comum e (trigger) aprovar período com data bloqueada à mão.
--     Pendentes continuam NÃO bloqueando nada.
--  4) solicitar_reserva ganha o parâmetro opcional p_data_saida (padrão = data + 1 => 1 diária, então o
--     site antigo continua funcionando). Valida no servidor: antecedência mínima de 24 h (em relação à
--     entrada, às 10h, horário de Brasília), 1 a 30 diárias, disponibilidade de TODAS as noites e calcula
--     o valor: diárias x R$ 850,00 + R$ 150,00 de limpeza (uma vez). O valor enviado pelo navegador nunca é usado.
--  5) datas_indisponiveis(), admin_dados(), admin_aprovar_reserva() e admin_bloquear_datas() passam a
--     considerar o período inteiro.
--
-- NÃO MEXE em: RLS e políticas (continuam negando tudo), administradores, usuários/Auth, valores
-- da diária e da limpeza, admin_recusar_reserva, admin_cancelar_reserva, admin_liberar_datas, eh_admin.
-- Esta migration deve ser executada uma única vez, após revisão.
-- Em caso de erro, a transação será revertida.
-- =========================================================

begin;

-- Assinatura antiga (8 parâmetros): substituída pela nova abaixo (9 parâmetros; o último é opcional).
drop function if exists public.solicitar_reserva(date, integer, integer, boolean, text, text, text, text);

-- ---------- 1) Colunas novas ----------
alter table public.reservas add column if not exists data_saida date;
alter table public.reservas add column if not exists diarias   integer;

-- ---------- 2) Funções de apoio ----------
-- "Agora" em um único ponto (permite testar o relógio sem mexer no código). Uso interno.
create or replace function public._agora()
returns timestamptz
language sql
stable
set search_path = ''
as $$ select now() $$;

-- atualizada_em: igual à v4, exceto que o preenchimento inicial de data_saida (linhas antigas) não conta como alteração
create or replace function public.reservas_toca_atualizada()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.data_saida is null then
    return new;
  end if;
  new.atualizada_em := now();
  return new;
end $$;

-- Mantém data_saida/diarias coerentes: sem data_saida => 1 diária; diarias = data_saida - data.
-- (nome começa com 00 para disparar antes dos demais triggers)
create or replace function public.reservas_periodo()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.data_saida := coalesce(new.data_saida, new.data + 1);
  new.diarias    := new.data_saida - new.data;
  return new;
end $$;

drop trigger if exists reservas_00_periodo on public.reservas;
create trigger reservas_00_periodo before insert or update of data, data_saida, diarias on public.reservas
  for each row execute function public.reservas_periodo();

-- Trava (até o fim da transação) todas as noites de [p_ini, p_fim), sempre em ordem crescente (sem deadlock).
create or replace function public._trava_periodo(p_ini date, p_fim date)
returns void
language plpgsql
volatile
set search_path = ''
as $$
declare
  d date := p_ini;
begin
  while d < p_fim loop
    perform public._trava_data(d);
    d := d + 1;
  end loop;
end $$;

-- ---------- 3) Preenche as reservas antigas e liga as regras de integridade ----------
update public.reservas set data_saida = data + 1 where data_saida is null;   -- diarias é calculada pelo trigger

alter table public.reservas alter column data_saida set not null;
alter table public.reservas alter column diarias    set not null;

alter table public.reservas drop constraint if exists reservas_periodo_chk;
alter table public.reservas add constraint reservas_periodo_chk
  check (data_saida > data and diarias = data_saida - data and diarias between 1 and 30);

-- A TRAVA (v5): duas reservas CONFIRMADAS nunca podem ter noites em comum.
drop index if exists public.reservas_data_confirmada_unica;

alter table public.reservas drop constraint if exists reservas_sem_sobreposicao;
alter table public.reservas add constraint reservas_sem_sobreposicao
  exclude using gist (daterange(data, data_saida, '[)') with &&) where (status = 'confirmada');

-- Rede de segurança (vale também para o Table Editor): confirmar um período com data bloqueada à mão falha...
create or replace function public.reservas_valida_confirmacao()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'confirmada'
     and (tg_op = 'INSERT' or old.status is distinct from 'confirmada' or old.data is distinct from new.data
          or (old.data_saida is not null and old.data_saida is distinct from new.data_saida)) then
    perform public._trava_periodo(new.data, new.data_saida);
    if exists (select 1 from public.datas_bloqueadas b where b.data >= new.data and b.data < new.data_saida) then
      raise exception 'Há data bloqueada manualmente entre % e %: libere o bloqueio antes de confirmar a reserva.', new.data, new.data_saida;
    end if;
  end if;
  return new;
end $$;

-- ...e bloquear à mão uma noite que já pertence a uma reserva confirmada também falha.
create or replace function public.bloqueio_valida()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public._trava_data(new.data);
  if exists (select 1 from public.reservas r
              where r.status = 'confirmada' and new.data >= r.data and new.data < r.data_saida) then
    raise exception 'Já existe reserva confirmada que ocupa %: cancele a reserva antes de bloquear a data.', new.data;
  end if;
  return new;
end $$;

-- =========================================================
-- RPCs PÚBLICAS (site)
-- =========================================================

-- Noites ocupadas (devolve SÓ datas): todas as noites de reservas confirmadas + bloqueios manuais.
-- Pendentes e recusadas NÃO aparecem aqui. A data de SAÍDA de uma reserva não é uma noite ocupada.
create or replace function public.datas_indisponiveis()
returns table (data date)
language sql
stable
security definer
set search_path = ''
as $$
  select r.data + gs.n as data
  from public.reservas r
 cross join lateral generate_series(0, r.diarias - 1) as gs(n)
   where r.status = 'confirmada'
     and r.data + gs.n >= (public._agora() at time zone 'America/Sao_Paulo')::date
  union
  select b.data
    from public.datas_bloqueadas b
   where b.data >= (public._agora() at time zone 'America/Sao_Paulo')::date;
$$;

-- Solicitar a reserva: valida + grava uma solicitação PENDENTE (não bloqueia as datas).
-- p_data = ENTRADA; p_data_saida = SAÍDA (opcional; sem ela => 1 diária). Nunca confia em valores do navegador.
-- Retorna jsonb:
--   {"ok":true,  "id":"...", "total":270000, "diarias":3}
--   {"ok":false, "codigo":"indisponivel" | "invalido" | "antecedencia" | "limite" | "duplicada", "mensagem":"..."}
create or replace function public.solicitar_reserva(
  p_data       date,
  p_adultos    integer,
  p_criancas   integer,
  p_limpeza    boolean,
  p_nome       text,
  p_telefone   text,
  p_email      text default null,
  p_token      text default null,
  p_data_saida date default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c_diaria       constant integer  := 85000;            -- R$ 850,00 por diária
  c_limpeza      constant integer  := 15000;            -- R$ 150,00, uma única vez por reserva
  c_max_diarias  constant integer  := 30;
  c_hora_entrada constant time     := time '10:00';     -- início da estadia (horário de Brasília)
  c_antecedencia constant interval := interval '24 hours';
  v_agora   timestamptz := public._agora();
  v_hoje    date := (public._agora() at time zone 'America/Sao_Paulo')::date;
  v_saida   date;
  v_diarias integer;
  v_nome    text;
  v_tel     text;
  v_email   text;
  v_token   text;
  v_taxa    integer;
  v_total   integer;
  v_id      uuid;
  v_ex      record;
begin
  -- 0) tamanhos máximos ANTES de qualquer processamento (evita abuso com textos enormes)
  if char_length(coalesce(p_nome, '')) > 300 or char_length(coalesce(p_telefone, '')) > 40
     or char_length(coalesce(p_email, '')) > 300 or char_length(coalesce(p_token, '')) > 200 then
    return jsonb_build_object('ok', false, 'codigo', 'invalido', 'mensagem', 'Dados inválidos. Confira os campos e tente novamente.');
  end if;

  v_nome  := regexp_replace(btrim(coalesce(p_nome, '')), '\s+', ' ', 'g');
  v_tel   := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g');
  v_email := nullif(btrim(coalesce(p_email, '')), '');
  v_token := case when p_token is not null and char_length(p_token) between 8 and 80 then p_token end;

  -- 1) validações (o servidor nunca confia no navegador)
  if p_data is null or p_data < v_hoje or p_data > v_hoje + interval '24 months' then
    return jsonb_build_object('ok', false, 'codigo', 'invalido', 'mensagem', 'Data inválida. Escolha outra data.');
  end if;
  v_saida   := coalesce(p_data_saida, p_data + 1);
  v_diarias := v_saida - p_data;
  if v_diarias < 1 or v_diarias > c_max_diarias then
    return jsonb_build_object('ok', false, 'codigo', 'invalido',
      'mensagem', 'Período inválido. A saída deve ser depois da entrada e o máximo é de ' || c_max_diarias || ' diárias.');
  end if;
  -- antecedência mínima: a estadia começa na entrada, às 10h de Brasília; exatamente 24 h de antecedência é permitido
  if ((p_data + c_hora_entrada) at time zone 'America/Sao_Paulo') < v_agora + c_antecedencia then
    return jsonb_build_object('ok', false, 'codigo', 'antecedencia',
      'mensagem', 'As reservas precisam ser solicitadas com pelo menos 24 horas de antecedência em relação à entrada (a partir das 10h). Escolha uma entrada mais adiante.');
  end if;
  if p_adultos is null or p_adultos < 1 or p_adultos > 100
     or p_criancas is null or p_criancas < 0 or p_criancas > 100
     or p_adultos + p_criancas > 100 then
    return jsonb_build_object('ok', false, 'codigo', 'invalido', 'mensagem', 'Confira a quantidade de adultos e crianças.');
  end if;
  if char_length(v_nome) < 3 or char_length(v_nome) > 120 or position(' ' in v_nome) = 0 then
    return jsonb_build_object('ok', false, 'codigo', 'invalido', 'mensagem', 'Informe seu nome completo.');
  end if;
  if v_tel like '55%' and char_length(v_tel) in (12, 13) then
    v_tel := substr(v_tel, 3);                       -- remove o DDI 55
  end if;
  if char_length(v_tel) not in (10, 11) then
    return jsonb_build_object('ok', false, 'codigo', 'invalido', 'mensagem', 'Informe um telefone válido com DDD.');
  end if;
  if v_email is not null and (char_length(v_email) > 160 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    return jsonb_build_object('ok', false, 'codigo', 'invalido', 'mensagem', 'Informe um e-mail válido ou deixe o campo em branco.');
  end if;

   -- 2) reenvio da MESMA tentativa (ex.: a rede caiu depois de gravar): devolve o registro já feito
  if v_token is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('token:' || v_token, 0)
    );
  end if;

  if v_token is not null then
    select r.id, r.valor_total, r.diarias into v_ex
      from public.reservas r
     where r.token = v_token and r.data = p_data and r.data_saida = v_saida and r.telefone = v_tel
       and r.status in ('pendente','confirmada')
     limit 1;
    if found then
      return jsonb_build_object('ok', true, 'id', v_ex.id, 'total', v_ex.valor_total, 'diarias', v_ex.diarias);
    end if;
  end if;

  -- 3) proteção contra abuso (serializa por telefone para o limite ser atômico)
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_tel, 0));
  if exists (select 1 from public.reservas r
              where r.telefone = v_tel and r.status = 'pendente' and r.data < v_saida and r.data_saida > p_data) then
    return jsonb_build_object('ok', false, 'codigo', 'duplicada',
      'mensagem', 'Você já enviou uma solicitação para este período. Fale com a chácara pelo WhatsApp para ajustar.');
  end if;
  if (select count(*) from public.reservas r where r.telefone = v_tel and r.status = 'pendente') >= 2 then
    return jsonb_build_object('ok', false, 'codigo', 'limite',
      'mensagem', 'Já existem solicitações em andamento para este telefone. Fale com a chácara pelo WhatsApp para ajustar.');
  end if;
  if (select count(*) from public.reservas r where r.criada_em > v_agora - interval '1 hour') >= 40 then
    return jsonb_build_object('ok', false, 'codigo', 'limite',
      'mensagem', 'Muitas solicitações no momento. Tente novamente em alguns minutos.');
  end if;

  -- 4) TODAS as noites do período estão livres? (bloqueio manual ou reserva CONFIRMADA = indisponível; pendente não conta)
  perform public._trava_periodo(p_data, v_saida);
  if exists (select 1 from public.datas_bloqueadas b where b.data >= p_data and b.data < v_saida)
     or exists (select 1 from public.reservas r where r.status = 'confirmada' and r.data < v_saida and r.data_saida > p_data) then
    return jsonb_build_object('ok', false, 'codigo', 'indisponivel',
      'mensagem', case when v_diarias = 1 then 'Essa data não está mais disponível.'
                       else 'Alguma data do período escolhido não está mais disponível.' end);
  end if;

  -- 5) valores calculados AQUI: diárias x R$ 850,00 + limpeza (uma vez)
  v_taxa  := case when coalesce(p_limpeza, false) then c_limpeza else 0 end;
  v_total := v_diarias * c_diaria + v_taxa;

  -- 6) grava SOMENTE uma solicitação pendente. Não bloqueia as datas.
  insert into public.reservas
    (data, data_saida, diarias, adultos, criancas, taxa_limpeza, valor_diaria, valor_limpeza, valor_total, nome, telefone, email, token, status)
  values
    (p_data, v_saida, v_diarias, p_adultos, p_criancas, coalesce(p_limpeza, false), c_diaria, v_taxa, v_total, v_nome, v_tel, v_email, v_token, 'pendente')
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'total', v_total, 'diarias', v_diarias);
end $$;

-- =========================================================
-- RPCs DO PAINEL (só administrador logado)
-- =========================================================

-- Tudo que o painel precisa para desenhar as telas, numa chamada só (agora com data_saida e diarias).
create or replace function public.admin_dados()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_res  jsonb;
  v_blq  jsonb;
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  if not public.eh_admin() then
    raise exception 'acesso_negado' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.data, x.criada_em), '[]'::jsonb) into v_res
    from (
      select r.id, r.data, r.data_saida, r.diarias, r.adultos, r.criancas, r.taxa_limpeza, r.valor_diaria, r.valor_limpeza, r.valor_total,
             r.nome, r.telefone, r.email, r.status, r.criada_em, r.atualizada_em, r.decidida_em, r.observacao_interna
        from public.reservas r
       where r.status in ('pendente', 'confirmada')
          or r.id in (select r2.id from public.reservas r2
                       where r2.status not in ('pendente', 'confirmada')
                       order by r2.atualizada_em desc limit 300)
    ) x;

  select coalesce(jsonb_agg(jsonb_build_object('data', b.data, 'motivo', b.motivo) order by b.data), '[]'::jsonb) into v_blq
    from public.datas_bloqueadas b
   where b.data >= v_hoje - 400;

  return jsonb_build_object('reservas', v_res, 'bloqueios', v_blq, 'hoje', v_hoje, 'agora', now());
end $$;

-- Aprovar: a reserva vira "confirmada" e TODAS as noites do período passam a ficar bloqueadas no site.
-- Retorna {"ok":true,...} ou {"ok":false,"codigo":"bloqueada|ja_reservada|passada|status_invalido|nao_encontrada","mensagem":"..."}
create or replace function public.admin_aprovar_reserva(p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_data  date;
  v_saida date;
  v_r     record;
  v_hoje  date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  if not public.eh_admin() then
    raise exception 'acesso_negado' using errcode = '42501';
  end if;

  select r.* into v_r
    from public.reservas r
   where r.id = p_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'codigo', 'nao_encontrada', 'mensagem', 'Solicitação não encontrada.');
  end if;

  v_data  := v_r.data;
  v_saida := v_r.data_saida;

  perform public._trava_periodo(v_data, v_saida);
  if v_r.status = 'confirmada' then
    return jsonb_build_object('ok', true, 'id', v_r.id, 'status', 'confirmada');        -- já estava aprovada
  end if;
  if v_r.status not in ('pendente', 'recusada', 'expirada') then
    return jsonb_build_object('ok', false, 'codigo', 'status_invalido', 'mensagem', 'Esta solicitação não pode mais ser aprovada.');
  end if;
  if v_r.data < v_hoje then
    return jsonb_build_object('ok', false, 'codigo', 'passada', 'mensagem', 'A entrada já passou.');
  end if;
  if exists (select 1 from public.datas_bloqueadas b where b.data >= v_r.data and b.data < v_r.data_saida) then
    return jsonb_build_object('ok', false, 'codigo', 'bloqueada', 'mensagem', 'Há data bloqueada dentro deste período. Libere o bloqueio no calendário antes de aprovar.');
  end if;
  if exists (select 1 from public.reservas r
              where r.status = 'confirmada' and r.id <> v_r.id and r.data < v_r.data_saida and r.data_saida > v_r.data) then
    return jsonb_build_object('ok', false, 'codigo', 'ja_reservada', 'mensagem', 'Já existe uma reserva aprovada que ocupa alguma noite deste período.');
  end if;

  begin
    update public.reservas
       set status = 'confirmada', decidida_em = now(), decidida_por = auth.uid()
     where id = v_r.id;
  exception when unique_violation or exclusion_violation then
    return jsonb_build_object('ok', false, 'codigo', 'ja_reservada', 'mensagem', 'Já existe uma reserva aprovada que ocupa alguma noite deste período.');
  end;

  return jsonb_build_object('ok', true, 'id', v_r.id, 'status', 'confirmada');
end $$;

-- Bloquear datas à mão (uma ou várias, tudo-ou-nada). Noites que pertencem a uma reserva aprovada não podem ser bloqueadas.
create or replace function public.admin_bloquear_datas(p_datas date[], p_motivo text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_datas  date[];
  v_d      date;
  v_motivo text := nullif(left(btrim(coalesce(p_motivo, '')), 200), '');
  v_hoje   date := (now() at time zone 'America/Sao_Paulo')::date;
  v_conf   date[];
begin
  if not public.eh_admin() then
    raise exception 'acesso_negado' using errcode = '42501';
  end if;

select coalesce(array_agg(distinct u.data order by u.data), '{}') into v_datas
from unnest(coalesce(p_datas, '{}'::date[])) as u(data)
where u.data is not null;
  if coalesce(array_length(v_datas, 1), 0) = 0 or array_length(v_datas, 1) > 400 then
    return jsonb_build_object('ok', false, 'codigo', 'invalido', 'mensagem', 'Escolha de 1 a 400 datas.');
  end if;
  if v_datas[1] < v_hoje then
    return jsonb_build_object('ok', false, 'codigo', 'passada', 'mensagem', 'Não é possível bloquear datas que já passaram.');
  end if;
  if v_datas[array_length(v_datas, 1)] > v_hoje + interval '5 years' then
    return jsonb_build_object('ok', false, 'codigo', 'invalido', 'mensagem', 'Data muito distante.');
  end if;

  foreach v_d in array v_datas loop             -- ordem fixa: sem deadlock entre chamadas simultâneas
    perform public._trava_data(v_d);
  end loop;

select coalesce(array_agg(u.data order by u.data), '{}') into v_conf
  from unnest(v_datas) as u(data)
 where exists (
   select 1 from public.reservas r
   where r.status = 'confirmada'
     and u.data >= r.data
     and u.data < r.data_saida
 );
  if array_length(v_conf, 1) > 0 then
    return jsonb_build_object('ok', false, 'codigo', 'reservada',
      'mensagem', 'Há reserva aprovada em: ' || (select string_agg(to_char(u.data, 'DD/MM/YYYY'), ', ') from unnest(v_conf) as u(data))
                  || '. Cancele a reserva antes de bloquear.',
      'datas', to_jsonb(v_conf));
  end if;

  insert into public.datas_bloqueadas (data, motivo, criado_por)
  select u.data, v_motivo, auth.uid()
from unnest(v_datas) as u(data)
  on conflict (data) do update set motivo = excluded.motivo;

  return jsonb_build_object('ok', true, 'total', array_length(v_datas, 1));
end $$;

-- ---------- Permissões (mesmas da v4; só muda a assinatura de solicitar_reserva e as funções novas) ----------
revoke all on function public._agora()                          from public, anon, authenticated;
revoke all on function public.reservas_periodo()                from public, anon, authenticated;
revoke all on function public._trava_periodo(date, date)        from public, anon, authenticated;
revoke all on function public.reservas_toca_atualizada()        from public, anon, authenticated;
revoke all on function public.reservas_valida_confirmacao()     from public, anon, authenticated;
revoke all on function public.bloqueio_valida()                 from public, anon, authenticated;
revoke all on function public.datas_indisponiveis()             from public, anon, authenticated;
revoke all on function public.solicitar_reserva(date, integer, integer, boolean, text, text, text, text, date) from public, anon, authenticated;
revoke all on function public.admin_dados()                     from public, anon, authenticated;
revoke all on function public.admin_aprovar_reserva(uuid)       from public, anon, authenticated;
revoke all on function public.admin_bloquear_datas(date[], text) from public, anon, authenticated;

grant execute on function public.datas_indisponiveis() to anon, authenticated;
grant execute on function public.solicitar_reserva(date, integer, integer, boolean, text, text, text, text, date) to anon, authenticated;
grant execute on function public.admin_dados()                     to authenticated;
grant execute on function public.admin_aprovar_reserva(uuid)       to authenticated;
grant execute on function public.admin_bloquear_datas(date[], text) to authenticated;

commit;
