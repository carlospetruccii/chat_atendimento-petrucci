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
| **users** | Os colaboradores (atendentes, supervisores). Pode ser pessoa real (com e‑mail) ou usuário "de sistema" (bot/automação, sem e‑mail). Tem `ativo`, `disponivel`, `is_superadmin`. **Não tem `company_id`** — a empresa vem via `company_members`. |
| **user_permissions** | As permissões soltas de cada usuário (ex.: `manage_users`, `force_close`). É o sistema de papéis **antigo**, ainda em uso. |

### Atendimento (o coração)
| Tabela | Para que serve |
|--------|----------------|
| **clients** | Os clientes, identificados pelo número de WhatsApp (`numero_whatsapp`). Tem também `chat_lid`, um identificador alternativo de conversa usado pela API do WhatsApp. |
| **departments** | Os setores de atendimento. |
| **atendimentos** | **A conversa/ticket.** Guarda o status (`em_triagem`, `pendente`, `reservado`, `em_atendimento`, `encerrado`), o estágio da triagem, quem está atendendo (`assigned_to`), o departamento atual, e marcos de tempo (início, 1ª resposta, encerramento, motivo). |
| **mensagens** | **Cada mensagem.** Direção (`inbound`/`outbound`), quem enviou (`cliente`/`atendente`/`bot`/`sistema`/`externo`), tipo (texto, imagem, áudio, vídeo, documento, sticker, localização, contato), o texto, o link da mídia, resposta citada e o status de envio/entrega. Guarda o `zapi_message_id` (o ID no WhatsApp). |
| **timeline_events** | O **histórico** append‑only de cada atendimento (criado, triado, atribuído, repassado, escalado, encerrado, reaberto). Não pode ser editado nem apagado. |

### Configuração e operação
| Tabela | Para que serve |
|--------|----------------|
| **system_config** | As configurações do sistema por empresa (pares chave/valor): `bot_ativo`, tempos, lembretes etc. É o que as abas **Tempos** e **Operação** editam. |
| **templates_mensagem** | Os textos das mensagens automáticas (aba Templates). |
| **business_hours** | O horário comercial por dia da semana. |
| **holidays** | Feriados e datas especiais. |
| **notificacoes_admin** | A fila de avisos para o **Administrador** (o papel de supervisão) sobre atendimentos parados. Só o backend escreve nela. |
| **config_audit_log** | Registro de **quem mudou o quê** nas configurações. Append‑only. |
| **cleanup_log** | Registro de uma **limpeza de mensagens** já feita (guarda `zapi_message_id` e `zapi_response`). Ligada a uma função pontual — ver [Riscos](05-dados-de-exemplo-e-riscos.md). |

### Agenda do Google (People API)
| Tabela | Para que serve |
|--------|----------------|
| **google_integration** | A **conexão com a conta Google** (uma linha por empresa). Guarda os **tokens** (`access_token`, `refresh_token`, `token_expiry`), o `sync_token` da People API (sincronização incremental), o e‑mail conectado e o estado da última sincronização. **RLS sem policy para o papel autenticado → só o backend (service_role) lê** — o frontend nunca vê os tokens. |
| **agenda_contatos** | Os **contatos sincronizados** da agenda do Google. Colunas: `google_resource_name` (id estável do contato no Google, chave do upsert), `nome`, `numero_whatsapp` (E.164 normalizado, pode ser nulo), `numero_raw`, `emails`. Leitura liberada como `clients`; **escrita só pelo backend** (o sync roda na Edge Function). Índice por número para o casamento no Inbox. |

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
`google_integration`, `agenda_contatos`.

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
- **Superadmin protegido:** quem é superadmin não pode ser rebaixado por engano.
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
