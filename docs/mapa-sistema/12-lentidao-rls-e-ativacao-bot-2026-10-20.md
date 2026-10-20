# 12 — Lentidão geral, ativação do bot e conexão do WhatsApp (20/10/2026)

Resumo do que aconteceu na manhã de 20/10/2026 e o que ficou valendo.

## 1. Telas não carregavam (lentidão geral)

**Sintoma:** Inbox girando sem fim, todas as telas lentas. Banco com `statement timeout`
(o papel `authenticated` tem limite de 8s) e erro 500 em `get_my_inbox_unread_total` e
`/rest/v1/mensagens`. Começou ~09h, quando a equipe entrou. Só 5 usuários: o problema era
o custo de cada consulta, não o volume.

**Causa:** as policies de leitura (RLS) de `atendimentos`, `mensagens` e `timeline_events`
chamavam funções por **linha** — `is_member_of(company_id)`, `can_view_all_in(company_id)`,
`pendentes_abertos_a_todos(company_id)` e, principalmente,
`private.can_read_atendimento_participante(...)` (~1ms cada). Ler as 11 mil mensagens custava
~3,7s; o contador de não lidas, ~9s. Com o polling de todas as abas, o banco saturou.

**Conserto (duas migrations):**

| Migration | O que faz |
|---|---|
| `20261020123602_inbox_unread_total_definer.sql` | `get_my_inbox_unread_total` vira `SECURITY DEFINER` com a regra de visibilidade explícita no `WHERE` (9s → ~1s). |
| `20261020124316_rls_leitura_sem_funcao_por_linha.sql` | Funções que devolvem **arrays** do que o usuário pode ver, chamadas uma vez por consulta (`(SELECT f())::uuid[]`, vira InitPlan). Cada linha só faz `coluna = ANY(array)`. |

Funções novas e a regra que cada uma espelha:

| Nova | Equivale a |
|---|---|
| `public.minhas_empresas()` | `is_member_of(company_id)` |
| `public.empresas_ve_tudo()` | `can_view_all_in(company_id)` |
| `public.empresas_pendentes_abertos()` | `pendentes_abertos_a_todos(company_id)` |
| `private.meus_atendimentos_participante()` | `private.can_read_atendimento_participante(...)` |

> **Regra:** mudou uma dessas regras de visibilidade? Mude a função "array" junto,
> senão a policy e a regra antiga divergem.

**Como foi validado:** numa transação com ROLLBACK, para os 5 usuários reais, comparamos
contagem e hash (md5 da lista de ids) de atendimentos, mensagens e timeline antes e depois.
Tudo igual; tempo por usuário caiu de ~3,7s para ~0,04s.

**Ainda lento (não mexido):** abrir mídia (`storage.objects`) chegou a ~9s no pico; tende a
ter melhorado com o banco aliviado. Se voltar, olhar `mensagem_midia_visivel`.

## 2. Ativação do bot de triagem

Ligado em **20/10/2026 09:47** por ordem do dono. Antes de ligar:

- **Fila antiga limpa:** 251 atendimentos `em_triagem`/`pendente` sem movimento há mais de
  4h foram encerrados (`close_reason = 'manual_supervisor'`). Nenhuma mensagem sai ao
  encerrar. Se o cliente voltar a escrever, o webhook reabre ou cria atendimento novo.
- **Conversas atendidas pelo celular:** atendimento `em_triagem` que a equipe já responde
  pelo celular recebeu `triagem_estagio = 'concluida'` (Renan Bravo, Juliana). Sem isso,
  quando o cliente escreve de novo o bot entra no meio da conversa com o menu.
- `bot_ativado_em` carimbado junto com `bot_ativo = true`: o bot ignora mensagens anteriores.

O bot não entra em atendimento `em_atendimento`, `reservado` ou `pendente`. Só faz triagem
de cliente novo ou de quem volta depois de encerrado.

**Avisos internos não chegam em ninguém (pendente):**
- `cron-alerta-atendimento-parado` aponta para um responsável (`15d58f66-…`) que não existe
  mais em `users` → `destinatario_sem_numero`.
- `cron-notificacao-admin` → `notificacao_sem_numero_configurado`.
- Só Luiz Lotto tem WhatsApp cadastrado. Cadastrar o WhatsApp da equipe e definir o
  responsável pelos alertas.

## 3. Conexão do WhatsApp sem login (falha de segurança)

`whatsapp-connection` tem `verify_jwt = false` e não checava quem chamava: qualquer um com
a URL podia ver o status e **desconectar** o número da empresa.

**Conserto:** a função agora exige `ehOperadorOuSuperadmin` (`_shared/auth-operador.ts`):
superadmin ativo (JWT de usuário) ou chave de servidor. Os admins (Dev, Carlos, Tayna) são
superadmin. Sem login → 401 `nao_autorizado`. Publicada em 20/10/2026.

## Outras observações

- **"426h em aguardo" em Pendentes:** o tempo conta desde a criação do atendimento
  (02/10, dia da virada), não desde a última mensagem do cliente. São conversas ativas.
  Corrigir a contagem está pendente.
- **Luiz Lotto** não enxerga nenhum atendimento (antes e depois da mudança de RLS):
  conferir os setores dele.
- As duas migrations e o deploy foram feitos durante o incidente, sem passar pelos agentes
  `supabase-security-reviewer` / `pre-deploy-reviewer`. Vale rodar depois.
