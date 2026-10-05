# Chat Atendimento Petrucci

Plataforma de atendimento integrada ao WhatsApp via uazapi, com backend em Supabase e
deploy no Cloudflare Workers.

Telas: Dashboard, Inbox (Chat, Grupos e Equipe), Pendentes, Contatos, Supervisão e
Configurações. Funciona no celular.

Fork do `ChatAtendimento` da Almore. O que veio de lá em outubro/2026, o que ficou de fora
e o que falta publicar: [`docs/port-chatatendimento-2026-10.md`](docs/port-chatatendimento-2026-10.md).
Mapa do sistema (telas, banco, integrações): [`docs/mapa-sistema/`](docs/mapa-sistema/README.md).

## Desenvolvimento

```sh
npm i
npm run dev
```

Variáveis locais em `.env.local` (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PROJECT_ID`,
`VITE_SUPABASE_PUBLISHABLE_KEY`). Testes do front: `npm test`. Testes das Edge Functions:
`cd supabase/functions && deno test --allow-all --no-check`.

## Deploy

Push na `main` dispara o deploy automático do front no Cloudflare. Edge Functions e
migrations sobem à parte. Detalhes em [`docs/deploy-cloudflare.md`](docs/deploy-cloudflare.md).
