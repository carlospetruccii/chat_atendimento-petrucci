# Mapa do Sistema — Atendimento via WhatsApp (Almore)

> **O que é este documento.** Um raio‑x completo do sistema, escrito para ser lido por
> qualquer pessoa (técnica ou não). Ele **descreve o que existe hoje** — não propõe
> mudanças. Foi montado varrendo todo o código, o banco de dados e as funções de
> backend em **01/07/2026**.

---

## Resumo em poucos parágrafos

É um sistema de **atendimento ao cliente via WhatsApp**. O cliente manda uma mensagem
no WhatsApp; um **robô de triagem** o recebe, pergunta o setor (departamento), e
encaminha a conversa para o atendente certo. Os atendentes trabalham numa
tela de **caixa de entrada** (Inbox) parecida com o WhatsApp Web: leem, respondem,
mandam áudio, foto, vídeo e documento, repassam a conversa para colegas e encerram o
atendimento. Supervisores acompanham tudo por um **painel** e um **quadro (kanban)**.

Por dentro, o sistema é feito de três camadas:

1. **A tela (frontend)** — um site em React que o atendente usa no navegador.
2. **O banco de dados (Supabase/PostgreSQL)** — onde ficam clientes, conversas,
   mensagens, configurações etc.
3. **O backend (Edge Functions)** — pequenos programas que rodam no servidor e fazem o
   trabalho pesado: receber mensagens do WhatsApp, enviar respostas, rodar o robô de
   triagem e as tarefas automáticas (encerrar conversas paradas, avisar a supervisão,
   reenviar mensagens que falharam).

O WhatsApp em si é acessado por um serviço externo. **Hoje o código usa a Z‑API** em
todos os pontos. O rumo do projeto é migrar para a **uazapi** — então cada ponto que
hoje diz "z‑api" é um lugar que vai precisar mudar (ver
[Integrações](03-integracoes-e-edge-functions.md) e [Riscos](05-dados-de-exemplo-e-riscos.md)).

### Estado atual, em uma frase

O sistema **nasceu como SaaS multi‑empresa**, mas hoje roda em **modo interno de uma
empresa só**: não há login de verdade, todo mundo entra como um "Operador"
administrador, e a separação por empresa existe no banco mas está **desligada por uma
única chave** (`auth_enforcement_enabled = 'false'`). Nada da base multi‑empresa foi
removido — ela está **dormindo**, pronta para ser reativada no futuro.

---

## Índice dos documentos

| Documento | O que cobre |
|-----------|-------------|
| **[01 — Telas e abas](01-telas-e-abas.md)** | Todas as telas, uma por uma; cada aba, cada botão e o que faz; de onde vêm os dados e o que é gravado. |
| **[02 — Banco de dados](02-banco-de-dados.md)** | Todas as tabelas, para que servem, como se ligam; funções, gatilhos e regras de segurança. |
| **[03 — Integrações e Edge Functions](03-integracoes-e-edge-functions.md)** | As 13 funções de backend; todo ponto de contato com o WhatsApp; onde está a Z‑API; as tarefas automáticas (crons). |
| **[04 — Multi‑empresa e autenticação](04-multiempresa-e-autenticacao.md)** | Login, papéis (permissões), a "trava" de isolamento por empresa e como ligá‑la. |
| **[05 — Dados de exemplo e riscos](05-dados-de-exemplo-e-riscos.md)** | Onde há dados mockados / "Empresa Exemplo", e os pontos de atenção antes de limpar os mocks e ligar a uazapi. |
| **[08 — Notificação de repasse no WhatsApp](08-notificacao-repasse-whatsapp.md)** | Aviso no WhatsApp pessoal do colaborador ao repassar/atribuir atendimento; correções de segurança (escalonamento de privilégio e PII do telefone); estado do rollout. |

---

## O ciclo de vida de um atendimento (visão ponta a ponta)

Este é o coração do sistema. Vale a pena entender esta sequência antes de mergulhar nos
detalhes:

1. **Chega uma mensagem.** O cliente escreve no WhatsApp. A Z‑API avisa o sistema
   chamando a função **`webhook-zapi-receive`**. Ela encontra (ou cria) o cliente,
   cria um **atendimento** com status `em_triagem` e grava a mensagem. Se veio foto/áudio,
   baixa o arquivo para um cofre privado de mídia (`mensagens-midia`).

