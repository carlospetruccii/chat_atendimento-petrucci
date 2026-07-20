# Alerta de atendimento parado → WhatsApp pessoal (Leticia)

**Data:** 2026-07-20 · **Status:** aprovado (brainstorming)

## Objetivo
Quando um cliente fica **mais de 1h30 sem atendimento**, disparar um aviso no **WhatsApp
pessoal** de um responsável (hoje a Leticia) para ela relatar aos superiores. Alerta
**paralelo e independente** do aviso ao Administrador que já existe.

## Decisões (do brainstorming)
- **Gatilho:** atendimento em `pendente` **ou** `em_triagem` com `created_at` ≥ **90 min** atrás.
- **Destinatário:** **fixo na Leticia** — `user_id` constante no cron; o número vem de
  `users.whatsapp` dela em runtime (se o número mudar no cadastro, o alerta acompanha).
  Override opcional via `system_config.user_id_alerta_atendimento_parado`.
- **Repetição:** repete a cada **30 min** enquanto continuar parado.
- **Horário comercial:** **respeita** (reusa `notificacao_apenas_horario_comercial`).
- **Kill-switch:** respeita `bot_ativo`.
- Só backend — sem mudança de frontend.

## Arquitetura
Clone enxuto da mecânica do `cron-notificacao-admin`, num cron dedicado.

### Banco
- **Tabela `alertas_atendimento_parado`** (`id`, `atendimento_id` FK→atendimentos ON DELETE
  CASCADE, `company_id`, `created_at`) — ledger para o controle de "1ª vez / repetição".
  RLS ligada **sem policy** (só service_role escreve/lê, igual `google_integration`).
- **`system_config`** (tipo `numero`, idempotente por `(company_id,chave)`):
  - `tempo_alerta_atendimento_parado` = `90`
  - `intervalo_repeticao_alerta_atendimento_parado` = `30`
- **Template `alerta_atendimento_parado`** em `templates_mensagem` (idempotente por
  `(company_id,chave)`), ativo. Vars: `{{nome_cliente}}`, `{{telefone}}`, `{{departamento}}`,
  `{{tempo_aguardando}}`. O cron tem um texto-fallback embutido se o template sumir.

### Edge Function `cron-alerta-atendimento-parado`
Roda a cada 5 min (pg_cron + pg_net, mesmo padrão/anon key dos outros crons). Fluxo:
1. Kill-switch (`botEstaAtivo`). 2. Lê configs (com defaults 90/30). 3. Horário comercial
(`esta_em_horario_comercial`) se o flag estiver ligado. 4. Resolve destinatário
(config override → senão constante Leticia) → `users.whatsapp` + `ativo`; sem número → no-op.
5. Candidatos: `status in ('pendente','em_triagem')` e `created_at ≤ now()-tempo`, asc, limite 50.
6. Por candidato: `deveNotificar` = sem alerta anterior **ou** (agora − último) ≥ repetição.
7. Monta a mensagem (join cliente/departamento + tempo formatado), **insere o ledger primeiro**,
depois envia via `uazapi.enviarTexto`. Falha de envio é logada, não derruba o laço.

Envio pela uazapi (`_shared/uazapi-client.ts`). Nunca envia para número do payload — destino
sempre resolvido do cadastro do responsável.

## Testes
- SELECT dos candidatos confere (com limiar baixo). Invocação registra contagem/gating nos logs.
- 1 envio real end-to-end **para o número do João** (limiar temporário) confirmando entrega +
  ledger + dedup na 2ª execução; depois **restaura** configs e limpa linhas de teste.

## Fora de escopo
Editar esses tempos pela UI (aba Tempos) — pode vir depois. Auto-roteamento do bot continua
sem esse alerta (é sobre cliente parado na fila, não sobre atribuição).
