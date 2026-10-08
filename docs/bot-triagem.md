# Bot de triagem — Parabrisas Petrucci

O bot (`triagem-bot`) cumprimenta o cliente, mostra o menu de setores e manda a conversa
para a fila **Pendentes** do setor escolhido.

> **Estado: DESLIGADO.** `system_config.bot_ativo = 'false'` e o cron `triagem-bot` está
> inativo. Só ligar quando o dono pedir. Ligar dispara WhatsApp para cliente real.

---

## Como funciona (o que o cliente vê)

1. Cliente manda mensagem → o webhook cria o atendimento em triagem.
2. O bot espera o cliente parar de digitar (`delay_anti_flood_triagem`, 8 s) e manda:
   - boas-vindas: *"Olá! 👋 Você chegou ao atendimento da Parabrisas Petrucci."*
   - pergunta + lista interativa "Ver setores" (rodapé "Parabrisas Petrucci").
3. Cliente toca na opção ou digita o número/nome do setor. Regras da leitura do texto
   (`identificarPorTexto` em `triagem-bot/logic.ts`, trazido do Almore `926c795`):
   - só palavra inteira; aceita singular/plural ("venda" → Vendas);
   - "sem" sozinho não conta ("estou sem vidro" não vai para Sem parar);
   - mensagem com e-mail, link ou caminho nunca escolhe setor;
   - número no meio de frase só vale com intenção clara ("opção 2", não "protocolo 2").
4. Bot confirma (*"Certo! Te encaminhei para \*Vendas\*…"*) e a conversa vai para
   Pendentes do setor (ou direto para o último atendente daquele setor, se houver).
5. Resposta que o bot não entende → *"Não consegui entender…"* e repete o menu.
   Depois de `triagem_max_tentativas` (2) vai para Pendentes geral.
6. Cliente sumiu no meio → lembrete depois de 30 min (só em horário comercial).

## Menu

| Nº | Setor | Cor |
|---|---|---|
| 1 | Vendas | verde |
| 2 | Suporte | azul |
| 3 | Financeiro | laranja |
| 4 | Sem parar | roxo |

- A ordem vem da coluna `departments.ordem` (1 = primeiro; empate desempata pelo nome).
- Muda pelas setinhas ↑↓ na aba **Configurações → Departamentos**. Elas pulam setor
  inativo (que não aparece no menu).
- Setor novo entra no fim.
- As outras listas de setor (Pendentes, Dashboard, Iniciar atendimento) seguem a mesma
  ordem.

## Textos do bot

Editáveis na aba **Templates**:

| Chave | Quando sai |
|---|---|
| `triagem_boas_vindas` | primeira mensagem |
| `triagem_pergunta_departamento` | pergunta do setor (`{{lista_departamentos}}`) |
| `triagem_confirmacao` | depois de escolher (`{{departamento}}`) |
| `triagem_erro_formato` | resposta não entendida |
| `triagem_lembrete_sem_resposta` | cliente parou no meio |

## Conversa iniciada pelo celular da empresa

Quando alguém responde pelo celular da empresa um cliente sem atendimento aberto, o
webhook cria o atendimento no setor de `system_config.triagem_departamento_default`
(hoje: **Vendas**). Antes de existirem setores essa mensagem era descartada.

---

## O que foi feito (06 e 08/10/2026)

O banco tinha sido criado só com o schema do Almore, sem dados. Faltava:

| Faltava | Efeito | Solução |
|---|---|---|
| Usuário de sistema **Bot** (`…0001`) | toda mensagem do bot falhava (FK) e a triagem entrava em loop | seed |
| Departamentos | bot mandava tudo para Pendentes geral | seed com os 4 setores |
| Textos do bot | bot não tinha o que mandar | seed com os 5 textos |
| Ordem do menu | menu saía alfabético (Financeiro, Sem parar, Suporte, Vendas) | coluna `ordem` |
| Nome da empresa | rodapé e telas diziam "Almore" | trocado por "Parabrisas Petrucci" |

### Banco (aplicado pelo MCP do Supabase)

| Migration | O que faz |
|---|---|
| `20261006120000_departamentos_ordem.sql` | coluna `ordem` (NOT NULL, DEFAULT 0), trigger `departments_definir_ordem` (setor novo no fim), RPC `reordenar_departamentos(uuid[])` |
| `20261006120500_seed_bot_parabrisas_petrucci.sql` | usuários Bot/Sistema, 4 setores, 5 textos |
| `20261008120000_departamento_padrao_externo.sql` | setor padrão = Vendas |

