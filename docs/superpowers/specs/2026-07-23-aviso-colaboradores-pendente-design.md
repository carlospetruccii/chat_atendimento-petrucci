# Aviso aos colaboradores quando cai um pendente

**Data:** 2026-07-23
**Status:** aprovado

## Problema

Quando um cliente cai como `pendente` num departamento, ninguém do time é avisado
proativamente. O admin já recebe um lembrete quando o atendimento atrasa (90 min),
mas os colaboradores do departamento não recebem nada — descobrem o pendente só se
estiverem olhando o painel.

## Objetivo

Um botão liga/desliga na aba **Operação** que, quando ligado, faz o sistema mandar
uma mensagem no WhatsApp pessoal de **cada colaborador do departamento** toda vez que
um cliente cai como `pendente` naquele departamento. Nunca manda pro admin.

## Decisões (confirmadas com o usuário)

- **Quem recebe:** todos os colaboradores **ativos** do departamento (mesmo os
  marcados como indisponíveis). Nunca admin (`is_superadmin`), nunca usuário de sistema.
- **Kill switch:** o aviso **pausa junto** com o bot (`bot_ativo = false`). A aba
  Operação mostra um alerta visível quando o toggle está ON mas o bot está OFF.
- **Repetição:** **uma vez por cliente por departamento**. Sem lembretes repetidos
  (o admin já cobre o atraso). Se o cliente for repassado a outro departamento, o
  novo time é avisado (gente diferente); o mesmo departamento não repete.

## Arquitetura

**Cron novo `cron-notificacao-colaboradores`, a cada 1 min** — em vez de disparar no
código. Um cliente vira `pendente` em ~5 pontos diferentes (triagem-bot + webhook).
Um cron cobre todos de forma uniforme, sem tocar no caminho quente. Latência ≤ ~1 min.
Segue o padrão já existente de `cron-alerta-atendimento-parado` e `cron-notificacao-admin`.

### Peças

1. **Toggle na aba Operação** (`OperacaoTab.tsx`)
   - Bloco novo com `Switch`, grava `system_config.notificar_colaboradores_pendente`
     (default `'false'`).
   - Quando ON e `bot_ativo = false`: aviso visual "avisos pausados — o bot está desligado".
   - Query: campo em `OperacaoConfig` + `fetchOperacaoConfig` + setter
     `setNotificarColaboradoresPendente` em `configuracoes-queries.ts`.

2. **Migrations**
   - `system_config`: chave `notificar_colaboradores_pendente = 'false'` por empresa.
   - Tabela-ledger `notificacoes_colaborador_pendente`
     (`id`, `atendimento_id`, `department_id`, `company_id`, `created_at`),
     UNIQUE `(atendimento_id, department_id)` → uma vez por cliente por depto.
     RLS ligada sem policy; revoke de anon/authenticated (só service_role).
   - Template `notificacao_colaborador` seedado por empresa (editável em
     Configurações → Templates). Fallback embutido na função.
   - Agenda o cron a cada 1 min (`* * * * *`, padrão pg_cron/pg_net idêntico aos outros).

3. **Edge Function `cron-notificacao-colaboradores`** (clone enxuto do alerta-parado)
   - `index.ts` (orquestração I/O) + `logic.ts` (puro, testável) + `logic.test.ts`.
   - Pula se `notificar_colaboradores_pendente` off; pula se `bot_ativo` off.
   - Candidatos: `atendimentos.status = 'pendente'` com `current_department_id` real
     (não nulo, não o depto de triagem `00000000-0000-0000-0000-000000000010`).
   - Claim atômico no ledger `(atendimento_id, department_id)` — `ON CONFLICT DO NOTHING`,
     só notifica quem cria a linha.
   - Resolve colaboradores do depto: `users` com `department_id` = depto, `ativo = true`,
     `is_system_user = false`, `is_superadmin = false`, `whatsapp` presente.
   - Texto via template `notificacao_colaborador` (vars `nome_cliente`, `telefone`,
     `departamento`), reaproveitando a RPC `payload_notificacao_admin`.
   - Envia via `enviarTexto` do `_shared/uazapi-client.ts`. Deadline guard como o alerta.
   - Se **nenhum** envio do atendimento der certo, solta o claim pra reprocessar no
     próximo tick.

## Fora de escopo

- Lembretes repetidos (o admin já cobre atraso).
- Notificação em canais que não WhatsApp pessoal.
- Configurar por-departamento quem recebe (é sempre o time do depto).

## Adendo (mesmo dia): admin pode ter departamento atribuído

Caso real: Leticia é admin e é a única "responsável" natural do departamento
"Outros" — mas admin não tinha `department_id`, então "Outros" ficava sem
ninguém pra avisar (a regra original excluía todo `is_superadmin`).

Decisão: permitir atribuir um departamento a um admin (opcional). Ele continua
com acesso total (a visibilidade é por `role`/`is_superadmin`, nunca por
`department_id` — confirmado em toda a base: RLS, RPCs e frontend fazem
`is_superadmin OR department_id = ...`, nunca dependem de `department_id` ser
nulo). O único efeito prático de atribuir um departamento a um admin é ele
passar a **receber os avisos de novo pendente** daquele setor, como um
colaborador normal.

Mudanças:
- `cron-notificacao-colaboradores/logic.ts`: `colaboradorRecebe` não exclui
  mais `is_superadmin` — a elegibilidade por departamento já vem da query SQL
  (`users.department_id = deptId`), então um admin só aparece ali se tiver
  aquele departamento atribuído.
- `alterar-papel-colaborador` (Edge Function + RPC `alterar_papel_membro`) e
  `criar-colaborador`: pararam de forçar `department_id = null` na promoção/
  criação de admin. Continua opcional.
- `ColaboradoresTab.tsx`: seletor de Departamento aparece também para
  administrador (rotulado "opcional", com texto explicativo).
