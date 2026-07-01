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
| templates_mensagem | **1** | Semente (`triagem_lembrete_sem_resposta`) |
| system_config | **5** | Sementes (ver abaixo) |
| users | **0** | — |
| **auth.users** (contas de login) | **0** | — |
| clients | **0** | — |
| atendimentos | **0** | — |
| mensagens | **0** | — |
| mídias no cofre `mensagens-midia` | **0** | — |
| subjects (assuntos) | **0** | — |
| especialista_routing | **0** | — |
| business_hours (horário) | **0** | — |
| holidays (feriados) | **0** | — |
| timeline_events | **0** | — |
| notificacoes_luana | **0** | — |
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
| **Assuntos** | Nenhum. |
| **Roteamento** | Nenhum. |
| **Templates** | 1: `triagem_lembrete_sem_resposta`. **Faltam** os demais que o robô usa (boas‑vindas, pergunta de departamento/assunto, encerramento, fora de horário etc.). |
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

**Consequência prática:** se qualquer função tentar falar com o WhatsApp hoje, ela falha
na hora (o cliente Z‑API exige esses segredos e lança erro "Secrets ZAPI_* ausentes").
O sistema **não está conectado a nenhum WhatsApp** neste momento.

---

## Infraestrutura (schema, funções, automações)

| Item | Estado real |
|------|-------------|
| **Migrations** | **45 aplicadas** = 45 arquivos locais → schema **100% em dia**. |
| **Tabelas** | As **20** tabelas do mapa, nem uma a mais nem a menos. |
| **Cofre de mídia** | Bucket `mensagens-midia` existe (privado), vazio. |
| **Extensões** | `citext`, `pg_cron`, `pg_net`, `pg_stat_statements`, `pgcrypto`, `plpgsql`, `supabase_vault`, `uuid-ossp`. |
| **Edge Functions** | **As 13 publicadas e ATIVAS** (versão 2), todas com `verify_jwt = false`. |
| **Tarefas automáticas (cron)** | ⚠️ **Zero jobs agendados** no `pg_cron`. |

---

## Divergências do mapa (feito pelo código) e riscos escondidos

O mapa anterior descrevia o sistema **como ele funciona quando está em operação**. O banco
real mostra que ele **ainda não está em operação**. Pontos que destoam ou merecem atenção:

1. **Não há dados para "limpar".** O plano de separar teste × real não se aplica aqui:
   não existe nenhum cliente/atendimento/mensagem. A "limpeza de mocks" neste banco se
   resume, no máximo, a decidir o destino da **Empresa Exemplo** e das sementes.

2. **O bot está desligado por ausência de configuração.** A linha `bot_ativo` nem existe.
   Além disso, **não há nenhum job de cron agendado** — então, mesmo que `bot_ativo` fosse
   ligado, `triagem-bot`, encerramento automático, aviso à Luana e reenvio **não rodariam**,
   porque **nada os dispara**. O mapa assumia crons rodando "a cada ~10s / 5min / 30min";
   na prática, **não estão agendados** neste projeto.

3. **WhatsApp não conectado.** Sem `ZAPI_*` (nem creds em `companies`), não há envio nem
   recebimento. O webhook está publicado, mas rejeitaria/erraria por falta de
   `ZAPI_CLIENT_TOKEN`.

4. **Faltam quase todos os templates da triagem.** Só existe 1 dos ~9 textos que o robô
   usa. Uma triagem real precisaria dos demais criados.

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
- **O schema inteiro** (as 20 tabelas, funções, gatilhos, RLS) — é a fundação.
- **A "Empresa Exemplo"** — apesar do nome, ela é o **contêiner** onde qualquer dado futuro
  vai nascer enquanto o multi‑empresa estiver desligado. O caminho natural é **renomeá‑la
  para Almore**, não deletá‑la.
- **A trava `auth_enforcement_enabled = false`** — manter assim no uso interno.

**Em vez de "limpar", o próximo passo real é "configurar":** conectar o WhatsApp
(uazapi/segredos), agendar os crons, criar os templates e o horário comercial, cadastrar
os primeiros colaboradores e definir os assuntos/roteamento. Ver
[Dados de exemplo e riscos](05-dados-de-exemplo-e-riscos.md) para os pontos da migração
Z‑API → uazapi.
