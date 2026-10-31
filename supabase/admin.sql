-- =========================================================
-- Recanto El Shaday — rotinas manuais do responsável (Supabase > SQL Editor)  ·  v4
-- O dia a dia agora é feito pelo painel /admin. Isto é só um plano B / consulta avançada.
-- Só quem tem acesso ao painel do Supabase consegue executar isto (o SQL Editor ignora o RLS).
-- Regras do banco continuam valendo: uma só reserva CONFIRMADA por data e nenhuma confirmada em data bloqueada.
-- =========================================================

-- 1) Solicitações que aguardam resposta (pendente NÃO bloqueia a data)
select data, nome, telefone, email, adultos, criancas, taxa_limpeza,
       valor_total / 100.0 as total_reais, criada_em
  from public.reservas
 where status = 'pendente' and data >= current_date
 order by data, criada_em;

-- 2) Reservas aprovadas (que bloqueiam o calendário)
select data, nome, telefone, valor_total / 100.0 as total_reais
  from public.reservas
 where status = 'confirmada' and data >= current_date
 order by data;

-- 3) APROVAR (a data passa a ficar bloqueada no site). Dá erro se a data já tem outra aprovada ou está bloqueada à mão.
update public.reservas set status = 'confirmada', decidida_em = now()
 where id = 'COLE-O-ID-AQUI' and status = 'pendente';

-- 4) RECUSAR
update public.reservas set status = 'recusada', decidida_em = now()
 where id = 'COLE-O-ID-AQUI' and status = 'pendente';

-- 5) CANCELAR uma reserva já aprovada (a data volta a ficar livre)
update public.reservas set status = 'cancelada', decidida_em = now()
 where id = 'COLE-O-ID-AQUI' and status = 'confirmada';

-- 6) Bloquear / desbloquear uma data à mão
insert into public.datas_bloqueadas (data, motivo) values ('2026-12-25', 'Uso da família') on conflict (data) do nothing;
delete from public.datas_bloqueadas where data = '2026-12-25';
