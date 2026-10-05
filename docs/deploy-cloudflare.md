# Deploy no Cloudflare Workers

O app (TanStack Start + Vite) roda como Worker no Cloudflare, com deploy automático
a cada push na `main` do repositório `carlospetruccii/chat_atendimento-petrucci`.

URL atual: `https://chat-atendimento-petrucci.re-petrucci.workers.dev`

## Repositórios

| Remote | Repositório | Uso |
|---|---|---|
| `origin` | `DesenvolvedorDevant/chat-carlos` | Original, conectado ao Lovable |
| `petrucci` | `carlospetruccii/chat_atendimento-petrucci` | Fonte do deploy no Cloudflare |

Para publicar nos dois:

```bash
git push origin main
git push petrucci main
```

> O Lovable sincroniza com o `origin`. Nunca reescrever histórico já enviado
> (force push, rebase, amend).

## Configuração do Worker

Em *Workers & Pages → chat-atendimento-petrucci → Settings → Builds*:

| Campo | Valor |
|---|---|
| Build command | `npx vite build` |
| Deploy command | `npx wrangler deploy --config .output/server/wrangler.json` |
| Root directory | `/` |
| Branch control | `main` |

Não existe `wrangler.toml` na raiz. O `vite build` gera o
`.output/server/wrangler.json`, por isso o build é obrigatório e o deploy precisa do `--config`.
Deploy manual local: `npm run deploy`.

## Variáveis de build

Em *Settings → Builds → Variables and secrets* (tipo **Variable**):

| Nome | Valor |
|---|---|
| `VITE_SUPABASE_URL` | `https://kxssjlvrbkkdicgevwtl.supabase.co` |
| `VITE_SUPABASE_PROJECT_ID` | `kxssjlvrbkkdicgevwtl` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | chave `anon`/publishable do projeto (a mesma do `.env.local`) |

São chaves **públicas** (já vão no bundle do browser). Nunca colocar `service_role` aqui.

O Vite lê essas variáveis só **no build**. Depois de alterá-las, é preciso rodar
um novo build (*Retry build*), de preferência limpando o *Build cache*.

## Problemas conhecidos

**Login dá "E-mail ou senha incorretos" só no site publicado (no localhost funciona)**
- Causa: o `.env.production` versionado no GitHub ainda apontava para o projeto Supabase antigo
  (`hfcfkxozzbrzzrejtbdj`) e o build do Cloudflare o usou.
- Como confirmar: F12 → Network → requisição `token?grant_type=password`; o domínio deve ser
  `kxssjlvrbkkdicgevwtl.supabase.co`.
- Correção: definir as 3 variáveis acima no Cloudflare. Variáveis de ambiente têm prioridade
  sobre o `.env.production`. Depois, *Retry build*.

**Build falha no passo "Deploying"**
- Causa: Build command vazio (`None`) e deploy sem `--config`, então `.output/` não existe.
- Correção: usar os comandos da tabela de configuração.

## Supabase

- Projeto atual: `kxssjlvrbkkdicgevwtl` (`supabase/config.toml`).
- Projeto antigo: `hfcfkxozzbrzzrejtbdj`. Usuários de Auth não migram sozinhos entre projetos.
