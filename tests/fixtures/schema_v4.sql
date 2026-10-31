-- =========================================================
-- Recanto El Shaday — banco de reservas + painel administrativo (Supabase / PostgreSQL)  ·  v4
--
-- COMO EXECUTAR: Supabase > SQL Editor > New query > cole TUDO > Run.
-- Serve para instalação nova E para atualizar o banco que já está no ar (v3):
--   * é idempotente (pode rodar de novo sem problema);
--   * NÃO apaga nem altera nenhum dado existente (só adiciona colunas/tabelas/funções);
--   * roda dentro de uma transação: se algo falhar, nada é aplicado.
-- Depois: rode supabase/criar-admin.sql (cadastra o proprietário) e supabase/verificar.sql (conferência).
--
-- NOVA LÓGICA DE RESERVAS (v4)
--   pendente   -> o cliente enviou o formulário.  NÃO bloqueia a data.
--   confirmada -> o administrador APROVOU.        BLOQUEIA a data.   (= "aprovada")
--   recusada / cancelada / expirada               -> NÃO bloqueiam a data.
--   Bloqueio manual (tabela datas_bloqueadas)     -> data indisponível.
--   Várias solicitações pendentes podem existir para a mesma data; só UMA pode ser confirmada
--   (índice único parcial no banco) e uma data bloqueada à mão nunca pode ser confirmada.
--   A antiga liberação automática de 48 h deixou de existir: a pendente não bloqueia nada, então
--   ela fica na fila até o administrador aprovar ou recusar.
--
-- SEGURANÇA
--  * As tabelas têm RLS ligado + política que NEGA tudo a anon/authenticated + REVOKE de todos
--    os privilégios: o navegador nunca lê nem grava nelas diretamente.
--  * O site público só pode chamar 2 funções: datas_indisponiveis() e solicitar_reserva().
--  * O painel só pode chamar as funções admin_*() e eh_admin(), liberadas APENAS ao papel
--    "authenticated"; cada uma confere, dentro do banco, se o usuário logado está na tabela
--    public.administradores. Quem não estiver recebe "acesso_negado" (HTTP 403).
--  * Todas as funções são SECURITY DEFINER com search_path vazio (referências qualificadas).
--  * Nenhuma chave secreta é usada no site: só a chave pública (anon/publishable) + o login do admin.
-- =========================================================

begin;

-- ---------- Limpeza de assinaturas/versões antigas (só funções, nenhum dado) ----------
drop function if exists public.solicitar_reserva(date, integer, integer, boolean, text, text, text);
drop function if exists public.solicitar_reserva(date, integer, integer, boolean, text, text, text, text);
drop function if exists public.datas_indisponiveis();
drop function if exists public._prazo_pendente();      -- v3: prazo de 48 h, não existe mais

-- ---------- Tabela de reservas (igual à v3; só cria se ainda não existir) ----------
create table if not exists public.reservas (
  id                 uuid primary key default gen_random_uuid(),
  data               date        not null,
  adultos            integer     not null,
  criancas           integer     not null,
  taxa_limpeza       boolean     not null default false,
  valor_diaria       integer     not null,          -- centavos
  valor_limpeza      integer     not null,          -- centavos
  valor_total        integer     not null,          -- centavos
  nome               text        not null,
  telefone           text        not null,          -- só dígitos, sem DDI
  email              text,
  status             text        not null default 'pendente',
  token              text,                          -- identifica a tentativa (reenvio seguro)
  criada_em          timestamptz not null default now(),
  atualizada_em      timestamptz not null default now(),
  observacao_interna text
);

alter table public.reservas add column if not exists token text;
alter table public.reservas add column if not exists observacao_interna text;
alter table public.reservas add column if not exists atualizada_em timestamptz not null default now();
-- v4: quem/quando decidiu (aprovou, recusou, cancelou)
alter table public.reservas add column if not exists decidida_em  timestamptz;
alter table public.reservas add column if not exists decidida_por uuid;

alter table public.reservas drop constraint if exists reservas_status_check;
alter table public.reservas drop constraint if exists reservas_status_chk;
alter table public.reservas add constraint reservas_status_chk
  check (status in ('pendente','confirmada','recusada','cancelada','expirada'));
alter table public.reservas drop constraint if exists reservas_pessoas_chk;
alter table public.reservas add constraint reservas_pessoas_chk
  check (adultos between 1 and 100 and criancas between 0 and 100 and adultos + criancas <= 100);
