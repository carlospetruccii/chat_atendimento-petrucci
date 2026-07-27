# 03 — Integrações e Edge Functions (o backend)

As **Edge Functions** são pequenos programas que rodam no servidor (Supabase, em
Deno/TypeScript), na pasta `supabase/functions/`. São elas que fazem o trabalho pesado:
receber mensagens do WhatsApp, enviar respostas, rodar o robô e as tarefas automáticas.

## Índice
- [Como o sistema fala com o WhatsApp (hoje: Z‑API)](#como-o-sistema-fala-com-o-whatsapp-hoje-z-api)
- [Código compartilhado (_shared)](#código-compartilhado-_shared)
- [As funções, uma por uma](#as-funções-uma-por-uma)
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

As peças reaproveitadas pelas funções:

| Arquivo | O que faz |
|---------|-----------|
| **`zapi-client.ts`** | O **"telefone" para o WhatsApp**. Sabe enviar texto, mídia (imagem/áudio/vídeo/documento), **listas de opções** (os menus da triagem) e apagar mensagem. Tem repetição automática (até 3x) quando o WhatsApp responde "muitas requisições". |
| **`kill-switch.ts`** | A **trava de emergência do robô**. Lê `system_config.bot_ativo`. Se estiver desligado, as automações não rodam. Por segurança, **qualquer dúvida = desligado**. Guarda a resposta por 60s para não sobrecarregar o banco. |
| **`logger.ts`** | O **diário de bordo** técnico. Registra o que aconteceu em cada função, **sem nunca gravar dados sensíveis** (telefone completo, conteúdo de mensagem, tokens). |
| **`supabase-client.ts`** | A **conexão com o banco** em modo administrador (o backend enxerga tudo, sem as travas de RLS). |
| **`uazapi-grupos.ts`** | **Tradutor do objeto "grupo"** da uazapi para o nosso formato. Os nomes de campo que a API devolve variam (`JID`/`jid`/`chatid`, `Name`/`wa_name`…), então cada campo é lido por uma lista de candidatos. É função pura e testada — é a peça com mais chance de errar e a única testável sem uma instância real. |
| **`midia-download.ts`** | **Baixa o arquivo de uma mídia recebida**, com três tentativas em cascata (base64 da uazapi → URL já decodificada → URL do webhook). Nasceu dentro do webhook e foi extraído para ser usado também pelas mensagens de grupo: é frágil demais para existir em duas cópias. |
| **`empresa.ts`** | Descobre **de qual empresa é quem chamou** a função (via `company_members`, com a empresa mais antiga como reserva no cenário single‑tenant). |

---

## As funções, uma por uma

### Contato com o WhatsApp

#### 1. `webhook-zapi-receive` — a porta de entrada
É o **endereço público** que a Z‑API chama sempre que algo acontece no WhatsApp. É a
função mais importante do backend. Cuida de três situações:

1. **Mensagem nova do cliente** — encontra/cria o cliente, encontra/cria o atendimento
   (ou **reabre** um recém‑encerrado, ou começa um novo em `em_triagem`), grava a
   mensagem e, em segundo plano, **baixa a mídia** para o cofre `mensagens-midia`.
   > **Reabertura x encerramento manual (02/07/2026).** A reabertura automática só vale
   > quando o atendimento foi **encerrado automaticamente por inatividade**. Se o atendente
   > **encerrou manualmente** (clicou em "Encerrar"), uma mensagem nova do cliente inicia
   > uma **triagem nova** — não reabre. (Antes, um encerramento manual era reaberto caso o
   > atendimento tivesse conversa "externa" antiga, o que confundia o operador.) O caminho
   > `fromMe` mantém a reabertura por conversa externa.
   > **Lista de Sessões.** Ao criar um atendimento novo, o webhook checa se o número está
   > na tabela `sessoes_triagem` (ativo). Se estiver, marca o atendimento com `is_sessao = true`
   > e **pula a reabertura automática** — VIPs internos sempre reiniciam o fluxo de sessão
   > (podem querer falar com pessoas diferentes a cada contato). O `triagem-bot` roda então
   > o [fluxo da Lista de Sessões](#fluxo-da-lista-de-sessões) em vez da triagem de cliente.
2. **Confirmação de status** — quando uma mensagem que enviamos foi entregue/lida/falhou,
   atualiza o status daquela mensagem.
3. **Mensagem enviada por fora** (`fromMe`) — quando alguém respondeu o cliente pelo
   **celular pessoal** usando o número da empresa, registra como "externo" para aparecer
   no Inbox (e pode reabrir um atendimento).
4. **Mensagem de grupo** (`chatid` termina em `@g.us`) — **sai do fluxo de atendimento
   inteiro** e vai para `grupo_mensagens` (arquivos `grupos.ts` e `grupos-logic.ts`).
   Não cria cliente, não abre atendimento, não chama o bot. Se o grupo ainda não existe
   no banco, é criado ali mesmo e os dados (nome, tópico, participantes) são completados
   em segundo plano via `POST /group/info`. Mídia de grupo é baixada para
   `mensagens-midia/grupos/<grupo_id>/`.
   > Até 27/07/2026 essas mensagens eram **descartadas** de propósito: o JID de grupo não
   > passa no CHECK de E.164 de `clients`. Com as tabelas de grupo separadas, o descarte
   > virou desvio.

Ela **não exige login** (a uazapi não tem como fazer login do Supabase); em vez disso,
valida o `token` da instância que vem no corpo. Tem proteção contra duplicatas (usa o
`zapi_message_id` para o individual e o `uazapi_message_id` para grupo).

#### 2. `triagem-bot` — o robô de triagem (só **departamento**)
Roda sozinho (a cada ~10s, se o bot estiver ligado). Desde 02/07/2026 a triagem pergunta
**apenas o departamento** — o conceito de "assunto" foi removido do sistema inteiro
(tela, fluxo do bot e tabela no banco). O fluxo é:

1. Cliente **sem atendimento aberto** manda mensagem → o bot manda a **saudação**
   (`triagem_boas_vindas`) e o **menu de departamentos** como lista numerada/interativa
   ("Ver setores", template `triagem_pergunta_departamento`), montada com os departamentos
   ativos cadastrados.
2. Cliente **escolhe o departamento** — clicando numa opção da **lista interativa**
   ("Ver setores") **ou** respondendo o **número/nome** (ou parte dele) → o bot **confirma**
   (`triagem_confirmacao`: *"Certo! Te encaminhei para X…"*) e o atendimento **cai na
   Pendentes daquele departamento**, para um atendente pegar (o mesmo fluxo de Pendentes
   que já existia).
   > **Clique na lista (02/07/2026).** Quando o cliente **clica** numa opção, a uazapi manda
   > a resposta com o **texto vazio** e o id da opção em `media_metadata.selected_id`
   > (`dep_<uuid>`). O bot identifica o departamento por esse id (**fonte confiável**), antes
   > do texto, e **preenche** o texto vazio da mensagem com o nome do departamento escolhido,
   > para o Inbox exibir a escolha em vez de uma mensagem em branco.
3. Resposta **inválida** (número que não existe, texto solto) → o bot repete o menu de
   forma curta e educada (`triagem_erro_formato`).

**Casos de borda:**
- **1 departamento** cadastrado → o bot pula o menu e roteia direto para ele.
- **0 departamentos** → manda para uma **Pendentes geral** (fica em `em_triagem` sem
  departamento — permitido pelo CHECK só nesse status — e aparece em Pendentes; **não some**).
- Esgotou `triagem_max_tentativas` de respostas inválidas → também vai para a Pendentes geral.
- **Já existe atendimento aberto** para o cliente → o bot **não interfere** (só age em
  `em_triagem`); quem responde é o atendente.

**Timing / anti-flood (por que ele não responde instantâneo nem "buga").** A cada ~10s o
cron olha a **última** mensagem recebida do cliente e só age se ela já tiver pelo menos
`delay_anti_flood_triagem` segundos de idade (padrão **8s**). Se o cliente dispara uma
**rajada** de mensagens, cada nova mensagem "reinicia o relógio" — então o bot espera o
cliente parar de digitar e responde **uma vez só**, nunca uma resposta por mensagem.
Somam-se a isso: **idempotência** (`triagem_last_processed_msg_id` — a mesma mensagem
nunca é processada duas vezes) e uma **trava anti-loop** (para em 10 tentativas).

**Leitura do lote inteiro (não só a primeira mensagem).** No estágio "aguardando
departamento", o bot pega **todas as mensagens recebidas desde a última processada** (até
50, em ordem cronológica) e procura a **primeira que resolve um departamento** — por
**clique** na lista (id `dep_<uuid>`) ou por **texto** (número, nome exato ou parcial).
Assim, se o cliente escreve "oi", depois "queria saber de X", depois "2", o bot acha o "2"
no meio. Mensagem **atrasada** entra no lote seguinte (não se perde); mensagem **só de
mídia** (áudio/foto) é ignorada **sem gastar tentativa**; e nada válido no lote — inclusive
um **clique que não casou** com departamento ativo — conta como **uma** tentativa e repete
o menu (`triagem_erro_formato`). Depois de encaminhar (o
atendimento sai de `em_triagem`), o bot **não toca mais** na conversa — mensagens
seguintes viram conversa normal para o atendente, sem conflito.

**Onde ajustar o timing:** tudo em **Configurações → Tempos** — `delay_anti_flood_triagem`
(o "wait", 1–300s), `triagem_max_tentativas` e `tempo_abandono_triagem`. O **lembrete**
(quando o cliente some no meio) fica na aba **Operação** (liga/desliga + minutos).

**Encaminhamento (a quem vai).** Continuidade do mesmo dia **mantida**: se o cliente já
foi atendido hoje por alguém, volta para esse atendente (`reservado`). Senão, tenta o
**último atendente do departamento**; se não houver, fica **`pendente`**. O antigo
roteamento por **especialista de assunto** foi **removido** junto com o assunto.

Também cuida de:
- **Lembrete**: se o cliente some no meio da triagem, manda um lembrete único (respeitando
  o horário comercial).
- **Proteções**: não reprocessa mensagens antigas depois de religar o bot; para se detectar
  um "loop" suspeito.
- **Abandono automático**: existe, mas vem **desligado por padrão** (é considerado
  destrutivo — encerra sem avisar o cliente).

#### Fluxo da Lista de Sessões
Rodado pelo **mesmo** `triagem-bot`, para os atendimentos marcados com `is_sessao = true`
(números da aba **Configurações → Lista de Sessões**). Serve a **contatos internos**
(gerentes, diretoria) que querem falar **com um colaborador específico**, não com "um
atendente qualquer". Reaproveita todo o maquinário da triagem de cliente (lista
interativa, leitura do lote, anti-flood, idempotência, tentativas) — muda só os textos e
o destino final. Passos:

1. **Saudação personalizada** com o nome cadastrado na lista (`sessao_boas_vindas`:
   *"Olá, {{nome}}! 👋"*; sem nome, cai para *"Olá! 👋"*).
2. **Escolha do setor** — menu de departamentos (`sessao_pergunta_departamento`), igual ao
   do cliente (clique `dep_<uuid>` ou número/nome). Estágio: `aguardando_departamento`.
3. **Escolha do colaborador** — o bot lista os **colaboradores ativos daquele setor**
   (`sessao_pergunta_colaborador`, opções `col_<uuid>`). Estágio: `aguardando_colaborador`.
4. **Reserva direta** — o atendimento fica **`reservado`** para a pessoa escolhida
   (`assigned_to`), com o departamento carimbado, e o bot envia a confirmação
   (`sessao_confirmacao`: *"Certo! Te encaminhei para {{colaborador}}…"*).

**Bordas** (nunca "somem"): **1 departamento** → pula o menu de setor e já pergunta a
pessoa; **1 colaborador** no setor → reserva direto; **0 colaboradores** (ou tentativas
esgotadas na escolha da pessoa) → cai na **Pendentes daquele departamento**; **0
departamentos** → Pendentes geral. Os quatro templates `sessao_*` são editáveis em
**Configurações → Templates** (prefixo "Sessão · ").

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

#### 5b. `notificar-repasse` — avisa o colaborador no WhatsApp pessoal
Chamada pelo frontend (best‑effort, `void`) logo após um repasse (`repassar_atendimento`)
ou atribuição de pendente (`assign_pendente_a_usuario`) concluir. Manda ao **WhatsApp
pessoal** do colaborador que recebeu a conversa um aviso do tipo *"🔔 Novo atendimento pra
você — Fulano foi repassado por Beltrano…"*. Regras de segurança (tudo server‑side):

- **Nunca envia para número do payload** — o destino é sempre resolvido de `users.whatsapp`.
- **Não avisa a si mesmo** (se quem repassou = quem recebeu, pula).
- Só dispara sobre um repasse **real e vigente**: confere que `atendimento.assigned_to` é o
  destinatário **e** que existe um `timeline_event` `repassado`/`reservado` recente (2 min)
  **cujo autor é o próprio chamador**.
- **Idempotência/anti‑spam:** claim atômico em `timeline_events.notificacao_repasse_enviada_at`
  → no máximo **1 aviso por evento**.
- Respostas ao cliente são genéricas (`{ ok: true }`) para não virar oráculo de enumeração;
  o motivo real (skip/enviado/falha) fica só no log.
- Sem número cadastrado → no‑op silencioso. Falha no envio **não** quebra o repasse.

Envia pela **uazapi** (`_shared/uazapi-client.ts`, `enviarTexto`). Opcional: secret
`APP_URL` inclui um link do painel no aviso.

#### 5c. `grupo-enviar` — enviar mensagem para grupo
**Uma função só** para texto, imagem, vídeo, documento e nota de voz de **grupo** (as três
funções separadas do individual já divergiram entre si; aqui o fluxo é idêntico em tudo
menos o formato do payload da uazapi). Grava a mensagem antes de falar com o WhatsApp,
responde a tela na hora e envia em segundo plano.

Regras de segurança:
- É o **único** caminho de escrita em `grupo_mensagens` — a RLS não dá INSERT ao frontend,
  então a autoria (`sent_by_user_id`) vem sempre do JWT, nunca do corpo da requisição.
- Autorização: qualquer membro **ativo da empresa dona do grupo**. Grupo não tem
  responsável, então não há checagem de `assigned_to` como no individual.
- Recusa antes de gravar quando o grupo está inativo, é de outra empresa, ou está em modo
  "somente admins enviam" e nosso número não é admin (a uazapi recusaria de qualquer jeito).
- Não consulta o kill switch nem dispara automação: grupo não tem bot.

#### 5d. `sincronizar-grupos` — trazer os grupos do WhatsApp
Chamada **automaticamente** ao abrir a aba Grupos do Inbox, no máximo uma vez a cada
15 minutos (a trava usa `grupos.synced_at`; não há botão). Lê `GET /group/list` da uazapi e faz
**upsert** por `(company_id, wa_jid)`. Grupo que não vem mais na lista é marcado
`ativo = false` — **nunca apagado**, para o histórico de mensagens continuar legível.
Idempotente: rodar duas vezes não duplica nada. Autorização: qualquer membro ativo.

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
pela aba **Colaboradores**. Exige ser superadmin ou ter `manage_users`. Aceita o campo
opcional **`whatsapp`** (telefone pessoal) — normaliza para E.164 no servidor (idempotente)
e grava em `users.whatsapp`, usado depois pelo aviso de repasse.

#### 9b. `google-contacts` — contatos do Google (People API)
Backend da integração com os **contatos do Google** (feita em 02/07/2026).
Compartilha o helper `_shared/google-people.ts`. Ações (`POST { action }`):
- **`status`** — devolve se está configurado (secrets presentes), conectado, e‑mail,
  contagem de contatos e situação da última sincronização (o frontend nunca vê os tokens).
- **`auth_url`** — monta a URL de consentimento do Google (escopo `contacts.readonly`,
  `access_type=offline` para receber o refresh token).
- **`sync`** — sincroniza os contatos: **completa** na 1ª vez, **incremental** depois (via
  `syncToken`); se o `syncToken` expira (410) refaz do zero. Faz upsert na tabela
  `contatos` (e apaga os removidos). É **no‑op** se não houver conta conectada.
- **`disconnect`** — revoga o acesso e limpa os tokens.
- **Callback OAuth** (`GET ?code`) — o Google redireciona o navegador para cá; a função
  troca o `code` por tokens, guarda em `google_integration`, roda o 1º sync e volta ao app.

`verify_jwt = false` (o callback é um GET do navegador, sem JWT). Os secrets
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` ficam só no servidor. Ver a tela
[Contatos / aba Contatos Google](01-telas-e-abas.md).

### Tarefas automáticas (crons)

#### 10. `cron-bot-reactivation`
1x por dia: se havia uma **reativação agendada** e a data chegou, religa o bot.

#### 11. `cron-encerramento-automatico`
A cada 30 min: **encerra sozinho** atendimentos `em_atendimento`/`reservado` parados há
muito tempo (padrão 24h). Não mexe em triagem nem em pendentes.

#### 12. `cron-notificacao-admin`
A cada 5 min: avisa o **Administrador** (papel de supervisão), por WhatsApp e na tabela
`notificacoes_admin`, sobre atendimentos **pendentes parados** há tempo demais. Repete o
aviso de tempos em tempos e respeita o horário comercial. (Renomeada de
`cron-notificacao-luana` em 02/07/2026 — "Luana" saiu do sistema.)

#### 13. `cron-retry-mensagens-falha`
De tempos em tempos: **reenvia** mensagens que falharam (até 3 tentativas, com espera
crescente). É o que garante que uma mensagem não se perca se a Z‑API estiver instável.

#### 14. `cron-alerta-atendimento-parado`
A cada 5 min: avisa o **responsável fixo** (hoje a Leticia) no **WhatsApp pessoal** quando
um cliente fica **sem atendimento** — atendimento em `pendente`/`em_triagem` há mais que
`tempo_alerta_atendimento_parado` min (padrão **90**). Repete a cada
`intervalo_repeticao_alerta_atendimento_parado` min (padrão **30**) enquanto continuar
parado. Objetivo: o responsável ficar ciente e agir no atendimento parado. Alerta **paralelo/independente** do
`cron-notificacao-admin` (destino, prazo e gatilho próprios). Respeita kill‑switch e horário
comercial. Idempotência via **claim atômico** por janela na tabela
`alertas_atendimento_parado` (`UNIQUE(atendimento_id, janela)`) — no máximo 1 aviso por
janela, à prova de execução concorrente. O número do responsável vem de `users.whatsapp`
(nunca de payload); o `user_id` é fixo no código, com override opcional em
`system_config.user_id_alerta_atendimento_parado`.

---

## As tarefas automáticas (crons)

Elas são agendadas pelo próprio Postgres (pg_cron). Desde 02/07/2026 os jobs estão de fato
**agendados** (antes não havia nenhum) — via a migration `20260702131000_agenda_crons_triagem.sql`:

| Função | Frequência (job) | Depende do bot ligado? |
|--------|-----------|------------------------|
| `triagem-bot` | a cada **10 segundos** | Sim |
| `cron-retry-mensagens-falha` | a cada **2 minutos** | Sim |
| `cron-notificacao-admin` | a cada **5 minutos** | Sim |
| `cron-encerramento-automatico` | a cada **30 minutos** | Sim |
| `cron-bot-reactivation` | **1x/dia** (03:00 UTC = 00:00 BRT) | — (é justamente quem religa) |
| `cron-alerta-atendimento-parado` | a cada **5 minutos** | Sim — migration `20260720121000_agenda_cron_alerta_atendimento_parado.sql` |
| `google-contatos-sync` → `google-contacts` (`sync`) | a cada **15 minutos** | Não (independe do bot; no‑op se a conta Google não estiver conectada) — migrations `20260702120500_google_agenda_cron.sql` (criou) e `20260702200000_rename_agenda_para_contatos.sql` (renomeou o job) |

> "Depende do bot ligado" = respeita o **kill‑switch** (`bot_ativo`). Com o bot desligado
> pela aba **Operação**, essas automações pausam; só o **recebimento** (webhook) e o
> **envio manual** continuam.

> ⚠️ **Detalhe do agendamento:** o gateway das Edge Functions **exige um header
> `Authorization`** mesmo com `verify_jwt = false` (sem ele responde **401**). Por isso os
> jobs de cron chamam as funções via `net.http_post` enviando a **anon key** (a mesma,
> pública, do frontend) no header. Um cron que chame sem esse header não funciona.

---

## Segredos / variáveis de ambiente

Configurados no Supabase (nunca no código do frontend):

| Segredo | Para que serve |
|---------|----------------|
| `ZAPI_INSTANCE_ID` | Identifica a instância da Z‑API (WhatsApp). |
| `ZAPI_TOKEN` | Autentica na Z‑API. |
| `ZAPI_CLIENT_TOKEN` | Valida que quem chama o webhook é mesmo a Z‑API. |
| `CLEANUP_CONFIRM_TOKEN` | Senha extra para rodar a função de limpeza pontual. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Credenciais OAuth dos contatos do Google (People API). Sem elas, a aba **Contatos Google** mostra "não configurado". |
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
| **Enviar em grupo** (texto/mídia/áudio) | `grupo-enviar` | `/send/text`, `/send/media` | uazapi — o destino é o **JID do grupo** (`…@g.us`) no lugar do número |
| **Listar grupos** | `sincronizar-grupos` | `GET /group/list` | uazapi |
| **Dados de um grupo** | `webhook-zapi-receive` (grupo novo) | `POST /group/info` | uazapi |
| **Marcar grupo como lido** | `mark-chat-read` | `POST /chat/read` | uazapi (aceita `grupo_id`) |

> **Atenção ao enviar para grupo.** O cliente da uazapi normaliza número para "só
> dígitos". Isso **destruiria** um JID de grupo (`120363…@g.us` viraria `120363…`, um
> número inexistente). Por isso `_shared/uazapi-client.ts` tem `ehJidGrupo()`: destino
> que termina em `@g.us` passa **intacto**. Qualquer envio novo precisa usar o mesmo
> caminho.

**Fora de `grupo-enviar` e `sincronizar-grupos`, nenhuma dessas funções usa `company_id`**
— tudo funciona hoje assumindo "uma empresa só". As implicações disso estão em
[Riscos](05-dados-de-exemplo-e-riscos.md). As duas funções de grupo já resolvem a empresa
do chamador (via `_shared/empresa.ts`) porque nasceram depois do schema multi‑empresa.