- Tudo idempotente (`ON CONFLICT DO NOTHING`, `IF NOT EXISTS`): rodar de novo não
  duplica nem sobrescreve o que foi editado na tela.
- `reordenar_departamentos` é SECURITY INVOKER: a RLS de UPDATE de `departments`
  (só admin) decide quem pode. Recusa lista vazia, id repetido e id que não existe.
- No histórico do banco elas ficaram com o horário da aplicação, não o do nome do
  arquivo (igual às anteriores). **Não use `supabase db push`** — ver
  [port-chatatendimento-2026-10.md](port-chatatendimento-2026-10.md#banco).

### Edge Function

- `triagem-bot` publicada (v3) em 06/10/2026 e (v4) em 08/10/2026.
- Fila do bot (v4): só pega conversa com mensagem **depois** de o bot ser ligado
  (`last_message_at >= bot_ativado_em`), da mais recente para a mais antiga. Antes,
  os ~180 `em_triagem` antigos ocupavam as 50 vagas e o bot nunca chegava nos novos.
- A lógica nova fica em `supabase/functions/triagem-bot/logic.ts`
  (`ordenarDepartamentos`, `LIST_TITULO`).

### Front (commits `4c6c3c0`, `ae23388`)

- `src/lib/departamentos-ordem.ts` — `moverDepartamento` (setinhas).
- `src/components/DepartamentosTab.tsx` — botões ↑↓ no celular e no desktop.
- `src/lib/configuracoes-queries.ts` — `reordenarDepartamentos`.
- "Almore" → "Parabrisas Petrucci": login, título da aba, Conexão, Horário,
  Colaboradores, Contatos. A rota interna `/almore` ficou como está.

### Testes

| Teste | Como rodar |
|---|---|
| `src/lib/departamentos-ordem.test.ts` | `npm test` |
| `supabase/functions/triagem-bot/logic.test.ts` | `cd supabase/functions && deno test --allow-all --no-check` |
| `supabase/tests/departamentos_ordem.test.sql` | rodar no SQL do Supabase (BEGIN/ROLLBACK, não grava nada). Também confere que `bot_ativo` é `false`. |

### Revisões

Código, segurança Supabase e pré-deploy: nenhum problema CRITICAL ou HIGH. Corrigido
na revisão: setinha pulando setor inativo e DEFAULT 0 na `ordem` (sem ele, regerar os
tipos quebraria o cadastro de setor).

---

## Como ligar o bot (só quando o dono pedir)

1. Cadastrar os colaboradores em cada setor (aba **Colaboradores**). Sem eles a
   conversa fica em Pendentes e só os admins veem.
2. Conferir os textos na aba **Templates**.
3. Conferir o horário comercial (aba **Horário**) — o lembrete só sai dentro dele.
4. Ligar na aba **Operação**. Isso grava `bot_ativado_em`: mensagens que chegaram
   **antes** de ligar são ignoradas (não há disparo em massa para conversas antigas).
5. Conferir que o cron `triagem-bot` ficou ativo e acompanhar os logs da função.

Para desligar: aba **Operação** de novo. O bot checa `bot_ativo` antes de qualquer
envio.

## Como desfazer o seed

Só funciona enquanto nenhum atendimento usar os setores (`atendimentos` tem
`ON DELETE RESTRICT`):

```sql
DELETE FROM system_config WHERE chave = 'triagem_departamento_default';
DELETE FROM templates_mensagem WHERE chave IN ('triagem_boas_vindas',
  'triagem_pergunta_departamento', 'triagem_confirmacao', 'triagem_erro_formato',
  'triagem_lembrete_sem_resposta');
DELETE FROM departments WHERE nome IN ('Vendas', 'Suporte', 'Financeiro', 'Sem parar');
```

Os usuários Bot/Sistema devem ficar (o código depende deles).

## Pendências

- Cadastrar os colaboradores.
- Cadastrar o horário comercial (aba **Horário**): sem ele o lembrete "ainda está aí?"
  nunca sai.
- Ao ligar o bot, ligar junto o cron `cron-retry-mensagens-falha` (no Almore fica ligado).
  Ele respeita `bot_ativo`, então desligado não faz nada.
- Textos do fluxo interno de **Sessões** (`sessao_*`) ainda não existem; nesse fluxo
  o bot fica mudo.
- A página de retorno do login do Google ainda diz "Almore"
  (`supabase/functions/google-contacts`, exige publicar a função).
- `carregarDepartamentos` no bot não filtra por empresa (só importa se um dia houver
  mais de uma empresa).