2. **O robô de triagem age.** A função **`triagem-bot`** (roda sozinha a cada ~10s,
   se o bot estiver ligado) espera o cliente parar de mandar mensagens (uma pausa
   controlada por `delay_anti_flood_triagem`, na aba **Tempos**) e então lê o lote todo
   de uma vez. Manda a saudação e um **menu numerado de departamentos** (a lista
   interativa "Ver setores" do WhatsApp); o cliente responde o número e o robô confirma
   ("Certo! Te encaminhei para X…"). A conversa cai na fila **Pendentes** daquele
   departamento, pronta para um atendente pegar. Bordas: com só um departamento, o menu
   é pulado; sem nenhum, a conversa vai para uma Pendentes geral; resposta inválida
   repete o menu. No encaminhamento, mantém-se a continuidade com o atendente do mesmo
   dia; senão o último atendente daquele departamento; senão fica **`pendente`**. Se já
   existe um atendimento aberto, o robô não interfere.

3. **Um atendente assume.** Na tela **Pendentes**, o atendente clica em **Atender** e a
   conversa passa a ser dele. Ela aparece no **Inbox**.

4. **A conversa acontece.** No Inbox o atendente responde (texto, áudio, mídia). Cada
   resposta é gravada e enviada ao WhatsApp por uma função `send-whatsapp-*`. Ao mandar
   a primeira resposta, o status vira `em_atendimento`.

5. **Encerra.** O atendente **Encerra** (ou **Repassa** para um colega). Se a conversa
   ficar parada por muito tempo, uma tarefa automática encerra sozinha; se ficar
   `pendente` sem ninguém pegar, a supervisão ("Administrador") é avisada por WhatsApp.

6. **O WhatsApp confirma.** Quando a mensagem é entregue/lida no celular do cliente, a
   Z‑API avisa de novo o `webhook-zapi-receive`, que atualiza o status de cada mensagem.

Um detalhe importante: **o cliente também pode ser respondido pelo celular pessoal da
empresa** (fora do sistema). Nesse caso o webhook registra essa mensagem como "externo"
para ela aparecer no Inbox — e pode até reabrir um atendimento encerrado.

---

## Glossário rápido

| Termo | Significado |
|-------|-------------|
| **Atendimento** | Uma conversa/ticket entre um cliente e a empresa. Tem um status (em triagem, pendente, reservado, em atendimento, encerrado). |
| **Triagem** | A fase inicial automática, conduzida pelo robô, que descobre o departamento. |
| **Departamento** | Setor de atendimento (ex.: Administrativo, Suporte). |
| **Pendente** | Atendimento sem dono, esperando um atendente pegar. |
| **Reservado** | Atendimento já atribuído a um atendente, mas ele ainda não respondeu. |
| **Administrador** | O papel de **supervisão** — quem vê tudo e recebe os avisos de conversas paradas. Era chamado "Luana" antes. |
| **Bot / Kill‑switch** | O robô de triagem e as automações. Podem ser ligados/desligados por um interruptor (`bot_ativo`) na aba **Operação**. |
| **Z‑API** | Serviço externo usado hoje para falar com o WhatsApp. O alvo do projeto é trocar pela **uazapi**. |
| **Modo aberto** | O estado atual: sem login, todos entram como "Operador" administrador. |
| **Empresa Exemplo** | A empresa‑padrão (ID `11111111‑…`) onde **todos os dados de hoje** ficam guardados. |
| **`auth_enforcement_enabled`** | A "trava" única que liga/desliga a separação por empresa. Hoje: `false` (desligada). |

---

## Como o projeto está organizado (pastas)

```
src/                     → A tela (frontend, React + TanStack Router)
  routes/                → Uma "página" por arquivo (inbox, dashboard, pendentes, …)
  components/            → Peças de tela (abas de configuração, chat, kanban, diálogos)
  lib/                   → As "consultas" ao banco (o que cada tela lê e grava)
  hooks/                 → Lógica reutilizável (usuário atual, gravação de áudio, …)
  integrations/supabase/ → Conexão com o Supabase e o "mapa de tipos" do banco
supabase/
  migrations/            → A história do banco (todas as tabelas e regras, em ordem)
  functions/             → As 13 Edge Functions (o backend) + código compartilhado (_shared)
```
