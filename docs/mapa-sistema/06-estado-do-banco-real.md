# 06 — Estado do banco REAL (produção)

> **O que é este documento.** Diferente dos anteriores (que foram feitos lendo o código e
> as migrations), este olha as **linhas que existem de fato** no banco de produção.
> Leitura feita em **01/07/2026** via Supabase CLI (`supabase db query --linked`),
> conectado como `postgres` (portanto **enxergando tudo**, sem as travas de RLS).
> **Nada foi alterado** — só consultas de leitura.
>
> Projeto: **`hfcfkxozzbrzzrejtbdj`** ("Chat WhatsApp Almore"), o mesmo que o app usa
> (`.env` → `SUPABASE_URL`).

---

## Atualização — 02/07/2026

> **Este snapshot foi tirado em 01/07/2026.** Em 02/07/2026, novas consultas ao mesmo
> projeto (`hfcfkxozzbrzzrejtbdj`) mostraram mudanças de schema e de operação. O snapshot
> histórico abaixo foi **preservado**; esta seção resume os deltas (e há anotações inline
> "→ atualizado em 02/07" nas tabelas afetadas).

- **"Assunto" removido.** As tabelas `subjects` e `especialista_routing` foram **dropadas**
  e a coluna `atendimentos.subject_id` foi removida. O recurso de assuntos/roteamento por
  especialista **não existe mais**.
- **"Luana" → "Administrador".** A tabela `notificacoes_luana` foi renomeada para
  `notificacoes_admin`; a função `payload_notificacao_luana` virou `payload_notificacao_admin`;
  a edge function `cron-notificacao-luana` virou `cron-notificacao-admin` (a antiga foi
  **deletada** do projeto).
- **5 templates de triagem** (antes 1). Foram semeados os textos:
  `triagem_boas_vindas`, `triagem_pergunta_departamento`, `triagem_confirmacao`,
  `triagem_erro_formato` — além do `triagem_lembrete_sem_resposta` que já existia.
- **5 crons agendados e ATIVOS** no `pg_cron` (antes eram **zero**): `triagem-bot` (10 s),
  `cron-retry-mensagens-falha` (2 min), `cron-notificacao-admin` (5 min),
  `cron-encerramento-automatico` (30 min) e `cron-bot-reactivation` (diário 03:00 UTC).
  Os jobs chamam as Edge Functions via `net.http_post`, enviando a **anon key** no header
  `Authorization` (o gateway exige, mesmo com `verify_jwt = false`).
- **WhatsApp CONECTADO** (uazapi) — o snapshot dizia que não havia integração conectada.
- **Bot ainda DESLIGADO.** `system_config.bot_ativo` **continua não existindo** → pela regra
  do kill‑switch, o bot segue efetivamente **off** até alguém ligar em
  Configurações → Operação.
- **Nº de tabelas: 18** (eram 20). A remoção de `subjects` e `especialista_routing` tirou 2;
  o rename `notificacoes_luana` → `notificacoes_admin` não muda a contagem.
- **Migrations:** subiu o total aplicado — foram adicionadas as de 02/07/2026 (templates de
  triagem, remoção de assunto, rename Luana→Administrador, agenda de crons), além das de
  Agenda Google que podem estar pendentes.

---

## Atualização — 02/07/2026 (fim do dia): sementes faltantes e bot no ar

Ao ligar o bot pela primeira vez neste projeto, apareceram **falhas silenciosas**
causadas por **sementes que nunca foram versionadas** (existiam no projeto anterior, mas
o projeto novo foi criado do zero). Todas corrigidas com migrations **idempotentes** e
aplicadas em produção:

- **`system_config` — chaves faltantes.** Não existiam `bot_ativo`, `bot_ativacao_programada`
  nem `clientes_visivel_para_todos`. Sem `bot_ativo`, o botão de ligar o bot fazia
  `UPDATE` em **0 linhas** (não persistia) e o kill‑switch tratava como desligado. Criadas
  em `20260702175500_seed_system_config_faltantes.sql`. **Atenção:** a PK de `system_config`
  é composta **`(company_id, chave)`** → o `ON CONFLICT` precisa citar as duas colunas.
  → corrige a nota anterior de que "`bot_ativo` continua não existindo". **O bot foi ligado
  e está operando.**
