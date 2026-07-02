# 01 — Telas e abas

Este documento percorre **todas as telas**, uma por uma. Para cada uma: para que serve,
quais abas/seções tem, **todos os botões e o que cada um faz**, de onde vêm os dados que
ela mostra e o que ela grava quando você salva.

> **Como você navega.** À esquerda há uma **barra lateral** (menu) fixa. O que aparece
> nela depende das suas permissões (ver [Papéis](04-multiempresa-e-autenticacao.md)).
> Hoje, no modo aberto, você entra como "Operador" administrador e **vê tudo**.

## Índice
- [Barra lateral e barra de topo](#barra-lateral-e-barra-de-topo)
- [Login e página inicial](#login-e-página-inicial)
- [Inbox (caixa de entrada)](#inbox-caixa-de-entrada) — a tela principal
- [Pendentes](#pendentes)
- [Supervisão](#supervisão)
- [Dashboard](#dashboard)
- [Contatos](#contatos)
- [Configurações](#configurações) — 7 abas
- [Telas internas da Almore (workspaces)](#telas-internas-da-almore-workspaces)

---

## Barra lateral e barra de topo

**Arquivos:** `src/components/AppSidebar.tsx`, `src/components/TopBar.tsx`, `src/routes/_app.tsx`

A **barra lateral** é o menu principal. Cada item leva a uma tela e só aparece se você
tiver permissão:

| Item | Vai para | Aparece para quem |
|------|----------|-------------------|
| **Dashboard** | `/dashboard` | Superadmin ou quem tem `view_all_departments` |
| **Inbox** | `/inbox` | Todos |
| **Pendentes** | `/pendentes` | Todos (mostra um **selo com a contagem** de pendentes, atualizado a cada 30s) |
| **Contatos** | `/contatos` | Todos (lista os contatos do Google) |
| **Supervisão** | `/supervisao` | Superadmin ou `view_all_departments` |
| **Configurações** | `/configuracoes` | Apenas superadmin |

Na barra lateral também há o **avatar do usuário** (mostra as iniciais do nome). O
sistema usa **somente o tema claro** — não há botão para alternar para o tema escuro
(o CSS do tema escuro continua no código, só não há mais UI para ativá-lo).

A **barra de topo** (TopBar) mostra o título da página, um sininho de notificação (hoje
é **apenas visual, sem função**) e o avatar. **Não há botão de logout nem troca de
empresa** — coerente com o modo aberto atual.

---

## Login e página inicial

**Arquivos:** `src/routes/login.tsx`, `src/routes/_app.index.tsx`

Hoje **não existe tela de login de verdade**. As duas rotas só redirecionam:

- `/login` → manda direto para `/inbox`.
- `/` (raiz) → manda direto para `/inbox`.

Ou seja, qualquer pessoa que abra o sistema já entra direto. Isso é o "modo aberto"
(explicado em [Multi‑empresa e autenticação](04-multiempresa-e-autenticacao.md)).

---

## Inbox (caixa de entrada)

**Arquivos:** `src/routes/_app.inbox.tsx`, `src/lib/inbox-queries.ts`, `src/lib/inbox-history.ts`,
`src/hooks/useChatHistory.ts`, `src/hooks/useAudioRecorder.ts`, `src/hooks/useSignedMediaUrl.ts`,
`src/components/inbox/*`, `src/components/inbox-media/*`

É a **tela principal** — onde o atendimento acontece. Tem dois painéis, como o WhatsApp Web.

### Painel esquerdo — lista de conversas
- Botão **"Iniciar atendimento"** (topo) — abre o diálogo para começar uma conversa do zero.
- Campo **"Buscar conversas…"** — filtra por nome do cliente, telefone ou pelo **conteúdo
  das mensagens** (espera você parar de digitar, ~300ms).
- A lista mostra, para cada conversa: avatar com iniciais, nome, horário da última
  mensagem, uma prévia (mídia aparece como emoji: 📷 imagem, 🎤 áudio, 🎥 vídeo, 📎
  documento) e selos de departamento e status.
- **O que cada um vê:** um atendente comum vê **só as conversas atribuídas a ele** que
  estão `reservado` ou `em_atendimento`. A supervisão ("Administrador") vê **todas**, inclusive
  as em triagem e encerradas.

### Painel direito — a conversa aberta
No topo: nome/telefone do cliente e selos. Os botões variam conforme a situação:

| Botão | O que faz | Como funciona por dentro |
|-------|-----------|--------------------------|
| **Atribuir a mim** | Aparece só no **modo supervisão**, quando a conversa não está em triagem. Assume o atendimento para você. | Atualiza `atendimentos`: `assigned_to = você`, `status = em_atendimento`, `assigned_at = agora`. |
| **Repassar** | Passa a conversa para outro colaborador, com observação opcional. | Chama a função de banco **`repassar_atendimento`**. Muda `assigned_to`/`status` e registra na linha do tempo. |
| **Encerrar** | Fecha o atendimento (com motivo opcional). | Chama a função de banco **`encerrar_atendimento`**. Marca `status = encerrado`, `closed_at`, `closed_by_user_id`, `close_reason`. |
| **Linha do tempo** | Só para a supervisão. Abre um painel lateral com **todos os atendimentos anteriores** daquele cliente; clicar em um deles rola o chat até ali. | Lê `atendimentos` do cliente (função `listClientAtendimentosVisiveis`). |

Na área central ficam as mensagens (rolagem infinita para cima, com separadores de data
e de atendimento). Passando o mouse sobre uma mensagem aparece **"Responder"** (citar).

### Barra de escrever (rodapé)
No modo supervisão, no lugar da barra aparece um aviso amarelo "Modo supervisão ·
Visualização". Caso contrário, você tem:

1. **Anexar (clipe)** — abre um menu com **Documento**, **Fotos e vídeos** e **Câmera**
   (máx. 16 MB). Outras opções (áudio via anexo, contato, enquete, evento, figurinha)
   aparecem como "em breve", desabilitadas. Ao escolher um arquivo, abre uma
   **pré‑visualização** onde você adiciona uma legenda antes de enviar.
2. **Campo de texto** — digite e tecle Enter (ou o botão enviar).
3. **Microfone** — grava áudio. Aparece uma barra com cronômetro (limite 120s), com
   pausar/parar; depois você **ouve a prévia** e decide enviar ou apagar.

### O que cada envio faz (de onde vem e o que grava)

Todo envio segue o mesmo padrão: primeiro **grava a mensagem no banco** (tabela
`mensagens`, como `outbound`/`atendente`, com `status_envio = aguardando_envio`), depois
**dispara uma Edge Function** que manda para o WhatsApp:

| Ação na tela | Grava em `mensagens` | Função de backend chamada |
|--------------|----------------------|---------------------------|
| Enviar **texto** | `tipo = texto`, `content` | `send-whatsapp-message` |
| Enviar **áudio** | `tipo = audio`, arquivo no cofre `mensagens-midia` | `send-whatsapp-audio` |
| Enviar **imagem/vídeo/documento** | `tipo = imagem/video/documento`, arquivo no cofre, legenda em `content` | `send-whatsapp-media` |
| **Responder** (citar) | preenche `reply_to_message_id` | (junto com o envio acima) |
| **Iniciar atendimento** | cria um novo `atendimento` | `iniciar-atendimento` |

> Se o envio ao WhatsApp falhar, a mensagem **não some** — fica marcada como falha e uma
> tarefa automática (`cron-retry-mensagens-falha`) tenta reenviar depois.

### Diálogo "Iniciar atendimento"
Busca um cliente pelo nome/telefone (ou cria um novo na hora). A supervisão pode
escolher o **departamento** e **para qual atendente** atribuir. Se o cliente já tem uma
conversa em aberto, o sistema **avisa e bloqueia** (não deixa abrir duas). Ao confirmar,
chama a função `iniciar-atendimento`, que cria o atendimento **já em `em_atendimento`**
(pula a triagem).

### Como as mídias recebidas aparecem
As fotos, áudios, vídeos e documentos ficam num **cofre privado** (`mensagens-midia`).
A tela gera um "link temporário" (15 min) para exibir cada arquivo. Enquanto o backend
ainda está baixando a mídia, aparece um "carregando"; se o download falhou, aparece
"Mídia indisponível" com um botão de tentar de novo.

### Atualização em tempo real
A tela "escuta" o banco: quando chega uma mensagem nova ou muda um atendimento, a lista
e o chat se atualizam sozinhos, sem recarregar a página.

---

## Pendentes

**Arquivos:** `src/routes/_app.pendentes.tsx`, `src/lib/pendentes-queries.ts`

Lista os atendimentos **sem dono** (status `pendente` ou `em_triagem` sem ninguém
atribuído) para os atendentes se apropriarem.

**Filtros disponíveis:** departamento (bloqueado para quem não é superadmin),
tempo aguardando ("até 30min", "30min–2h", "mais de 2h"), ordenação (menor/maior tempo,
por departamento) e busca por nome/telefone/prévia. Há dois modos de ver: **grade**
(cards) e **tabela**.

**Botões (em cada atendimento da lista):**

| Botão | O que faz |
|-------|-----------|
| **Atender** | Assume o atendimento para você e leva ao Inbox. Chama a função de banco `claim_pendente`. Se outra pessoa pegou primeiro, avisa "já foi atribuído". |
| **Pré‑visualizar** (olho) | Abre uma janela com as **últimas 5 mensagens** da conversa, sem assumir. Se o atendimento for pego por outra pessoa enquanto você espia, a janela fecha sozinha. |
| **Atribuir** | Só para quem tem `assign_pending`. Abre uma janela para escolher **outro** colaborador e atribuir a ele (função `assign_pendente_a_usuario`). |

A tela se atualiza em tempo real e a cada 60s. O selo de contagem no menu lateral reflete
o número de pendentes.

---

## Supervisão

**Arquivos:** `src/routes/_app.supervisao.tsx`, `src/components/supervisao/SupervisaoKanban.tsx`, `src/lib/supervisao-queries.ts`

Visão de **todos os atendimentos** (qualquer status), para supervisores. Dois modos:
**Tabela** e **Kanban** (a escolha fica lembrada no navegador).

**Filtros:** período (hoje / 7 dias / 30 dias / customizado), departamento, atendente
("todos", "sem dono", ou um nome), status e busca. Há um botão **"Limpar
filtros"**.

**Modo Tabela:** colunas de cliente, departamento, atendente, status, última
mensagem e início. Clicar numa linha abre a conversa no Inbox **em modo supervisão**
(`/inbox?mode=supervision&conversation=…`). Tem paginação de 15 em 15.

**Modo Kanban:** colunas por status (`em_triagem`, `reservado`, `em_atendimento`,
`pendente`, `encerrado`). Você pode **arrastar cartões**:

| Arrastar para… | O que acontece |
|----------------|----------------|
| **Reservado** | Se não tem dono, reserva para você (`claim_pendente`). Se já tem dono, avisa para usar o "repasse" pela conversa. |
| **Encerrado** | Abre uma confirmação com motivo opcional e encerra (`encerrar_atendimento`). |
| **Outros status** | Não é permitido manualmente — o sistema avisa que "depende do fluxo do atendimento". |

A coluna "Encerrado" mostra só os 30 mais recentes. Atualiza em tempo real e a cada 60s.

---

## Dashboard

**Arquivos:** `src/routes/_app.dashboard.tsx`, `src/lib/dashboard-queries.ts`

Painel de indicadores. Um seletor de **período** (hoje, ontem, 7 dias, 30 dias ou
customizado) recalcula tudo. Atualiza sozinho a cada 60s.

**Indicadores principais:** "Em aberto agora" (fica vermelho se passa de 5), "Encerrados
no período", "Tempo médio da 1ª resposta" e "Mensagens no período".
**Secundários:** atendimentos no período, encerrados e **taxa de resolução** (%).
**Gráficos:** barras de "atendimentos por dia (7 dias)" e uma **pizza por departamento**
(usa a cor de cada departamento).

Tudo vem das tabelas `atendimentos`, `mensagens` e `departments`. É **só leitura** — o
Dashboard não grava nada.

---

## Contatos

**Arquivos:** `src/routes/_app.contatos.tsx`, `src/lib/contatos-queries.ts`,
`src/components/inbox/IniciarAtendimentoDialog.tsx` (reaproveitado)

A tela **Contatos** lista os contatos sincronizados da **conta Google da Almore** (tabela
`contatos`). Serve para **iniciar uma conversa nova** a partir de um contato salvo.
Substituiu a antiga tela "Clientes" (que fazia um cadastro local no banco) — a tabela
`clients` e os helpers `clientes-queries.ts` continuam existindo (são o núcleo do
sistema), só a **tela** de cadastro foi aposentada.

- **Busca** por nome ou número (com 300ms de debounce) e **paginação** de 50 em 50.
- Cada contato mostra nome, número (formatado) e um botão **"Conversar"**. Ao clicar, o
  sistema **garante que existe um cliente** com aquele número (cria/atualiza via
  `cadastrar-cliente`, usando o nome do contato) e abre o diálogo **"Iniciar atendimento"**
  já com o contato escolhido — daí segue o mesmo fluxo de `iniciar-atendimento`.
- Contatos **sem número de WhatsApp** aparecem, mas o botão "Conversar" fica desabilitado.
- **"Atualizar agora"** (quando conectado) força uma sincronização na hora.
- **Estados amigáveis:** "conta Google não conectada" (aponta para Configurações ›
  Contatos Google), "sem contatos ainda" (normal quando a lista do Google está vazia) e
  "nenhum resultado" para a busca.

> **Precedência de nome.** O nome salvo no contato do Google tem **prioridade** sobre o
> nome público do WhatsApp. No Inbox, se o número da conversa casa com um contato,
> aparece o nome salvo; se não casa, segue o número (ou o nome público do WhatsApp, como
> antes). Ver [Integrações](03-integracoes-e-edge-functions.md).

---

## Configurações

**Arquivos:** `src/routes/_app.configuracoes.tsx` + um componente por aba + `src/lib/configuracoes-queries.ts`

Central de ajustes do sistema. Só superadmin acessa. São **7 abas**, nesta ordem:
**Departamentos, Tempos, Horário, Templates, Colaboradores, Operação, Contatos Google.**

### Aba 1 — Departamentos
Gerencia os setores de atendimento. Tabela: `departments`.
- **Novo departamento** — nome + cor. (`createDepartment`)
- **Editar** — muda nome/cor. Bloqueado para o departamento de sistema "Triagem".
- **Remover** — só deixa se não houver colaboradores nem atendimentos em aberto ali.
- A lista mostra quantos colaboradores há em cada departamento.

### Aba 2 — Tempos
Ajusta prazos e limites do sistema (todos guardados em `system_config`). Cada item tem
um lápis para editar o número. Inclui, entre outros: intervalo anti‑flood da triagem,
tempo de reserva do especialista, tempo para avisar a supervisão, tempo de encerramento
automático, tentativas máximas da triagem e tempo de abandono.

### Aba 3 — Horário
Define o **horário comercial** e os **feriados**. Tabelas: `business_hours` e `holidays`.
- **Adicionar/remover faixa de horário** por dia da semana (valida que não se sobreponham).
- **Novo/editar/remover feriado** — data, descrição e, opcionalmente, um horário
  diferente naquele dia (senão, o dia fica fechado).

### Aba 4 — Templates
Edita os **textos das mensagens automáticas** do robô (boas‑vindas, pergunta de
departamento, confirmação de encaminhamento, lembrete, encerramento, aviso de fora de
horário etc.). Tabela: `templates_mensagem`.
- Escolha um template na lista, edite o texto e **Salve**.
- **Ativar/desativar** e **Novo template**.
- Você pode **inserir variáveis** que o sistema preenche sozinho, como `{{nome_cliente}}`,
  `{{lista_departamentos}}` (na pergunta de departamento) ou `{{departamento}}` (na
  confirmação de encaminhamento). A pergunta de departamento é enviada como **lista
  interativa** no WhatsApp ("Ver setores").

### Aba 5 — Colaboradores
Cadastra e gerencia os atendentes. Tabela: `users` (a criação chama a função
`criar-colaborador`).
- **Novo colaborador** — nome, e‑mail, senha inicial e departamento. Cria também o
  acesso (no Supabase Auth).
- **Editar** (nome, departamento; o e‑mail não muda), **Ativar/Desativar** (com proteção
  para você não se desativar sozinho sendo o superadmin).
- Busca e filtros por departamento e status (ativo / indisponível / inativo).

### Aba 6 — Operação
O **painel de controle do robô** (só superadmin). Tudo aqui é guardado em `system_config`.

| Controle | O que faz |
|----------|-----------|
| **Estado do bot** (liga/desliga) | O **kill‑switch** geral. Desligado, param: triagem automática, mensagens de fora de horário, encerramento automático e reenvios. **Continuam:** receber mensagens (webhook) e o envio manual pelo atendente. Ao religar, o sistema **ignora o acúmulo antigo** (carimba `bot_ativado_em`). |
| **Reativação programada** (calendário) | Agenda uma data para religar o bot sozinho. Pode cancelar. |
| **Pendentes abertos a todos** (modo emergência) | Enquanto a triagem está desligada, deixa todos os departamentos verem os pendentes uns dos outros. |
| **Reiniciar triagem ao virar o dia** | Se o cliente volta noutro dia, encerra a triagem antiga e começa uma nova. |
| **Lembrete na triagem sem resposta** + **tempo (min)** | Liga o lembrete automático quando o cliente para de responder na triagem, e define após quantos minutos. |

### Aba 7 — Contatos Google
Conecta os **contatos do Google** (People API). **Arquivos:**
`src/components/GoogleContatosTab.tsx`, `src/lib/contatos-queries.ts`, função
`google-contacts`. Tudo passa pela Edge Function — **nenhum token do Google fica no
navegador**.

| Controle | O que faz |
|----------|-----------|
| **Conectar Google** | Leva você ao consentimento do Google (conta da Almore) e autoriza a **leitura dos contatos** (`contacts.readonly`). Ao voltar, a conta fica conectada e o **1º sync** roda em segundo plano. |
| **Atualizar agora** | Força uma sincronização (incremental) na hora. |
| **Desconectar** | Revoga o acesso e limpa os tokens (os contatos já baixados permanecem até a próxima sincronização). |
| **Status** | Mostra o e‑mail conectado, a contagem de contatos e a data/situação da última sincronização. |

Estados: se os **secrets** `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` não estiverem no
servidor, a aba mostra "**integração ainda não configurada**"; conectado e com a lista
do Google vazia, mostra "**sem contatos ainda**" (é normal). Depois de conectado, a
sincronização é **contínua** (cron a cada 15 min) — contato novo/editado no Google
aparece sozinho.

---

## Telas internas da Almore (workspaces)

**Arquivos:** `src/routes/almore.tsx`, `src/routes/almore-membros.$companyId.tsx`, `src/lib/workspaces-queries.ts`

São telas **internas da Almore**, escondidas do menu — pertencem à parte **multi‑empresa
que está dormindo**. Não são usadas na operação do dia a dia hoje.

### `/almore` — Criar espaço (empresa)
Cria um novo "workspace" (empresa). Formulário: nome da empresa, nome e e‑mail do dono.
Ao criar, grava em `companies` e cria um **convite pendente** de "dono" em
`company_invitations`. Lista os espaços já criados, marcando "convite pendente" quando o
dono ainda não entrou. Tem um aviso de que é uma ferramenta temporária.

### `/almore-membros/:companyId` — Membros do espaço
Gerencia quem participa de um espaço:
- **Convidar pessoa** — nome, e‑mail, papel (administrador/colaborador) e departamento
  (obrigatório se colaborador). Grava em `company_invitations`.
- **Remover membro** e **Trocar papel/departamento** (o "dono" não pode ser trocado nem
  removido — protegido no banco). Tabelas: `company_members`, `company_invitations`,
  `departments`.

> Estas telas são o **único lugar** do frontend que hoje usa `company_id` de verdade.
> Toda a operação (Inbox, Pendentes, etc.) ignora empresa — ver
> [Multi‑empresa e autenticação](04-multiempresa-e-autenticacao.md).
