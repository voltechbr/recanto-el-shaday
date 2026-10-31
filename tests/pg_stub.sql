-- Só para TESTES locais (NÃO rode no Supabase, que já tem tudo isto).
-- Imita o mínimo do Supabase: papéis anon/authenticated e auth.users / auth.uid().
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text unique, senha_teste text);
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
grant usage on schema public, auth to anon, authenticated;
-- como no Supabase: funções novas em public nascem executáveis por anon/authenticated
alter default privileges in schema public grant execute on functions to anon, authenticated;