- **Usuários de sistema faltantes.** Não existiam `00000000‑…‑001` (Bot) nem `…‑002`
  (Sistema). A triagem‑bot grava as mensagens do robô com `sent_by_user_id = 001`, e
  `mensagens.sent_by_user_id` tem **FK** para `users(id)`: sem o usuário‑bot, **todo envio
  do bot falhava na persistência** (FK 23503) → o estágio da triagem não avançava → o cron
  reenviava as boas‑vindas a cada 10 s (**loop**), sem gravar nada no sistema. Criados em
  `20260702182000_seed_usuarios_sistema.sql` (`is_system_user = true` exige `email NULL`,
  por CHECK).

**Correções de fluxo (Edge Functions, mesmo dia):**
- **Encerrar atendimento em triagem sem departamento.** A CHECK
  `atendimentos_dept_required_after_triagem_chk` não permitia sair de `em_triagem` sem
  departamento; encerrar um atendimento ainda em triagem estourava 400. Passou a permitir
  também `status = 'encerrado'` (`20260702174500_fix_encerrar_triagem_sem_departamento.sql`).
- **Encerramento manual é definitivo.** No `webhook‑zapi‑receive`, uma mensagem nova do
  cliente após um encerramento **manual** agora inicia **triagem nova** (antes reabria o
  atendimento se ele tivesse conversa "externa" antiga). A reabertura automática no caminho
  inbound só vale para encerramento **automático por inatividade**. O caminho `fromMe`
  seguiu igual.
- **Triagem por clique na lista.** A resposta da lista interativa (uazapi) chega com
  `content` vazio e o departamento em `media_metadata.selected_id` (`dep_<uuid>`). A
  `triagem‑bot` passou a **ler o `media_metadata`** e resolver o departamento pelo clique
  (fonte confiável), preenchendo o `content` vazio com o nome do departamento escolhido.

---

## Atualização — 03/07/2026: Lista de Sessões (fluxo interno)

> Estas mudanças vêm das **migrations adicionadas e pushadas em 03/07/2026**; entram em
> produção quando o pipeline (Lovable/Supabase) as aplica. Não são resultado de query ao
> banco — são o delta de schema versionado.

- **Nova tabela `sessoes_triagem`** (`20260703120000_sessoes_triagem.sql`) — a **Lista de
  Sessões**: números liberados (VIPs internos) que pulam a triagem de cliente. RLS: leitura
  por membro (`is_member_of`), escrita só dono/administrador (`can_manage_config_in`).
- **`atendimentos.is_sessao`** (`20260703122000_sessao_flow.sql`) — marca o atendimento que
  veio de um número da lista, para o `triagem-bot` rodar o fluxo interno.
- **Enum `triagem_estagio` +1 valor: `aguardando_colaborador`**
  (`20260703121000_atendimento_estagio_colaborador.sql`) — o passo de escolha da pessoa.
  (Adicionado em migration própria: Postgres não deixa usar um valor de enum recém-criado
  na mesma transação.)
- **9 templates de mensagem** (antes 5). Semeados os 4 textos do fluxo de sessão:
  `sessao_boas_vindas`, `sessao_pergunta_departamento`, `sessao_pergunta_colaborador`,
  `sessao_confirmacao` (`ON CONFLICT DO NOTHING`, PK composta `(company_id, chave)`).