alter table public.reservas drop constraint if exists reservas_nome_chk;
alter table public.reservas add constraint reservas_nome_chk check (char_length(nome) between 3 and 120);
alter table public.reservas drop constraint if exists reservas_telefone_chk;
alter table public.reservas add constraint reservas_telefone_chk check (char_length(telefone) between 10 and 20);
alter table public.reservas drop constraint if exists reservas_email_chk;
alter table public.reservas add constraint reservas_email_chk check (email is null or char_length(email) <= 160);

-- A TRAVA (v4): no máximo UMA reserva CONFIRMADA por data. Pendentes não entram na regra.
-- (cria o índice novo ANTES de remover o antigo, que considerava também as pendentes)
create unique index if not exists reservas_data_confirmada_unica
  on public.reservas (data)
  where status = 'confirmada';
drop index if exists public.reservas_data_ativa_unica;

create index if not exists reservas_status_idx   on public.reservas (status, data);
create index if not exists reservas_telefone_idx on public.reservas (telefone, status);
create index if not exists reservas_token_idx    on public.reservas (token) where token is not null;
create index if not exists reservas_criada_idx   on public.reservas (criada_em);

create or replace function public.reservas_toca_atualizada()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.atualizada_em := now();
  return new;
end $$;

drop trigger if exists reservas_atualizada on public.reservas;
create trigger reservas_atualizada before update on public.reservas
  for each row execute function public.reservas_toca_atualizada();

-- ---------- Datas bloqueadas à mão pelo proprietário ----------
create table if not exists public.datas_bloqueadas (
  data   date primary key,
  motivo text
);
alter table public.datas_bloqueadas add column if not exists criado_em  timestamptz not null default now();
alter table public.datas_bloqueadas add column if not exists criado_por uuid;

-- ---------- Administradores (v4) ----------
-- Quem está nesta tabela (e logado no Supabase Auth) pode usar o painel. É preenchida por
-- supabase/criar-admin.sql, rodado por você no SQL Editor. O navegador não consegue ler nem gravar aqui.
create table if not exists public.administradores (
  user_id   uuid primary key references auth.users (id) on delete cascade,
  email     text,
  criado_em timestamptz not null default now()
);

-- ---------- Acesso direto às tabelas: NEGADO ao público e a qualquer usuário logado ----------
alter table public.reservas         enable row level security;
alter table public.datas_bloqueadas enable row level security;
alter table public.administradores  enable row level security;

revoke all on public.reservas         from public, anon, authenticated;
revoke all on public.datas_bloqueadas from public, anon, authenticated;
revoke all on public.administradores  from public, anon, authenticated;

drop policy if exists negar_acesso_publico on public.reservas;
create policy negar_acesso_publico on public.reservas
  for all to anon, authenticated using (false) with check (false);

drop policy if exists negar_acesso_publico on public.datas_bloqueadas;
create policy negar_acesso_publico on public.datas_bloqueadas
  for all to anon, authenticated using (false) with check (false);

drop policy if exists negar_acesso_publico on public.administradores;
create policy negar_acesso_publico on public.administradores
  for all to anon, authenticated using (false) with check (false);

-- ---------- Funções internas ----------
-- Quem está logado é administrador?
create or replace function public.eh_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.administradores a where a.user_id = auth.uid());
$$;

-- Trava (até o fim da transação) as operações sobre UMA data: aprovar, bloquear e solicitar
-- passam por aqui, então não há corrida entre "aprovar" e "bloquear" a mesma data.
create or replace function public._trava_data(p_data date)
returns void
language sql
volatile
set search_path = ''
as $$
  select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('el-shaday:data:' || p_data::text, 0));
$$;

-- Rede de segurança no banco (vale também para quem edita pelo Table Editor):
-- uma reserva só vira "confirmada" se a data NÃO estiver bloqueada à mão...
create or replace function public.reservas_valida_confirmacao()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'confirmada'
     and (tg_op = 'INSERT' or old.status is distinct from 'confirmada' or old.data is distinct from new.data) then
    perform public._trava_data(new.data);
    if exists (select 1 from public.datas_bloqueadas b where b.data = new.data) then
      raise exception 'Data % bloqueada manualmente: libere o bloqueio antes de confirmar a reserva.', new.data;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists reservas_valida_confirmacao on public.reservas;
create trigger reservas_valida_confirmacao before insert or update on public.reservas
  for each row execute function public.reservas_valida_confirmacao();

-- ...e uma data só pode ser bloqueada à mão se NÃO houver reserva confirmada nela.
create or replace function public.bloqueio_valida()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform public._trava_data(new.data);
  if exists (select 1 from public.reservas r where r.data = new.data and r.status = 'confirmada') then
    raise exception 'Já existe reserva confirmada em %: cancele a reserva antes de bloquear a data.', new.data;
  end if;
  return new;
