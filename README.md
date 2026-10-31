# Recanto El Shaday — Hero (Etapa 1)

Abra `index.html` direto no navegador (não precisa de build).

## Estrutura
- `index.html` — header + `<section class="hero">` + seção provisória `#contato`
- `css/hero.css` — todos os estilos do hero (tokens de cor em `:root`)
- `js/hero.js` — fallback do vídeo, pausa fora da tela, paralaxe sutil dos cartões, destino do CTA
- `assets/video/piscina.webm|mp4` — vídeo otimizado (sem áudio, ~1,3–1,6 MB)
- `assets/img/poster.jpg` — imagem de fallback / carregamento

## Ligação do botão "Planejar minha visita"
Aponta para `#contato`. Para integrar a área real, crie um elemento com esse id
ou altere `CONTACT_TARGET` no topo de `js/hero.js` (atualiza todos os `[data-cta]`).

## Observações
- O vídeo original (1024×576) teve a faixa inferior recortada (marca d'água "Dola AI").
- Fontes (Fraunces/Manrope) via Google Fonts, com fallback do sistema.
- Respeita `prefers-reduced-motion` (animações e vídeo pausados).

## Ajustes finais
- `assets/img/logo.png`: logo oficial (margens transparentes cortadas; letras brancas restauradas onde a remoção de fundo as havia vazado). Usada no cabeçalho, na tela de carregamento e no favicon.
- `css/acabamento.css` + `js/acabamento.js`: acabamento do hero (foco sendo puxado, raios de sol, partículas, luz percorrendo o título, profundidade por ponteiro/rolagem) e refinos gerais. Para desfazer, remova o arquivo e a linha correspondente no `index.html`.
- Bolhas de clique: `css/efeitos.css` e `initBubbles` em `js/efeitos.js`.
- Cursor: posição aplicada direto no evento do ponteiro (sem interpolação/rAF). Fotos: arquivos disponíveis têm só 281–718 px de largura; para máxima nitidez, substitua por originais maiores em `assets/img/` (mesmos nomes).
- Logo: `assets/img/logo.png` agora vem do JPEG novo (recorte da forma original, fundo transparente; marca d'água fica de fora).
- Vídeo: removidos 8 quadros pretos do início e feito crossfade de 1 s entre fim e começo (loop contínuo).
- Fotos `momento-aerea` e `momento-piscina`: reamostradas 2x (Lanczos + nitidez leve); arquivos de origem em `assets/img/originais/`.
- Rodapé, link do WhatsApp com mensagem em "Consultar condições de reserva" e ampliação de fotos (js/acabamento.js).

## Sistema de reservas (v4 — solicitações + painel administrativo)

**Fluxo do cliente:** calendário → quantidades/taxa → revisão + contato → **Confirmar pelo WhatsApp**. O site grava uma
**solicitação PENDENTE** no banco e abre o WhatsApp com a mensagem pronta. Se o registro falhar, o WhatsApp **não** abre.

**Regras (aplicadas no banco, não só na tela):**
- Solicitação **pendente** ou **recusada** NÃO bloqueia a data (várias pendentes podem existir para o mesmo dia).
- Só a **aprovação** do administrador (status `confirmada`) bloqueia a data; **bloqueio manual** também.
- Nunca duas reservas aprovadas na mesma data (índice único parcial + trava por data) e nunca uma aprovada em data bloqueada.
- O calendário público lê o banco a cada abertura, a cada 45 s e ao voltar para a aba: aprovar/bloquear/liberar no painel aparece lá sozinho.

### Configurar (uma vez)
1. **SQL Editor → New query:** cole `supabase/schema.sql` inteiro → **Run**. Serve para instalação nova e para atualizar o banco atual
   (não apaga dados; pode rodar de novo).
2. **Authentication → Users → Add user → Create new user:** e-mail + senha fortes do proprietário, marque *Auto Confirm User*.
3. **Authentication → Sign In / Providers (ou Settings):** desative **"Allow new users to sign up"** (ninguém além de você cria conta).
4. Abra `supabase/criar-admin.sql`, troque `SEU_EMAIL_AQUI` pelo e-mail do passo 2 e rode.
5. `js/reservas-config.js` já aponta para o projeto: só a chave **pública** (publishable/anon). **Nunca** a `service_role`/`secret`.
6. Rode os blocos de `supabase/verificar.sql` um por vez e compare com o "esperado" escrito em cada um.

### Painel `/admin`
Acesse `https://SEU-SITE/admin/` (sem link no site público). Entre com o e-mail e a senha criados no passo 2.
- **Calendário:** todos os meses (12 atrás, 36 à frente); disponível / reservado / bloqueado / selo com nº de pendentes; clique no dia para bloquear, liberar ou ver pedidos; "Bloquear um período".
- **Solicitações:** dados do cliente, Aprovar / Recusar (com motivo), botão de WhatsApp.
- **Reservas confirmadas:** próximas e passadas, busca, Cancelar reserva.
A segurança é do banco: cada função `admin_*` confere se o usuário logado está em `public.administradores`.
O navegador nunca lê as tabelas diretamente (RLS nega tudo); a página só aceita carregar scripts do próprio site e falar com o Supabase (CSP).

### Publicar
Envie a pasta inteira (inclusive `admin/`) para a mesma hospedagem do site, substituindo os arquivos. Em Netlify, Vercel, Cloudflare Pages,
GitHub Pages ou hospedagem com cPanel, a pasta `admin/` com `index.html` já responde em `/admin/` (e `/admin` redireciona).
Rode o SQL **antes** de publicar o site novo: o site antigo continua funcionando com o banco novo, mas a data só passa a bloquear após aprovação.

### Testes (opcionais, não vão para o ar)
`tests/run.sh` cria um PostgreSQL temporário, aplica o `schema.sql` real e roda: `sql_tests.sql` (banco), `e2e.py` e `race.py`
(site público), `admin_e2e.py` (painel) e `diag.py`. Exige PostgreSQL local, Flask e Playwright. Não substitui o teste final no Supabase real.

### Teste final no Supabase real
1. Site em janela anônima: envie uma solicitação → a data **continua disponível** no calendário.
2. `/admin` → Solicitações → **Aprovar** → recarregue o site: a data aparece indisponível. **Cancelar reserva** → volta a ficar livre.
3. No painel, bloqueie uma data e confirme que o site a mostra indisponível.

## v5 — antecedência de 24 h e reservas de várias diárias

**O que mudou (só isto):**
- **Antecedência mínima de 24 h**, contada a partir das **10:00 (horário de Brasília)** do dia de entrada. Exatamente 24 h é permitido; menos que isso é recusado com mensagem clara, no site **e** no banco.
- **Período entrada → saída:** diárias = saída − entrada; o dia da saída **não** é cobrado nem bloqueado. Todas as noites precisam estar livres, senão o período inteiro é recusado. Máximo de **30 diárias** por reserva (limite adotado, igual no site e no banco).
- **Valores (inalterados):** diária R$ 850,00 + limpeza R$ 150,00 **uma vez** por reserva → 1 diária R$ 1.000 · 2 R$ 1.850 · 3 R$ 2.700 · 4 R$ 3.550. O banco recalcula o total; o valor do navegador não é confiável.
- Aprovada bloqueia **todas** as noites; cancelar libera todas. Pendente continua **não** bloqueando. Bloqueio manual impede períodos que o incluam.
- Painel `/admin`: cartões mostram Entrada, Saída e Diárias; aprovar/recusar/cancelar valem para o período inteiro.
- Reservas antigas viram automaticamente **1 diária** (nada é apagado nem alterado nos dados do cliente).

### Como atualizar o Supabase (ordem)
1. (Recomendado) Faça um backup: *Database → Backups* ou exporte a tabela `reservas`.
2. **SQL Editor → New query:** cole `supabase/migracoes/2026-10-31_antecedencia-24h-e-varias-diarias.sql` inteiro → **Run**. É idempotente (pode rodar de novo) e roda em uma transação: se der erro, nada é alterado. **Não** rode o `schema.sql` antigo (v4) por cima.
3. Rode os blocos de `supabase/verificar.sql` um por vez e compare com o "esperado" (blocos 7–9 são novos).
4. Só depois publique o site (próximo passo). O site antigo continua funcionando com o banco novo (sem `data_saida` = 1 diária).

`supabase/schema.sql` agora é a versão v5 consolidada, só para **instalação nova**.

### Como publicar
Envie a pasta inteira (inclusive `admin/`) para a hospedagem, substituindo os arquivos. Arquivos alterados: `index.html`, `js/reserva-modal.js`, `css/reserva-modal.css`, `admin/admin.js`.

### Testes (v5)
`bash tests/run.sh` (SQL 48 + 59, site 84, painel 44, concorrência) e `bash tests/test_migracao.sh` (migração sobre base v4 com dados antigos, schema sobre v4 e instalação nova; confere que as reservas antigas ficam idênticas, permissões e RLS inalterados). Tudo passou. Nada foi executado no Supabase real.