- **Nº de tabelas: 19** (era 18 desde 02/07) — soma `sessoes_triagem`.
- **Configurações agora com 9 abas** — nova aba **Lista de Sessões** (antepenúltima). Ver
  [01 — Telas e abas](01-telas-e-abas.md#aba-7--lista-de-sessões) e o
  [fluxo no triagem-bot](03-integracoes-e-edge-functions.md#fluxo-da-lista-de-sessões).

---

## Manchete: o banco está praticamente vazio (é um projeto novo)

A conclusão mais importante, e que **muda o plano de "limpeza"**:

> **Não existe dado de teste nem dado real neste banco.** Ele tem **apenas as sementes**
> criadas pelas migrations: 1 empresa ("Empresa Exemplo"), 1 departamento
> ("Administrativo"), 1 template e 5 configurações. **Zero** usuários, **zero** clientes,
> **zero** atendimentos, **zero** mensagens, **zero** mídias.

Ou seja: este projeto Supabase é um **começo do zero**. O schema está todo aplicado
(45 migrations), as 13 Edge Functions estão publicadas, mas **ainda não há operação**.
Os "dados mockados / Empresa Exemplo" que imaginávamos limpar **não estão aqui** — se
existem dados antigos de verdade, eles ficaram no **projeto Supabase anterior** (este é o
destino da migração feita no commit "Migra app… para o projeto hfcfkxozzbrzzrejtbdj", e
veio limpo).

> ⚠️ **Limite do que enxergo:** só tenho acesso a **este** projeto. Não posso confirmar o
> que existe (ou existia) em qualquer projeto Supabase antigo.

---

## Contagem de tudo (linhas reais)

| Tabela | Linhas | Natureza |
|--------|-------:|----------|
| companies | **1** | Semente ("Empresa Exemplo") |
| departments | **1** | Semente ("Administrativo") |
| templates_mensagem | **1** → **5** (02/07) → **9** (03/07) | Semente (`triagem_lembrete_sem_resposta`); +4 textos de triagem em 02/07; +4 textos de sessão (`sessao_*`) em 03/07 |
| sessoes_triagem | **0** | Tabela nova (03/07) — Lista de Sessões, vazia até o admin cadastrar |
| system_config | **5** | Sementes (ver abaixo) |
| users | **0** | — |
| **auth.users** (contas de login) | **0** | — |
| clients | **0** | — |
| atendimentos | **0** | — |
| mensagens | **0** | — |
| mídias no cofre `mensagens-midia` | **0** | — |
| ~~subjects (assuntos)~~ | — | **Tabela REMOVIDA em 02/07** (drop) |
| ~~especialista_routing~~ | — | **Tabela REMOVIDA em 02/07** (drop) |
| business_hours (horário) | **0** | — |
| holidays (feriados) | **0** | — |
| timeline_events | **0** | — |
| notificacoes_admin | **0** | — (renomeada de `notificacoes_luana` em 02/07) |
| cleanup_log | **0** | — |
| company_members | **0** | — |
| company_invitations | **0** | — |
| user_permissions | **0** | — |

Todas as sementes têm data de **30/06/2026 (~18:40)**, que é quando as migrations rodaram,
e **nunca foram editadas por uma pessoa** (o template tem `updated_by` vazio e
`updated_at` igual ao `created_at`). São o esqueleto padrão, não configuração de verdade.

---

## Clientes, atendimentos e mensagens

**Não há nada** — 0 clientes, 0 atendimentos, 0 mensagens, 0 arquivos de mídia. Portanto
não há como "ter cara de teste" nem "cara de real": **não existe nenhuma conversa no
banco**. Nenhum número de teste, nenhum "oi/teste/123", nada digitado durante o
desenvolvimento sobreviveu à migração para este projeto.

## Usuários / colaboradores

- **Pessoas reais: 0.** Não há nenhuma linha em `users` nem nenhuma conta em `auth.users`.
- **Usuários de sistema: 0 (como linha no banco).** O "robô" (`BOT_USER_ID`), o "Operador"
  (`OPEN_USER`) e o usuário de cron são apenas **constantes de UUID no código** — não
  existem como registros neste banco. Hoje, como não há login e não há usuários, o app usa
  o "Operador" de mentira do frontend (ver [Multi‑empresa](04-multiempresa-e-autenticacao.md)).

## O que existe na "Empresa Exemplo"

| Item | Situação real |
|------|---------------|
| **Empresa** | 1 linha: "Empresa Exemplo" (`11111111‑…`), ativa, **sem** número de WhatsApp e **sem** credenciais. |
| **Departamentos** | 1: "Administrativo" (cor roxa) — semente. |
| **Assuntos** | Nenhum. → **Recurso removido em 02/07** (tabela `subjects` dropada). |
| **Roteamento** | Nenhum. → **Recurso removido em 02/07** (tabela `especialista_routing` dropada). |
| **Templates** | 1: `triagem_lembrete_sem_resposta`. → **atualizado em 02/07**: agora 5 (semeados `triagem_boas_vindas`, `triagem_pergunta_departamento`, `triagem_confirmacao`, `triagem_erro_formato`). |
| **Configurações** | 5 chaves: `bot_ativado_em`, `pendentes_abertos_a_todos=false`, `triagem_lembrete_ativo=true`, `triagem_lembrete_minutos=30`, `triagem_reinicia_ao_virar_dia=true`. |
| **Horário comercial / feriados** | Nenhum cadastrado. |

Ou seja: **nada foi configurado de verdade ainda** — é tudo o padrão que veio das migrations.

---

## A trava e o interruptor do bot (valores reais)

| Chave | Valor real | Significado |
|-------|-----------|-------------|
| `platform_config.auth_enforcement_enabled` | **`false`** | Isolamento por empresa **desligado** (modo aberto), como esperado. |
| `system_config.bot_ativo` | **não existe** | A linha **não está no banco**. Pela regra do kill‑switch ("qualquer coisa diferente de `true` = desligado"), o **bot está efetivamente DESLIGADO**. |
| `system_config.bot_ativacao_programada` | não existe | Não há reativação agendada. |

---

## Credenciais de WhatsApp (o que está preenchido)

**Nada está preenchido. A integração com o WhatsApp não está configurada em lugar nenhum.**

- **Nas colunas de `companies`:** `whatsapp_phone`, `zapi_instance_id`, `zapi_token` e
  `zapi_client_token` estão **todos vazios**.
- **Nos segredos das Edge Functions:** existem **apenas** os segredos padrão do Supabase
  (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`,
  `SUPABASE_JWKS`, `SUPABASE_PUBLISHABLE_KEYS`, `SUPABASE_SECRET_KEYS`). **Não existem**
  `ZAPI_INSTANCE_ID`, `ZAPI_TOKEN` nem `ZAPI_CLIENT_TOKEN`. Também **não existe**
  `CLEANUP_CONFIRM_TOKEN`.

**Consequência prática (no snapshot de 01/07):** se qualquer função tentar falar com o
WhatsApp, ela falha na hora (o cliente Z‑API exige esses segredos e lança erro
"Secrets ZAPI_* ausentes"). O sistema **não estava conectado a nenhum WhatsApp** naquele
momento.

> **→ atualizado em 02/07:** o WhatsApp agora está **CONECTADO** via **uazapi**. O motor
> passou de Z‑API para uazapi; os segredos relevantes hoje são `UAZAPI_URL`/`UAZAPI_TOKEN`.

---

## Infraestrutura (schema, funções, automações)

| Item | Estado real |
|------|-------------|
| **Migrations** | **45 aplicadas** = 45 arquivos locais → schema **100% em dia**. |
| **Tabelas** | Eram **20** no mapa. → **atualizado em 02/07: 18** (removidas `subjects` e `especialista_routing`; `notificacoes_luana` renomeada para `notificacoes_admin`, sem mudar a contagem). |
| **Cofre de mídia** | Bucket `mensagens-midia` existe (privado), vazio. |
| **Extensões** | `citext`, `pg_cron`, `pg_net`, `pg_stat_statements`, `pgcrypto`, `plpgsql`, `supabase_vault`, `uuid-ossp`. |
| **Edge Functions** | **As 13 publicadas e ATIVAS** (versão 2), todas com `verify_jwt = false`. |
| **Tarefas automáticas (cron)** | Snapshot 01/07: ⚠️ **Zero jobs agendados**. → **atualizado em 02/07: 5 jobs ATIVOS** no `pg_cron` (`triagem-bot` 10 s, `cron-retry-mensagens-falha` 2 min, `cron-notificacao-admin` 5 min, `cron-encerramento-automatico` 30 min, `cron-bot-reactivation` diário 03:00 UTC). |

---

## Divergências do mapa (feito pelo código) e riscos escondidos

O mapa anterior descrevia o sistema **como ele funciona quando está em operação**. O banco
real mostra que ele **ainda não está em operação**. Pontos que destoam ou merecem atenção:

1. **Não há dados para "limpar".** O plano de separar teste × real não se aplica aqui:
   não existe nenhum cliente/atendimento/mensagem. A "limpeza de mocks" neste banco se
   resume, no máximo, a decidir o destino da **Empresa Exemplo** e das sementes.

2. **O bot está desligado por ausência de configuração.** A linha `bot_ativo` nem existe
   (isso **continua valendo em 02/07**). No snapshot de 01/07 também **não havia nenhum job
   de cron agendado** — então, mesmo que `bot_ativo` fosse ligado, `triagem-bot`,
   encerramento automático, aviso ao Administrador e reenvio **não rodariam**, porque nada
   os disparava. **→ atualizado em 02/07:** agora existem **5 crons ATIVOS** disparando essas
   funções (ver tabela de infraestrutura); portanto, hoje, basta ligar `bot_ativo` para o
   robô operar.

3. **WhatsApp não conectado (no snapshot de 01/07).** Sem `ZAPI_*` (nem creds em `companies`),
   não havia envio nem recebimento. **→ atualizado em 02/07:** o WhatsApp está **conectado
   via uazapi** — o motor migrou de Z‑API para uazapi.

4. **Faltavam quase todos os templates da triagem (no snapshot de 01/07).** Só existia 1
   texto. **→ atualizado em 02/07:** agora são **5** (semeados os textos de boas‑vindas,
   pergunta de departamento, confirmação e erro de formato).

5. **Todas as 13 funções estão com `verify_jwt = false`** (não só o webhook, como sugeria
   o `config.toml`). As que exigem login (envio, iniciar atendimento, criar colaborador)
   fazem essa checagem **dentro do próprio código**, não na plataforma. Não é
   necessariamente um problema, mas é bom saber.

6. **Nenhuma conta de login existe** (`auth.users = 0`). Ligar autenticação de verdade
   exigirá criar os primeiros usuários/donos do zero.

---

## Resumo: o que é seguro apagar × o que é intocável

**Seguro apagar (mas quase não há o que):**
- Não existem clientes, atendimentos, mensagens, mídias ou usuários de teste — **nada a
  remover nesse sentido**.
- Se quiser um começo 100% limpo, o único conteúdo "de exemplo" são as sementes: o
  departamento "Administrativo", o template `triagem_lembrete_sem_resposta` e as 5
  configs. São descartáveis/recriáveis, mas **inofensivos** — servem de base padrão.

**Intocável (não apagar):**
- **O schema inteiro** (as tabelas — 20 no snapshot, **18 desde 02/07** —, funções,
  gatilhos, RLS) — é a fundação.
- **A "Empresa Exemplo"** — apesar do nome, ela é o **contêiner** onde qualquer dado futuro
  vai nascer enquanto o multi‑empresa estiver desligado. O caminho natural é **renomeá‑la
  para Almore**, não deletá‑la.
- **A trava `auth_enforcement_enabled = false`** — manter assim no uso interno.

**Em vez de "limpar", o próximo passo real é "configurar":** conectar o WhatsApp
(uazapi/segredos), agendar os crons, criar os templates e o horário comercial e cadastrar
os primeiros colaboradores. *(Nota 02/07: WhatsApp já conectado, crons já agendados e
templates de triagem já semeados; o item de assuntos/roteamento saiu do escopo — recurso
removido.)* Ver
[Dados de exemplo e riscos](05-dados-de-exemplo-e-riscos.md) para os pontos da migração
Z‑API → uazapi.