end $$;

drop trigger if exists bloqueio_valida on public.datas_bloqueadas;
create trigger bloqueio_valida before insert or update of data on public.datas_bloqueadas
  for each row execute function public.bloqueio_valida();

-- =========================================================
-- RPCs PÚBLICAS (site)
-- =========================================================

-- Quais datas estão ocupadas? (devolve SÓ datas)  v4: confirmadas + bloqueios manuais.
-- Pendentes e recusadas NÃO aparecem aqui.
create or replace function public.datas_indisponiveis()
returns table (data date)
language sql
stable
security definer
set search_path = ''
as $$
  select r.data
    from public.reservas r
   where r.data >= (now() at time zone 'America/Sao_Paulo')::date
     and r.status = 'confirmada'
  union
  select b.data
    from public.datas_bloqueadas b
   where b.data >= (now() at time zone 'America/Sao_Paulo')::date;
$$;

-- Solicitar a reserva: valida + grava uma solicitação PENDENTE (não bloqueia a data).
-- Retorna jsonb:
--   {"ok":true,  "id":"...", "total":85000}
--   {"ok":false, "codigo":"indisponivel" | "invalido" | "limite" | "duplicada", "mensagem":"..."}
create or replace function public.solicitar_reserva(
  p_data     date,
  p_adultos  integer,
  p_criancas integer,
  p_limpeza  boolean,
  p_nome     text,
  p_telefone text,
  p_email    text default null,
  p_token    text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c_diaria  constant integer := 85000;   -- R$ 850,00
  c_limpeza constant integer := 15000;   -- R$ 150,00
  v_hoje    date := (now() at time zone 'America/Sao_Paulo')::date;
  v_nome    text;
  v_tel     text;
  v_email   text;
  v_token   text;
  v_taxa    integer;
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
  if p_data is null or p_data < v_hoje or p_data > v_hoje + interval '25 months' then
    return jsonb_build_object('ok', false, 'codigo', 'invalido', 'mensagem', 'Data inválida. Escolha outra data.');
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
    select r.id, r.valor_total into v_ex
      from public.reservas r
     where r.token = v_token and r.data = p_data and r.telefone = v_tel
       and r.status in ('pendente','confirmada')
     limit 1;
    if found then
      return jsonb_build_object('ok', true, 'id', v_ex.id, 'total', v_ex.valor_total);
    end if;
  end if;

  -- 3) proteção contra abuso (serializa por telefone para o limite ser atômico)
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_tel, 0));
  if exists (select 1 from public.reservas r where r.telefone = v_tel and r.data = p_data and r.status = 'pendente') then
    return jsonb_build_object('ok', false, 'codigo', 'duplicada',
      'mensagem', 'Você já enviou uma solicitação para esta data. Fale com a chácara pelo WhatsApp para ajustar.');
  end if;
  if (select count(*) from public.reservas r where r.telefone = v_tel and r.status = 'pendente') >= 2 then
    return jsonb_build_object('ok', false, 'codigo', 'limite',
      'mensagem', 'Já existem solicitações em andamento para este telefone. Fale com a chácara pelo WhatsApp para ajustar.');
  end if;
  if (select count(*) from public.reservas r where r.criada_em > now() - interval '1 hour') >= 40 then
    return jsonb_build_object('ok', false, 'codigo', 'limite',
      'mensagem', 'Muitas solicitações no momento. Tente novamente em alguns minutos.');
  end if;

  -- 4) a data está livre? (bloqueio manual ou reserva CONFIRMADA = indisponível; pendente não conta)
  perform public._trava_data(p_data);
  if exists (select 1 from public.datas_bloqueadas b where b.data = p_data)
     or exists (select 1 from public.reservas r where r.data = p_data and r.status = 'confirmada') then
    return jsonb_build_object('ok', false, 'codigo', 'indisponivel', 'mensagem', 'Essa data não está mais disponível.');
  end if;

  v_taxa := case when coalesce(p_limpeza, false) then c_limpeza else 0 end;

  -- 5) grava SOMENTE uma solicitação pendente (status padrão). Não bloqueia a data.
  insert into public.reservas
    (data, adultos, criancas, taxa_limpeza, valor_diaria, valor_limpeza, valor_total, nome, telefone, email, token, status)
  values
    (p_data, p_adultos, p_criancas, coalesce(p_limpeza, false), c_diaria, v_taxa, c_diaria + v_taxa, v_nome, v_tel, v_email, v_token, 'pendente')
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'total', c_diaria + v_taxa);
end $$;

-- =========================================================
-- RPCs DO PAINEL (só administrador logado)
-- =========================================================

