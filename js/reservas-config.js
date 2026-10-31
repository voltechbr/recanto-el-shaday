/* =========================================================
   Recanto El Shaday — configuração do banco de reservas (Supabase)

   Preencha os dois valores abaixo (Supabase > Project Settings > API):
     url     -> "Project URL"            ex.: https://abcdefgh.supabase.co
     anonKey -> chave PÚBLICA "anon" (JWT, começa com eyJ...) ou
                "publishable" (começa com sb_publishable_...)

   ✔ A chave anon/publishable é feita para ficar no navegador: ela só
     consegue chamar as duas funções liberadas em supabase/schema.sql.
   ✘ NUNCA coloque aqui a chave "service_role" / "secret".
   ========================================================= */
window.ELSHADAY_SUPABASE = {
  url: 'https://ourchouneoermyuzylgk.supabase.co',
  anonKey: 'sb_publishable_0slcaRHTwrOOuMK1u5sKPw_v5IbD7To'   // chave PÚBLICA (publishable): pode ficar no site
};
