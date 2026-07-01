# 03 — Integrações e Edge Functions (o backend)

As **Edge Functions** são pequenos programas que rodam no servidor (Supabase, em
Deno/TypeScript), na pasta `supabase/functions/`. São elas que fazem o trabalho pesado:
receber mensagens do WhatsApp, enviar respostas, rodar o robô e as tarefas automáticas.

## Índice
- [Como o sistema fala com o WhatsApp (hoje: Z‑API)](#como-o-sistema-fala-com-o-whatsapp-hoje-z-api)
- [Código compartilhado (_shared)](#código-compartilhado-_shared)
- [As 13 funções, uma por uma](#as-13-funções-uma-por-uma)
- [As tarefas automáticas (crons)](#as-tarefas-automáticas-crons)
- [Segredos / variáveis de ambiente](#segredos--variáveis-de-ambiente)
- [Todo ponto de contato com o WhatsApp](#todo-ponto-de-contato-com-o-whatsapp)

---

## Como o sistema fala com o WhatsApp (hoje: Z‑API)

> ⚠️ **Ponto central para a migração.** Hoje **todo** o contato com o WhatsApp passa
> pela **Z‑API**. A palavra "uazapi" **não aparece em lugar nenhum** do código. Ou seja:
> cada item listado abaixo é um lugar que precisará mudar quando trocarmos para a uazapi.

O que existe hoje, concretamente:
- Um único "cliente" de WhatsApp: o arquivo **`_shared/zapi-client.ts`**.
- Endereço fixo: **`https://api.z-api.io`**.
- Três segredos: **`ZAPI_INSTANCE_ID`**, **`ZAPI_TOKEN`**, **`ZAPI_CLIENT_TOKEN`**.
- Um cabeçalho de segurança em todas as chamadas: **`Client-Token`**.

---

## Código compartilhado (`_shared`)

Quatro peças reaproveitadas por todas as funções:

| Arquivo | O que faz |
|---------|-----------|
| **`zapi-client.ts`** | O **"telefone" para o WhatsApp**. Sabe enviar texto, mídia (imagem/áudio/vídeo/documento), **listas de opções** (os menus da triagem) e apagar mensagem. Tem repetição automática (até 3x) quando o WhatsApp responde "muitas requisições". |
| **`kill-switch.ts`** | A **trava de emergência do robô**. Lê `system_config.bot_ativo`. Se estiver desligado, as automações não rodam. Por segurança, **qualquer dúvida = desligado**. Guarda a resposta por 60s para não sobrecarregar o banco. |
| **`logger.ts`** | O **diário de bordo** técnico. Registra o que aconteceu em cada função, **sem nunca gravar dados sensíveis** (telefone completo, conteúdo de mensagem, tokens). |
| **`supabase-client.ts`** | A **conexão com o banco** em modo administrador (o backend enxerga tudo, sem as travas de RLS). |

---

## As 13 funções, uma por uma

### Contato com o WhatsApp

#### 1. `webhook-zapi-receive` — a porta de entrada
É o **endereço público** que a Z‑API chama sempre que algo acontece no WhatsApp. É a
função mais importante do backend. Cuida de três situações:

1. **Mensagem nova do cliente** — encontra/cria o cliente, encontra/cria o atendimento
   (ou **reabre** um recém‑encerrado, ou começa um novo em `em_triagem`), grava a
   mensagem e, em segundo plano, **baixa a mídia** para o cofre `mensagens-midia`.
2. **Confirmação de status** — quando uma mensagem que enviamos foi entregue/lida/falhou,
   atualiza o status daquela mensagem.
3. **Mensagem enviada por fora** (`fromMe`) — quando alguém respondeu o cliente pelo
   **celular pessoal** usando o número da empresa, registra como "externo" para aparecer
   no Inbox (e pode reabrir um atendimento).

Ela **não exige login** (a Z‑API não tem como fazer login do Supabase); em vez disso,
valida o cabeçalho **`Client-Token`**. Também ignora mensagens de **grupo**. Tem proteção
contra duplicatas (usa o `zapi_message_id`).

#### 2. `triagem-bot` — o robô de triagem
Roda sozinho (a cada ~10s, se o bot estiver ligado). Conduz a conversa inicial:
manda a saudação → pergunta o **departamento** (menu de opções) → pergunta o **assunto**
→ **encaminha** o atendimento. O encaminhamento segue a ordem: especialista do assunto →
último atendente que já falou com o cliente → senão fica `pendente`.

Também cuida de:
- **Lembrete**: se o cliente some no meio da triagem, manda um lembrete (respeitando o
  horário comercial).
- **Continuidade**: se o cliente já foi atendido no mesmo dia, tenta manter o mesmo
  atendente.
- **Proteções**: não reprocessa mensagens antigas depois de religar o bot; para se
  detectar um "loop" suspeito.
- **Abandono automático**: existe, mas vem **desligado por padrão** (é considerado
  destrutivo — encerra sem avisar o cliente).

#### 3. `send-whatsapp-message` — enviar texto
Chamada pelo Inbox. Confere permissão, marca a mensagem como "enviando", **responde a
tela na hora** e, em segundo plano, manda para a Z‑API e atualiza o status
(`enviado` + `zapi_message_id`, ou `falha` com um motivo legível).

#### 4. `send-whatsapp-audio` — enviar áudio
Recebe o áudio gravado, guarda no cofre `mensagens-midia`, grava a mensagem e envia como
"nota de voz" (PTT) pela Z‑API.

#### 5. `send-whatsapp-media` — enviar imagem/vídeo/documento
Igual ao áudio, para arquivos (limite **16 MB**). Guarda no cofre, grava a mensagem
(com legenda) e envia pela Z‑API.

#### 6. `cleanup-disparo-acidental-bot` — limpeza pontual (⚠️ histórica)
Uma função **de uso único**, criada para **desfazer um disparo acidental do robô** que
aconteceu numa data específica de 2026‑05‑12. Apaga aquelas mensagens no WhatsApp (via
Z‑API), com exceções embutidas no código. **Não faz parte da operação normal** — ver
[Riscos](05-dados-de-exemplo-e-riscos.md).

### Sem contato com o WhatsApp (só banco)

#### 7. `iniciar-atendimento`
Cria um atendimento **manual** (empresa → cliente), já direto em `em_atendimento`, sem
passar pela triagem e **sem** enviar mensagem. Exige login. A supervisão escolhe
departamento e atendente; um atendente comum inicia no próprio departamento e para si.

#### 8. `cadastrar-cliente`
Cria/atualiza clientes — um por vez ("single") ou em lote por planilha ("csv_batch", até
5000 linhas). Usada pela tela **Clientes**.

#### 9. `criar-colaborador`
Cria um novo atendente: gera o acesso no Supabase Auth **e** a linha em `users`. Usada
pela aba **Colaboradores**. Exige ser superadmin ou ter `manage_users`.

### Tarefas automáticas (crons)

#### 10. `cron-bot-reactivation`
1x por dia: se havia uma **reativação agendada** e a data chegou, religa o bot.

#### 11. `cron-encerramento-automatico`
A cada 30 min: **encerra sozinho** atendimentos `em_atendimento`/`reservado` parados há
muito tempo (padrão 24h). Não mexe em triagem nem em pendentes.

#### 12. `cron-notificacao-luana`
A cada 5 min: avisa a **supervisão ("Luana")**, por WhatsApp e na tabela
`notificacoes_luana`, sobre atendimentos **pendentes parados** há tempo demais. Repete o
aviso de tempos em tempos e respeita o horário comercial.

#### 13. `cron-retry-mensagens-falha`
De tempos em tempos: **reenvia** mensagens que falharam (até 3 tentativas, com espera
crescente). É o que garante que uma mensagem não se perca se a Z‑API estiver instável.

---

## As tarefas automáticas (crons)

Elas são agendadas pelo próprio Postgres (pg_cron). Frequências aproximadas (segundo os
comentários no código):

| Função | Frequência | Depende do bot ligado? |
|--------|-----------|------------------------|
| `triagem-bot` | ~10 segundos | Sim |
| `cron-retry-mensagens-falha` | frequente (poucos minutos) | Sim |
| `cron-notificacao-luana` | 5 minutos | Sim |
| `cron-encerramento-automatico` | 30 minutos | Sim |
| `cron-bot-reactivation` | 1x por dia | — (é justamente quem religa) |

> "Depende do bot ligado" = respeita o **kill‑switch** (`bot_ativo`). Com o bot desligado
> pela aba **Operação**, essas automações pausam; só o **recebimento** (webhook) e o
> **envio manual** continuam.

---

## Segredos / variáveis de ambiente

Configurados no Supabase (nunca no código do frontend):

| Segredo | Para que serve |
|---------|----------------|
| `ZAPI_INSTANCE_ID` | Identifica a instância da Z‑API (WhatsApp). |
| `ZAPI_TOKEN` | Autentica na Z‑API. |
| `ZAPI_CLIENT_TOKEN` | Valida que quem chama o webhook é mesmo a Z‑API. |
| `CLEANUP_CONFIRM_TOKEN` | Senha extra para rodar a função de limpeza pontual. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` | Conexão com o banco (injetados automaticamente). |

> Note que as credenciais do WhatsApp existem **em dois lugares**: nesses segredos
> (usados pelas funções hoje) **e** em colunas da tabela `companies`
> (`zapi_instance_id`/`zapi_token`/`zapi_client_token`, pensadas para o futuro
> multi‑empresa). Hoje valem os **segredos** — as colunas de `companies` não são lidas
> pelas funções.

---

## Todo ponto de contato com o WhatsApp

Resumo de **onde** o sistema conversa com o WhatsApp e **como está hoje**:

| Ponto | Função | Endpoint Z‑API | Situação |
|-------|--------|----------------|----------|
| **Receber** mensagens e status | `webhook-zapi-receive` | (a Z‑API chama o sistema) | Z‑API; valida `Client-Token` |
| **Enviar texto** | `send-whatsapp-message` | `/send-text` | Z‑API |
| **Enviar áudio** | `send-whatsapp-audio` | `/send-audio` | Z‑API (nota de voz) |
| **Enviar imagem** | `send-whatsapp-media` | `/send-image` | Z‑API |
| **Enviar vídeo** | `send-whatsapp-media` | `/send-video` | Z‑API |
| **Enviar documento** | `send-whatsapp-media` | `/send-document/{ext}` | Z‑API |
| **Menu de opções** (triagem) | `triagem-bot` | `/send-option-list` | Z‑API |
| **Apagar mensagem** | `cleanup-disparo-acidental-bot` | `DELETE /messages` | Z‑API (função pontual) |

**Nenhuma dessas funções usa `company_id`** — confirmado: não há uma única menção a
`company_id` em toda a pasta `supabase/functions/`. Tudo funciona hoje assumindo "uma
empresa só". As implicações disso estão em [Riscos](05-dados-de-exemplo-e-riscos.md).