-- Tudo que o painel precisa para desenhar as telas, numa chamada só.
-- reservas: todas as pendentes e confirmadas + as 300 decididas/expiradas mais recentes.
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
      select r.id, r.data, r.adultos, r.criancas, r.taxa_limpeza, r.valor_diaria, r.valor_limpeza, r.valor_total,
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

-- Aprovar: a reserva vira "confirmada" e a data passa a ficar bloqueada no site.
-- Retorna {"ok":true,...} ou {"ok":false,"codigo":"bloqueada|ja_reservada|passada|status_invalido|nao_encontrada","mensagem":"..."}
create or replace function public.admin_aprovar_reserva(p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_data date;
  v_r    record;
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  if not public.eh_admin() then
    raise exception 'acesso_negado' using errcode = '42501';
  end if;

  select r.data into v_data from public.reservas r where r.id = p_id;
  if not found then
    return jsonb_build_object('ok', false, 'codigo', 'nao_encontrada', 'mensagem', 'Solicitação não encontrada.');
  end if;

  perform public._trava_data(v_data);
  select r.* into v_r from public.reservas r where r.id = p_id for update;

  if v_r.status = 'confirmada' then
    return jsonb_build_object('ok', true, 'id', v_r.id, 'status', 'confirmada');        -- já estava aprovada
  end if;
  if v_r.status not in ('pendente', 'recusada', 'expirada') then
    return jsonb_build_object('ok', false, 'codigo', 'status_invalido', 'mensagem', 'Esta solicitação não pode mais ser aprovada.');
  end if;
  if v_r.data < v_hoje then
    return jsonb_build_object('ok', false, 'codigo', 'passada', 'mensagem', 'Essa data já passou.');
  end if;
  if exists (select 1 from public.datas_bloqueadas b where b.data = v_r.data) then
    return jsonb_build_object('ok', false, 'codigo', 'bloqueada', 'mensagem', 'Essa data está bloqueada. Libere o bloqueio no calendário antes de aprovar.');
  end if;
  if exists (select 1 from public.reservas r where r.data = v_r.data and r.status = 'confirmada' and r.id <> v_r.id) then
    return jsonb_build_object('ok', false, 'codigo', 'ja_reservada', 'mensagem', 'Já existe uma reserva aprovada para essa data.');
  end if;

  begin
    update public.reservas
       set status = 'confirmada', decidida_em = now(), decidida_por = auth.uid()
     where id = v_r.id;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'codigo', 'ja_reservada', 'mensagem', 'Já existe uma reserva aprovada para essa data.');
  end;

  return jsonb_build_object('ok', true, 'id', v_r.id, 'status', 'confirmada');
end $$;

-- Recusar uma solicitação pendente (não bloqueia nada; o motivo fica só nas notas internas).
create or replace function public.admin_recusar_reserva(p_id uuid, p_motivo text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_r      record;
  v_motivo text := nullif(left(btrim(coalesce(p_motivo, '')), 300), '');
begin
  if not public.eh_admin() then
    raise exception 'acesso_negado' using errcode = '42501';
  end if;

  select r.* into v_r from public.reservas r where r.id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'codigo', 'nao_encontrada', 'mensagem', 'Solicitação não encontrada.');
  end if;
  if v_r.status = 'recusada' then
    return jsonb_build_object('ok', true, 'id', v_r.id, 'status', 'recusada');
  end if;
  if v_r.status <> 'pendente' then
    return jsonb_build_object('ok', false, 'codigo', 'status_invalido',
      'mensagem', case when v_r.status = 'confirmada' then 'Esta reserva já foi aprovada. Use "Cancelar reserva" para liberar a data.'
                       else 'Esta solicitação não está mais pendente.' end);
  end if;

  update public.reservas
     set status = 'recusada', decidida_em = now(), decidida_por = auth.uid(),
         observacao_interna = coalesce(observacao_interna || E'\n', '') ||
           'Recusada' || coalesce(': ' || v_motivo, '.')
   where id = v_r.id;

  return jsonb_build_object('ok', true, 'id', v_r.id, 'status', 'recusada');
end $$;

