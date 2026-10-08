# Bot de triagem — Parabrisas Petrucci

O bot (`triagem-bot`) cumprimenta o cliente, mostra o menu de setores e manda a conversa
para a fila **Pendentes** do setor escolhido.

**Estado: DESLIGADO.** `system_config.bot_ativo = 'false'` e o cron `triagem-bot` está
inativo. Só ligar quando o dono pedir (aba **Operação**).

## Menu

| Nº | Setor |
|---|---|
| 1 | Vendas |
| 2 | Suporte |
| 3 | Financeiro |
| 4 | Sem parar |

- A ordem vem da coluna `departments.ordem` e muda pelas setinhas ↑↓ na aba
  **Departamentos**. Setor inativo não aparece no menu.
- Setor novo entra no fim.
- Os textos ficam na aba **Templates** (`triagem_boas_vindas`,
  `triagem_pergunta_departamento`, `triagem_confirmacao`, `triagem_erro_formato`,
  `triagem_lembrete_sem_resposta`).

## Conversa iniciada pelo celular da empresa

Cai no setor de `system_config.triagem_departamento_default` (hoje: **Vendas**).

## Migrations (aplicadas em 06 e 08/10/2026 pelo MCP)

- `20261006120000_departamentos_ordem.sql` — coluna `ordem`, trigger, RPC
  `reordenar_departamentos`.
- `20261006120500_seed_bot_parabrisas_petrucci.sql` — usuários de sistema Bot/Sistema,
  os 4 setores e os 5 textos.
- `20261008120000_departamento_padrao_externo.sql` — setor padrão = Vendas.

Teste: `supabase/tests/departamentos_ordem.test.sql` (roda em BEGIN/ROLLBACK).

## Antes de ligar

- Cadastrar os colaboradores em cada setor (sem eles a conversa fica em Pendentes e só
  os admins veem).
- Os textos do fluxo interno de **Sessões** (`sessao_*`) ainda não existem.
- O rodapé da página de login do Google ainda diz "Almore" (`google-contacts`).
