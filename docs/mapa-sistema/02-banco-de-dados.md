# 02 — Banco de dados

O banco é **PostgreSQL, hospedado no Supabase**. Toda a estrutura está descrita nos
arquivos de `supabase/migrations/` (a "história" do banco, em ordem de data). Aqui está
o mapa completo em linguagem simples.

## Índice
- [As tabelas, uma por uma](#as-tabelas-uma-por-uma)
- [Como as tabelas se ligam](#como-as-tabelas-se-ligam)
- [Quais tabelas têm "empresa" (company_id)](#quais-tabelas-têm-empresa-company_id)
- [Funções, gatilhos e regras automáticas](#funções-gatilhos-e-regras-automáticas)
- [Segurança por linha (RLS)](#segurança-por-linha-rls)
- [Colunas com nome "zapi"](#colunas-com-nome-zapi)

---

## As tabelas, uma por uma

### Estrutura da empresa (multi‑empresa)
| Tabela | Para que serve |
|--------|----------------|
| **companies** | As empresas/workspaces — a raiz de tudo. Guarda também as **credenciais do WhatsApp** de cada empresa (`zapi_instance_id`, `zapi_token`, `zapi_client_token`) e o número (`whatsapp_phone`). |
| **company_members** | Liga uma **pessoa** a uma **empresa**, com um **papel** (`dono`, `administrador`, `colaborador`) e, para colaborador, o departamento. Só um dono por empresa (protegido). |
| **company_invitations** | Convites ainda não aceitos (pessoa convidada que ainda não entrou). |
| **platform_config** | Uma tabelinha de **configuração global** (não por empresa). Guarda a **trava** `auth_enforcement_enabled`. Ver [Multi‑empresa](04-multiempresa-e-autenticacao.md). |

### Pessoas e permissões
| Tabela | Para que serve |
|--------|----------------|
| **users** | Os colaboradores (atendentes, supervisores). Pode ser pessoa real (com e‑mail) ou usuário "de sistema" (bot/automação, sem e‑mail). Tem `ativo`, `disponivel`, `is_superadmin` e o **`whatsapp`** (telefone pessoal em E.164, opcional) — usado para avisar o colaborador quando um atendimento é repassado/atribuído a ele. **Não tem `company_id`** — a empresa vem via `company_members`. A coluna `whatsapp` é PII: **não é legível direto pelo cliente** — só via a RPC `admin_list_user_whatsapps` (ver adiante). |
| **user_permissions** | As permissões soltas de cada usuário (ex.: `manage_users`, `force_close`). É o sistema de papéis **antigo**, ainda em uso. |

### Atendimento (o coração)
| Tabela | Para que serve |
|--------|----------------|
| **clients** | Os clientes, identificados pelo número de WhatsApp (`numero_whatsapp`). Tem também `chat_lid`, um identificador alternativo de conversa usado pela API do WhatsApp. |
| **departments** | Os setores de atendimento. |
| **atendimentos** | **A conversa/ticket.** Guarda o status (`em_triagem`, `pendente`, `reservado`, `em_atendimento`, `encerrado`), o estágio da triagem (`aguardando_inicio` → `aguardando_departamento` → `aguardando_colaborador` (só sessão) → `concluida`), quem está atendendo (`assigned_to`), o departamento atual, marcos de tempo (início, 1ª resposta, encerramento, motivo) e `is_sessao` (`true` quando veio de um número da **Lista de Sessões** — roda o fluxo interno). |
| **mensagens** | **Cada mensagem.** Direção (`inbound`/`outbound`), quem enviou (`cliente`/`atendente`/`bot`/`sistema`/`externo`), tipo (texto, imagem, áudio, vídeo, documento, sticker, localização, contato), o texto, o link da mídia, resposta citada e o status de envio/entrega. Guarda o `zapi_message_id` (o ID no WhatsApp). |
| **timeline_events** | O **histórico** append‑only de cada atendimento (criado, triado, atribuído, repassado, escalado, encerrado, reaberto). Não pode ser editado nem apagado. Tem `notificacao_repasse_enviada_at`: carimbo de quando o aviso de repasse foi disparado ao WhatsApp do colaborador — garante **1 aviso por evento** (trava anti‑spam da função `notificar-repasse`). |

### Grupos de WhatsApp (estrutura separada)
| Tabela | Para que serve |
|--------|----------------|
| **grupos** | Um **grupo de WhatsApp**. Identidade é o `wa_jid` (`120363...@g.us`, único por empresa). Guarda nome, tópico, foto, nº de participantes, se **nosso número é admin** (`sou_admin`), se o grupo é "somente admins enviam" (`somente_admin_envia`), `ativo` (false = saímos/fomos removidos — nunca apagamos) e `synced_at`. |
| **grupo_mensagens** | Cada mensagem do grupo. Mesmo formato de `mensagens`, **sem** atendimento, cliente nem departamento; em troca tem `participante_numero`/`participante_nome` (quem falou dentro do grupo). `sender_type` é `participante` (inbound), `atendente` (nós pelo sistema), `externo` (nós pelo celular da empresa) ou `sistema`. |
| **grupo_leituras** | Estado de leitura por pessoa (`grupo_id + user_id + last_read_at`) — é o que alimenta o badge de não lidas. |

> **Por que grupo não mora em `atendimentos`/`mensagens`.** Dois motivos, e o segundo
> é o importante:
> 1. `atendimentos.client_id` e `mensagens.client_id` são `NOT NULL` apontando para
>    `clients`, que exige número em **E.164** — o JID de grupo não passa nesse CHECK.
> 2. Grupo **não tem bot, triagem, departamento, atribuição nem encerramento**. Se as
>    linhas de grupo morassem em `atendimentos`, cada gatilho, cron e view do fluxo de
>    ticket (promoção, liberação ao desligar colaborador, encerramento automático,
>    alerta de parado, reativação de bot, `vw_pendentes`, `triagem-bot`) precisaria de
>    um filtro "só se não for grupo" — e **um filtro esquecido significa o bot mandando
>    mensagem num grupo de cliente**. Com tabelas separadas isso é impossível por
>    construção: a automação simplesmente não alcança essas tabelas.
>
> O que **é** reaproveitado: os mesmos tipos de mensagem, o mesmo cofre de mídia
> (`mensagens-midia`, na subpasta `grupos/`) e os mesmos componentes de tela.

> **Onde está a autorização de grupo (importante).** As policies de RLS das três
> tabelas usam `is_member_of(company_id)` — que **hoje é no‑op**, porque a trava
> `auth_enforcement_enabled` está desligada (ver
> [Multi‑empresa](04-multiempresa-e-autenticacao.md)). Enquanto isso, quem de fato
> controla o acesso a grupo são as **Edge Functions**: `grupo-enviar`,
> `sincronizar-grupos` e o ramo de grupo do `mark-chat-read` exigem, via
> `_shared/empresa.ts`, vínculo **ativo** em `company_members` **e**
> `users.ativo = true`. Não há fallback para "a empresa mais antiga" nesse
> caminho — se houvesse, qualquer conta autenticada do projeto poderia enviar
> mensagem pelo número da empresa. Escrita nas três tabelas é só do backend
> (service_role); o frontend não tem policy de INSERT/UPDATE/DELETE.
> Quando `auth_enforcement_enabled` for ligado, a RLS passa a somar com isso —
> nenhuma dessas checagens deve ser removida em troca.

### Configuração e operação
| Tabela | Para que serve |
|--------|----------------|
| **system_config** | As configurações do sistema por empresa (pares chave/valor): `bot_ativo`, tempos, lembretes etc. É o que as abas **Tempos** e **Operação** editam. |
| **templates_mensagem** | Os textos das mensagens automáticas (aba Templates), incluindo os textos do fluxo de sessão (`sessao_*`). |
| **sessoes_triagem** | A **Lista de Sessões**: números liberados (VIPs internos) que pulam a triagem de cliente e rodam o fluxo interno (setor → colaborador). Colunas: `numero_whatsapp` (E.164, único por empresa), `nome` (saudação), `ativo`, `created_by`. Leitura por membro; **escrita só dono/administrador**. |
| **business_hours** | O horário comercial por dia da semana. |
| **holidays** | Feriados e datas especiais. |
| **notificacoes_admin** | A fila de avisos para o **Administrador** (o papel de supervisão) sobre atendimentos parados. Só o backend escreve nela. |
| **config_audit_log** | Registro de **quem mudou o quê** nas configurações. Append‑only. |
| **cleanup_log** | Registro de uma **limpeza de mensagens** já feita (guarda `zapi_message_id` e `zapi_response`). Ligada a uma função pontual — ver [Riscos](05-dados-de-exemplo-e-riscos.md). |

### Contatos do Google (People API)
| Tabela | Para que serve |
|--------|----------------|
| **google_integration** | A **conexão com a conta Google** (uma linha por empresa). Guarda os **tokens** (`access_token`, `refresh_token`, `token_expiry`), o `sync_token` da People API (sincronização incremental), o e‑mail conectado e o estado da última sincronização. **RLS sem policy para o papel autenticado → só o backend (service_role) lê** — o frontend nunca vê os tokens. |
| **contatos** | Os **contatos sincronizados** do Google. Colunas: `google_resource_name` (id estável do contato no Google, chave do upsert), `nome`, `numero_whatsapp` (E.164 normalizado, pode ser nulo), `numero_raw`, `emails`. Leitura liberada como `clients`; **escrita só pelo backend** (o sync roda na Edge Function). Índice por número para o casamento no Inbox. |

E o **cofre de mídia**: um "bucket" de Storage chamado **`mensagens-midia`** (privado)
onde ficam os arquivos de áudio, imagem, vídeo e documento. Não é uma tabela — os
arquivos são referenciados pela coluna `media_url` das mensagens.

> Nota (02/07/2026): o conceito de "assunto" foi removido do banco (tabelas `subjects` e
> `especialista_routing` dropadas, coluna `atendimentos.subject_id` removida) e a supervisão
> "Luana" virou "Administrador" — feito nas migrations `remove_assunto` e o rename para admin.

---

## Como as tabelas se ligam

Em linguagem simples, de cima para baixo:

```
companies (a empresa)
│
├── departments (setores)
│
├── clients (clientes) ── atendimentos (conversas) ── mensagens (cada mensagem)
│                                     │                     └── (mídia no cofre "mensagens-midia")
│                                     └── timeline_events (histórico da conversa)
│
├── users (colaboradores) ── user_permissions (permissões)
│        └── company_members (liga usuário à empresa, com papel e departamento)
│
└── configurações: system_config · templates_mensagem · business_hours · holidays
                    (+ auditoria: config_audit_log · cleanup_log · notificacoes_admin)
```

O caminho principal, que vale memorizar:
**cliente → atendimento → mensagens**, com o **departamento** definido na
triagem, e o **atendente** (`assigned_to`) definido quando alguém "pega"
o pendente.

Um detalhe de segurança do banco: as ligações são **compostas com a empresa** — por
exemplo, uma mensagem só pode apontar para um atendimento **da mesma empresa**. Isso
impede misturar dados de empresas diferentes por acidente (relevante quando o
multi‑empresa for ligado).

---

## Quais tabelas têm "empresa" (company_id)

Isto é o que decide o que é "multi‑empresa":

**TÊM `company_id`** (ou seja, já preparadas para separar por empresa):
`companies`, `company_members`, `company_invitations`, `departments`,
`clients`, `atendimentos`, `mensagens`, `timeline_events`,
`system_config`, `templates_mensagem`, `business_hours`, `holidays`,
`notificacoes_admin`, `config_audit_log`, `cleanup_log`,
`google_integration`, `contatos`, `sessoes_triagem`,
`grupos`, `grupo_mensagens`, `grupo_leituras`.

**NÃO têm `company_id`** (são globais):
- **users** e **user_permissions** — o usuário é global; a ligação com a empresa é feita
  pela `company_members`.
- **platform_config** — é a configuração global do sistema inteiro, não de uma empresa.

---

## Funções, gatilhos e regras automáticas

O banco não é só tabelas — ele tem lógica embutida que roda sozinha. As mais importantes:

### Regras que protegem os dados (gatilhos/triggers)
- **Histórico imutável:** `timeline_events` e `config_audit_log` **não podem** ser
  editados nem apagados.
- **Mensagens são "definitivas":** vários campos de `mensagens` não mudam depois de
  criados; apagar mensagem é bloqueado (só service_role/superadmin). O `zapi_message_id`
  fica imutável depois de preenchido.
- **Dono protegido:** não dá para remover ou rebaixar o dono de uma empresa.
- **Superadmin protegido / campos administrativos:** o gatilho `protect_superadmin_flag`
  (BEFORE UPDATE em `users`) impede que um usuário **não‑admin** altere colunas
  administrativas da própria linha — `is_superadmin`, `is_system_user`, `department_id`,
  `ativo` — fechando um escalonamento de privilégio (antes dava para virar superadmin com
  um UPDATE direto). Admin (superadmin/`manage_users`) e o backend (service_role) seguem
  livres; `nome`/`whatsapp`/`disponivel` continuam editáveis pelo próprio. `is_superadmin`
  segue imutável depois de definido como TRUE.
- **Auditoria automática:** qualquer mudança em configurações, templates, horários,
  departamentos etc. é registrada sozinha em `config_audit_log` (quem, o quê, valor
  antigo → novo).

### Regras de negócio automáticas
- **Promoção do atendimento:** quando o atendente manda a **primeira resposta**, o
  atendimento vira `em_atendimento` e grava a hora da 1ª resposta.
- **Carimbo de departamento:** ao sair da triagem, as mensagens recebem o departamento
  definido.
- **Liberação ao desligar colaborador:** se um atendente é desativado, os atendimentos
  dele voltam a ficar `pendente`.
- **Horário comercial:** funções que dizem se um momento está dentro do expediente e
  qual o próximo horário de abertura (usam o fuso `America/Sao_Paulo`).
- **Continuidade:** funções que verificam se o cliente já foi atendido por alguém no mesmo
  dia, para manter o mesmo atendente.

### Ações chamadas pelas telas (funções RPC)
São as "funções de banco" que as telas acionam diretamente:
- **`claim_pendente`** — "Atender" um pendente (assume para você).
- **`assign_pendente_a_usuario`** — atribuir um pendente a outra pessoa.
- **`repassar_atendimento`** — repassar a conversa.
- **`encerrar_atendimento`** — encerrar.
- **`cron_reativar_bot`** — religa o bot na data agendada (usada por uma tarefa automática).
- **`payload_notificacao_admin`** — monta os dados do aviso para a supervisão.
- **`get_grupos_unread_counts`** / **`get_my_grupos_unread_total`** / **`marcar_grupo_lido`** —
  as três equivalentes de grupo para o badge de não lidas. Mesma regra do individual:
  conta as mensagens que chegaram depois do maior entre (a) a sua última leitura e
  (b) a última mensagem enviada por alguém do time (uma resposta zera o contador para
  todos). `marcar_grupo_lido` fixa `user_id = auth.uid()` — ninguém marca leitura em
  nome de outra pessoa.
- **`admin_list_user_whatsapps`** — devolve `id`+`whatsapp` dos colaboradores para a tela
  de Colaboradores. Só retorna o número para **admin** (superadmin/`manage_users`) — que vê
  todos — e para a **própria linha** do chamador. É a porta de leitura do telefone pessoal,
  já que a coluna `users.whatsapp` não é mais legível direto pelo cliente (PII/LGPD).

### Uma "vista" (view)
- **`vw_pendentes`** — uma consulta pronta que junta atendimentos pendentes com dados do
  cliente e departamento, já com o tempo de espera calculado.

---

## Segurança por linha (RLS)

**RLS** ("Row Level Security") é a regra que decide **quais linhas cada usuário pode ver**
em cada tabela. Está **ligada em todas as tabelas**. As regras, resumidas:

- Você só vê dados **da sua empresa** (`is_member_of`).
- Dentro da empresa: **donos e administradores veem tudo**; **colaboradores veem só o seu
  departamento** (mais os pendentes, se o "modo emergência" estiver ligado).
- Configurações só podem ser mudadas por dono/administrador.
- Alguns registros (avisos do Administrador, auditoria) só são criados pelo **backend**.

**Porém — e isto é o mais importante:** todas essas regras passam por um "porteiro" único,
a função `auth_enforcement_enabled()`. Enquanto a trava está **desligada** (o caso de
hoje), o porteiro responde "pode tudo" e **o RLS não separa nada** — todos veem tudo.
Detalhes em [Multi‑empresa e autenticação](04-multiempresa-e-autenticacao.md).

---

## Colunas com nome "zapi"

O sistema fala com o WhatsApp pela **Z‑API** hoje (o alvo é a **uazapi**). Alguns nomes
no banco ficaram como `zapi_*` — **não quebram nada**, são só nomes, mas é bom saber
onde estão:

| Tabela | Coluna(s) `zapi`/relacionada | Para que serve |
|--------|------------------------------|----------------|
| **companies** | `zapi_instance_id`, `zapi_token`, `zapi_client_token` | Credenciais do WhatsApp por empresa. |
| **mensagens** | `zapi_message_id` | O ID da mensagem no WhatsApp (evita duplicar quando o webhook reenvia). |
| **cleanup_log** | `zapi_message_id`, `zapi_response` | Registro da limpeza pontual de mensagens. |
| **clients** | `chat_lid` | Identificador alternativo de conversa (não tem "zapi" no nome, mas é da mesma integração). |

> Quando a migração para a uazapi acontecer, estes nomes e as credenciais em `companies`
> são candidatos naturais a renomear/reaproveitar. Ver [Riscos](05-dados-de-exemplo-e-riscos.md).