-- Cancelar uma reserva já aprovada: a data volta a ficar livre no site.
create or replace function public.admin_cancelar_reserva(p_id uuid, p_motivo text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_r      record;
  v_motivo text := nullif(left(btrim(coalesce(p_motivo, '')), 300), '');
begin
  if not public.eh_admin() then
    raise exception 'acesso_negado' using errcode = '42501';
  end if;

  select r.* into v_r from public.reservas r where r.id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'codigo', 'nao_encontrada', 'mensagem', 'Reserva não encontrada.');
  end if;
  if v_r.status = 'cancelada' then
    return jsonb_build_object('ok', true, 'id', v_r.id, 'status', 'cancelada');
  end if;
  if v_r.status <> 'confirmada' then
    return jsonb_build_object('ok', false, 'codigo', 'status_invalido', 'mensagem', 'Só é possível cancelar uma reserva aprovada.');
  end if;

  update public.reservas
     set status = 'cancelada', decidida_em = now(), decidida_por = auth.uid(),
         observacao_interna = coalesce(observacao_interna || E'\n', '') ||
           'Cancelada' || coalesce(': ' || v_motivo, '.')
   where id = v_r.id;

  return jsonb_build_object('ok', true, 'id', v_r.id, 'status', 'cancelada');
end $$;

-- Bloquear datas à mão (uma ou várias, tudo-ou-nada). Datas com reserva aprovada não podem ser bloqueadas.
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

  select coalesce(array_agg(distinct d order by d), '{}') into v_datas from unnest(coalesce(p_datas, '{}')) as d where d is not null;
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

  select coalesce(array_agg(r.data order by r.data), '{}') into v_conf
    from public.reservas r where r.status = 'confirmada' and r.data = any (v_datas);
  if array_length(v_conf, 1) > 0 then
    return jsonb_build_object('ok', false, 'codigo', 'reservada',
      'mensagem', 'Há reserva aprovada em: ' || (select string_agg(to_char(x, 'DD/MM/YYYY'), ', ') from unnest(v_conf) as x)
                  || '. Cancele a reserva antes de bloquear.',
      'datas', to_jsonb(v_conf));
  end if;

  insert into public.datas_bloqueadas (data, motivo, criado_por)
  select d, v_motivo, auth.uid() from unnest(v_datas) as d
  on conflict (data) do update set motivo = excluded.motivo;

  return jsonb_build_object('ok', true, 'total', array_length(v_datas, 1));
end $$;

-- Liberar datas bloqueadas à mão (não mexe em reservas).
create or replace function public.admin_liberar_datas(p_datas date[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if not public.eh_admin() then
    raise exception 'acesso_negado' using errcode = '42501';
  end if;
  if coalesce(array_length(p_datas, 1), 0) = 0 or array_length(p_datas, 1) > 400 then
    return jsonb_build_object('ok', false, 'codigo', 'invalido', 'mensagem', 'Escolha de 1 a 400 datas.');
  end if;

  delete from public.datas_bloqueadas where data = any (p_datas);
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'liberadas', v_n);
end $$;

-- ---------- Permissões das funções ----------
-- (o Supabase concede EXECUTE a anon/authenticated por padrão em funções novas:
--  por isso tudo é revogado primeiro e só o necessário é liberado)
revoke all on function public.reservas_toca_atualizada()        from public, anon, authenticated;
revoke all on function public.reservas_valida_confirmacao()     from public, anon, authenticated;
revoke all on function public.bloqueio_valida()                 from public, anon, authenticated;
revoke all on function public._trava_data(date)                 from public, anon, authenticated;
revoke all on function public.eh_admin()                        from public, anon, authenticated;
revoke all on function public.datas_indisponiveis()             from public, anon, authenticated;
revoke all on function public.solicitar_reserva(date, integer, integer, boolean, text, text, text, text) from public, anon, authenticated;
revoke all on function public.admin_dados()                     from public, anon, authenticated;
revoke all on function public.admin_aprovar_reserva(uuid)       from public, anon, authenticated;
revoke all on function public.admin_recusar_reserva(uuid, text) from public, anon, authenticated;
revoke all on function public.admin_cancelar_reserva(uuid, text) from public, anon, authenticated;
revoke all on function public.admin_bloquear_datas(date[], text) from public, anon, authenticated;
revoke all on function public.admin_liberar_datas(date[])       from public, anon, authenticated;

-- site público
grant execute on function public.datas_indisponiveis() to anon, authenticated;
grant execute on function public.solicitar_reserva(date, integer, integer, boolean, text, text, text, text) to anon, authenticated;
-- painel: SOMENTE usuário logado (e cada função ainda confere se ele é administrador)
grant execute on function public.eh_admin()                        to authenticated;
grant execute on function public.admin_dados()                     to authenticated;
grant execute on function public.admin_aprovar_reserva(uuid)       to authenticated;
grant execute on function public.admin_recusar_reserva(uuid, text) to authenticated;
grant execute on function public.admin_cancelar_reserva(uuid, text) to authenticated;
grant execute on function public.admin_bloquear_datas(date[], text) to authenticated;
grant execute on function public.admin_liberar_datas(date[])       to authenticated;

commit;
