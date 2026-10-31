-- =========================================================
-- Cadastra o PROPRIETÁRIO como administrador do painel (/admin).
-- Rode DEPOIS do schema.sql e DEPOIS de criar o usuário em Authentication > Users (veja o README).
-- 1) Troque SEU_EMAIL_AQUI pelo e-mail do usuário que você criou no Supabase Auth.
-- 2) Rode. O resultado deve mostrar 1 linha. Se vier vazio, o e-mail não confere com nenhum usuário.
-- Para remover o acesso depois: delete from public.administradores where email = 'SEU_EMAIL_AQUI';
-- =========================================================
insert into public.administradores (user_id, email)
select u.id, u.email
  from auth.users u
 where lower(u.email) = lower('SEU_EMAIL_AQUI')
on conflict (user_id) do nothing;

select user_id, email, criado_em from public.administradores;
