# 08 — Notificação de repasse no WhatsApp (+ correções de segurança)

> Changeset de **17/07/2026**. Feature: avisar o colaborador no **WhatsApp pessoal** dele
> quando um atendimento é **repassado ou atribuído** a ele. Junto foram corrigidas duas
> falhas de segurança encontradas na revisão. Envio validado ponta a ponta na uazapi.

---

## O que a feature faz

Quando alguém **repassa** uma conversa (botão **Repassar** no Inbox → `repassar_atendimento`)
ou **atribui** um pendente a outra pessoa (**Atribuir** → `assign_pendente_a_usuario`), o
colaborador que recebeu leva um aviso no **WhatsApp pessoal** dele:

```
🔔 Novo atendimento pra você

*Cliente X* foi repassado(a) pra você por Fulano.
🏷️ Comercial
📝 <observação do repasse, se houver>

Abra o painel para atender.
```

O aviso sai pelo **mesmo número da empresa** (uazapi é instância única). Não é mensagem
para o cliente — é para o atendente.

### Onde se cadastra o número
Na aba **Colaboradores** (Configurações), cada colaborador tem o campo **WhatsApp pessoal**
(opcional). Quem não preencher simplesmente não recebe aviso. O número é guardado em E.164
(`+55...`), com a mesma normalização/validação da Lista de Sessões.

### Cenário que NÃO notifica (esperado)
**Auto‑repasse** (você repassa para você mesmo) não dispara aviso — não faz sentido avisar
a própria pessoa. Para testar de verdade: entre como outro usuário e repasse **para você**,
ou repasse para **outra pessoa** com número cadastrado.

---

## Mudanças no banco

| Objeto | Mudança |
|--------|---------|
| `users.whatsapp` (text, E.164, CHECK) | Telefone pessoal do colaborador. **PII** — não é legível direto pelo cliente (ver RPC abaixo). |
| `timeline_events.notificacao_repasse_enviada_at` (timestamptz) | Carimbo de idempotência: garante **1 aviso por evento** (anti‑spam). |
| RPC `admin_list_user_whatsapps()` | Única porta de leitura do `whatsapp` pelo cliente: só admin (superadmin/`manage_users`) — vê todos — e a própria linha do chamador. |
| Trigger `protect_superadmin_flag` (reforçado) | Ver "Correção 1" abaixo. |

## Edge Function `notificar-repasse`

Ver detalhe em [03 — Integrações e Edge Functions](03-integracoes-e-edge-functions.md#5b-notificar-repasse--avisa-o-colaborador-no-whatsapp-pessoal). Resumo das travas:
número sempre resolvido de `users.whatsapp` (nunca do payload); não avisa a si mesmo; só
sobre repasse real/vigente cujo **autor é o chamador**; claim atômico para 1 aviso por
evento; respostas genéricas; envio em background que não quebra o repasse.

A `criar-colaborador` também passou a aceitar `whatsapp` (normaliza E.164 no servidor).

---

## Correções de segurança feitas junto

### Correção 1 — Escalonamento de privilégio em `users` (era CRÍTICO)
A policy de UPDATE deixa o usuário editar a própria linha, e o trigger antigo só barrava
`is_superadmin` de TRUE→FALSE — **deixava passar FALSE→TRUE**. Um colaborador comum podia
`UPDATE users SET is_superadmin = true` na própria linha (via PostgREST) e virar superadmin.

**Corrigido:** o `protect_superadmin_flag` agora impede usuário **não‑admin** de alterar
colunas administrativas (`is_superadmin`, `is_system_user`, `department_id`, `ativo`) —
inclusive na própria linha. Admin e backend (service_role) seguem livres; `nome`/`whatsapp`/
`disponivel` continuam editáveis pelo próprio. Validado com simulação de JWT (não‑admin
bloqueado com `42501`; admin liberado).

### Correção 2 — WhatsApp pessoal legível por todos (PII/LGPD)
O role `authenticated` tinha SELECT de **tabela** em `users` (cobre todas as colunas) +
policy `USING(true)` → qualquer colaborador lia o telefone de todos com `select whatsapp`.

**Corrigido** com a RPC `admin_list_user_whatsapps()` + revogar o SELECT amplo, reconcedendo
SELECT só nas colunas não sensíveis (`whatsapp` fica de fora). `fetchColaboradores` passou a
ler o número via RPC. As Edge Functions (service_role) seguem lendo a coluna direto.

---

## Estado de deploy (rollout expand/contract, zero‑downtime)

A Correção 2 quebra se banco e frontend não subirem alinhados (o frontend antigo lê a coluna
direto). Por isso foi dividida em duas migrations:

| Migration | Papel | Estado em prod |
|-----------|-------|----------------|
| `..._create_admin_list_user_whatsapps` | **EXPAND** — cria a RPC (não quebra nada) | ✅ **aplicada** |
| `..._lock_users_whatsapp_column` | **CONTRACT** — tranca o SELECT da coluna | ⏳ **pendente — aplicar só APÓS o deploy do frontend novo** |

As demais migrations do changeset (`users_whatsapp`, `timeline_events_notificacao_repasse`,
`harden_users_protect_sensitive_columns`, expand) **já estão aplicadas**. Enquanto a contract
não roda, a coluna ainda é legível (frontend antigo e novo funcionam); a proteção de PII só
fica **completa** depois de aplicar a contract, o que deve acontecer **depois** do deploy do
frontend.

> Divisão de responsabilidade combinada: **deploy do frontend é do time**; **migrations de
> banco são aplicadas via MCP** (gatilho: avisar quando o frontend foi deployado, então
> aplicar a contract e validar).
