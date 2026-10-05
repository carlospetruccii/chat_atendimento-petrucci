# Chat Atendimento Petrucci

Plataforma de atendimento (inbox, contatos, supervisão) integrada ao WhatsApp via uazapi,
com backend em Supabase e deploy no Cloudflare Workers.

## Desenvolvimento

```sh
npm i
npm run dev
```

Variáveis locais em `.env.local` (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PROJECT_ID`,
`VITE_SUPABASE_PUBLISHABLE_KEY`). Testes: `npm test`.

## Deploy

Push na `main` dispara o deploy automático no Cloudflare. Detalhes em
[`docs/deploy-cloudflare.md`](docs/deploy-cloudflare.md).
