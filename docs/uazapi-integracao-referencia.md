# Integração WhatsApp via uazapi — Documento de Referência

> Guia completo e autossuficiente para replicar, do zero, a integração de WhatsApp
> com a **uazapi** (uazapiGO), migrando um sistema que hoje usa a **z-api**.
> Tudo baseado no código REAL deste repositório (Supabase Edge Functions em Deno +
> frontend React). Onde algo **não existe** aqui, está escrito explicitamente
> "**não temos isso**" em vez de inventar.

> ⚠️ Detalhe cosmético que confunde: nomes legados de z-api foram **mantidos de
> propósito** para reduzir o diff da migração. A coluna `mensagens.zapi_message_id`,
> a classe `ZapiError`, o mapa `MAPA_TIPO_ZAPI`, a pasta `webhook-zapi-receive` e as
> funções `send-whatsapp-*` **já falam com a uazapi**. O nome "zapi" ficou só no
> rótulo. Não se deixe enganar pelos nomes.

---

## 1. Fundamentos da uazapi

### URL base — SaaS ou self-hosted?
A uazapi é um **host por subdomínio** (modelo tipo self-hosted/SaaS por tenant): cada
conta tem sua própria base, no formato `https://SEU-SUBDOMINIO.uazapi.com`. Não há um
host único global — a URL da sua instância é uma variável de ambiente.

Fonte: [`_shared/uazapi-client.ts:2`](supabase/functions/_shared/uazapi-client.ts:2), `getBaseUrl()` em [`_shared/uazapi-client.ts:30`](supabase/functions/_shared/uazapi-client.ts:30):

```ts
function getBaseUrl(): string {
  const url = Deno.env.get("UAZAPI_URL");     // ex: https://xxx.uazapi.com
  if (!url) throw new Error("Secret UAZAPI_URL ausente.");
  return url.replace(/\/+$/, "");             // remove barra final
}
```

### Modelo de autenticação — quais tokens, quais headers
Dois tokens, dois headers. **Não é apikey em query string** (diferente da z-api):

| Token | Header HTTP | Usado em | Secret |
|---|---|---|---|
| Token **da instância** | `token: <valor>` | tudo que opera a instância: enviar, baixar mídia, conectar, status, webhook, chat/details | `UAZAPI_TOKEN` |
| Token **admin/servidor** | `admintoken: <valor>` | operações administrativas (provisionar instâncias etc.) | `UAZAPI_ADMIN_TOKEN` |

Toda chamada passa por `chamar()` em [`_shared/uazapi-client.ts:68`](supabase/functions/_shared/uazapi-client.ts:68):

```ts
const headers: Record<string, string> = {
  "Content-Type": "application/json",
  Accept: "application/json",
};
if (opts?.admin) headers.admintoken = getAdminToken();
else headers.token = getToken();
```

> Neste projeto, **99% das chamadas usam `token` (instância)**. O `admintoken` está
> cabeado no cliente mas nenhuma chamada de runtime o usa (provisionamento é manual —
> ver seção 2).

### Onde as credenciais ficam guardadas
Como **Supabase Edge Secrets** (`Deno.env.get(...)`), nunca no banco e nunca no frontend.
Secrets usados:

| Secret | Papel |
|---|---|
| `UAZAPI_URL` | base da instância (`https://xxx.uazapi.com`) |
| `UAZAPI_TOKEN` | token da instância — auth de todas as chamadas de runtime |
| `UAZAPI_ADMIN_TOKEN` | token admin (não usado em runtime aqui) |
| `UAZAPI_WEBHOOK_SECRET` | segredo colocado na query do webhook (validação secundária) |

> **Segurança:** o token nunca sai do backend. A tela de conexão do frontend chama a
> Edge Function `whatsapp-connection`, que lê o secret internamente e devolve à tela
> apenas status + QR (base64). Ver [`whatsapp-connection/index.ts:4`](supabase/functions/whatsapp-connection/index.ts:4).

### Uma instância por deployment (não multi-tenant no runtime)
Este projeto roda com **UMA instância global** (um `UAZAPI_TOKEN`). Existe no schema uma
tabela `companies` com colunas legadas `zapi_instance_id`, `zapi_token`, `zapi_client_token`
([`migrations/20260630193000_multitenant_base.sql:35`](supabase/migrations/20260630193000_multitenant_base.sql)),
mas **elas não estão cabeadas** — o runtime lê o token do env, não dessas colunas. Se você
precisar de uma instância por empresa, é aí que teria de plugar (ver seção 2).

---

## 2. Gestão de instâncias

> ⚠️ **Provisionamento (criar instância nova) NÃO existe neste projeto.** A instância é
> criada manualmente no painel da uazapi e o token colado no secret `UAZAPI_TOKEN`. Não
> chamamos nenhum endpoint de criação (`/instance/init` / `/instance/create`) nem de
> **deletar** instância. Se precisar disso, é um endpoint admin (header `admintoken`) que
> **não temos implementado aqui**.

O que o projeto faz: **conectar / status / desconectar** de uma instância existente.

### Conectar (gerar QR ou pairing code)
`POST /instance/connect` — header `token`. Corpo:
- **sem `phone`** → devolve **QR code em base64 PNG** (para escanear)
- **com `phone`** (dígitos) → devolve **pairing code** (código de pareamento)

[`_shared/uazapi-client.ts:285`](supabase/functions/_shared/uazapi-client.ts:285):

```ts
export async function conectarInstancia(phone?: string): Promise<ConnectResult> {
  const payload = phone ? { phone: soDigitos(phone) } : {};
  const resp = await chamar("POST", "/instance/connect", payload);
  const instance = (resp.instance ?? {});
  return {
    connected: Boolean(resp.connected),
    loggedIn:  Boolean(resp.loggedIn),
    qrcode:   (instance.qrcode  ?? resp.qrcode),    // base64 PNG
    paircode: (instance.paircode ?? resp.paircode),
    raw: resp,
  };
}
```

Resposta (formato real esperado):
```jsonc
{
  "connected": false,
  "loggedIn": false,
  "instance": {
    "qrcode": "iVBORw0KGgoAAAANSU...",   // PNG base64 (SEM prefixo data:)
    "paircode": "ABCD-1234"               // só quando phone é informado
  }
}
```

**QR no frontend** — o base64 vira `<img src>` com prefixo adicionado se faltar
([`ConexaoWhatsAppTab.tsx:94`](src/components/ConexaoWhatsAppTab.tsx:94)):
```ts
const qrSrc = qr ? (qr.startsWith("data:") ? qr : `data:image/png;base64,${qr}`) : null;
```

**Expiração/refresh:** o QR expira em segundos (regra do WhatsApp). O frontend faz
**polling de status** e regenera sob demanda: `refetchInterval` de **4s enquanto
desconectado**, 15s quando conectado ([`ConexaoWhatsAppTab.tsx:44`](src/components/ConexaoWhatsAppTab.tsx:44)).
Não há push — é polling. O botão "Gerar novo QR code" chama `connect` de novo.

### Consultar status
`GET /instance/status` — header `token`. [`_shared/uazapi-client.ts:307`](supabase/functions/_shared/uazapi-client.ts:307):

```ts
const resp = await chamar("GET", "/instance/status");
const st   = resp.status   ?? {};
const inst = resp.instance ?? {};
const jid  = st.jid ?? {};
return {
  connected:   Boolean(st.connected),
  loggedIn:    Boolean(st.loggedIn),
  status:      inst.status ?? st.status,   // "connected" | "connecting" | "disconnected"
  profileName: inst.profileName,
  numero:      jid.user,                   // número conectado, quando logado
};
```

Resposta (formato real esperado):
```jsonc
{
  "status":   { "connected": true, "loggedIn": true, "jid": { "user": "5511999998888" } },
  "instance": { "status": "connected", "profileName": "Nome do Perfil" }
}
```

### Desconectar
`POST /instance/disconnect` — header `token`, sem corpo. [`_shared/uazapi-client.ts:322`](supabase/functions/_shared/uazapi-client.ts:322).

### Deletar instância
**Não temos isso.**

### Onde o projeto mapeia instância → cliente
**Não há mapeamento por instância** — é instância única. O que existe é o inverso: o
**webhook identifica que o evento veio da NOSSA instância** comparando o campo `token` do
corpo do webhook com o secret `UAZAPI_TOKEN` (seção 3). Os clientes finais (contatos) são
resolvidos pelo número/JID dentro do payload, não pela instância.

---

## 3. Webhooks (recebimento)

### Registro do webhook — endpoint único com lista de eventos
Um **único endpoint** recebe **todos** os eventos; você declara quais eventos quer numa
lista. `POST /webhook` — header `token`. [`_shared/uazapi-client.ts:339`](supabase/functions/_shared/uazapi-client.ts:339):

```ts
const payload = {
  url: params.url,
  events: params.events ?? ["messages", "messages_update", "connection"],
  excludeMessages: params.excludeMessages ?? [],
  enabled: params.enabled ?? true,
};
return await chamar("POST", "/webhook", payload);
```

- `events`: nomes usados aqui → **`messages`** (mensagem nova), **`messages_update`**
  (status de entrega/leitura) e **`connection`** (conexão).
- `excludeMessages: []` (vazio, de propósito): a mesma instância é usada por **outro
  sistema**, e excluir `wasSentByApi` apagava do nosso chat as mensagens que ele envia.
  O eco do nosso próprio envio é tratado no receiver (dedup + adoção da linha pendente);
  o caminho `fromMe` só grava, nunca responde, então não há loop.
- Ler config viva: `GET /webhook` ([`_shared/uazapi-client.ts:349`](supabase/functions/_shared/uazapi-client.ts:349)).

O webhook é (re)configurado de forma **idempotente ao conectar** — a função
`whatsapp-connection`, no `action:"connect"`, dispara `garantirWebhook()` em background,
apontando para a Edge Function pública, com o secret na query
([`whatsapp-connection/index.ts:48`](supabase/functions/whatsapp-connection/index.ts:48)):

```ts
const url = `${SUPABASE_URL}/functions/v1/webhook-zapi-receive?secret=<UAZAPI_WEBHOOK_SECRET>`;
```

### Como validam que veio da uazapi
Existem **duas camadas**, e a que **de fato vale** não é a query string:

1. **Query `?secret=`** — colocada na URL do webhook. É defesa fraca.
2. **Token no corpo (a real)** — a uazapi inclui o **token da instância** no campo
   `token` do envelope. O receiver compara com `UAZAPI_TOKEN` e **rejeita 401** se não
   bater. Isso também identifica **qual instância** disparou.
   [`webhook-zapi-receive/index.ts:513`](supabase/functions/webhook-zapi-receive/index.ts:513):

```ts
const expectedToken = Deno.env.get("UAZAPI_TOKEN");
const bodyToken = typeof envelope.token === "string" ? envelope.token : null;
if (expectedToken && bodyToken !== expectedToken) {
  return jsonResponse({ ok: false, erro: "unauthorized" }, 401);
}
```

### Formato REAL do envelope (confirmado em produção)
[`webhook-zapi-receive/index.ts:523`](supabase/functions/webhook-zapi-receive/index.ts:523):

```jsonc
{
  "EventType": "messages",          // tipo do evento (também aceita "event")
  "message": { /* objeto Message — ver abaixo */ },
  "chat": { /* dados do chat/contato */ },
  "owner": "5511999998888",         // número da instância (dono)
  "token": "<token-da-instancia>",  // usado na validação
  "instanceName": "minha-instancia"
}
```

- Tipo do evento: `EventType` (fallback `event`).
- A **mensagem** vem em `message` (fallback `data`, senão o próprio envelope).
- Roteamento defensivo: se `EventType` não vier, o receiver deduz pelo formato do payload
  (tem `messageType`/`text`/`chatid`/`fromMe` → mensagem; só `id`+`status` → status).
  Ver [`webhook-zapi-receive/index.ts:549`](supabase/functions/webhook-zapi-receive/index.ts:549).

### Payload REAL de mensagem recebida (objeto `message`)
Campos que o projeto lê (todos opcionais/defensivos — os valores exatos da uazapi são
tratados por substring porque variam):

| Campo | Significado |
|---|---|
| `id` | ID da mensagem no formato **`owner:messageid`** (é o que gravamos em `zapi_message_id`) |
| `messageType` | tipo cru: `Conversation`/`text`/`extendedText`/`image`/`video`/`audio`/`ptt`/`document`/`sticker`/`location`/`contact`… |
| `text` | texto (ou legenda de mídia) |
| `content` | **objeto rico** com metadados de mídia: `mimetype`, `fileName`, `seconds`, `latitude`/`longitude`, `displayName`, `vcard`… |
| `fileURL` | URL do arquivo — normalmente **`.enc` (criptografada)**, precisa baixar (ver abaixo) |
| `chatid` | JID do chat: `<num>@s.whatsapp.net`, `@c.us`, `@lid` ou `@g.us` (grupo) |
| `sender_pn` | telefone do remetente (phone number) |
| `sender_lid` | LID do remetente (identificador anônimo do WhatsApp) |
| `senderName` | pushname do remetente |
| `fromMe` | `true` = mensagem saiu do nosso número (eco / envio pelo celular) |
| `wasSentByApi` | `true` = saiu pela API (nosso envio **ou** o do outro sistema na mesma instância) |
| `isGroup` | `true` = mensagem de grupo |
| `quoted` | `id` (owner:messageid) da mensagem citada/respondida |
| `buttonOrListid` | id da opção escolhida numa lista/botão interativo |
| `status` / `messageStatus` | usado nos eventos de status |

Exemplo de **texto** recebido:
```jsonc
{
  "EventType": "messages",
  "token": "<token>",
  "message": {
    "id": "5511999998888:3EB0XXXX",
    "messageType": "Conversation",
    "text": "Olá, quero informações",
    "chatid": "5511988887777@s.whatsapp.net",
    "sender_pn": "5511988887777",
    "sender_lid": "123456789012345",
    "senderName": "Fulano",
    "fromMe": false
  }
}
```

Como cada tipo é extraído — `parseMensagem()` em
[`webhook-zapi-receive/index.ts:77`](supabase/functions/webhook-zapi-receive/index.ts:77):

- **texto**: `text` (ou `content` string). `messageType` ~ `conversation`/`text`/`extendedText`.
- **imagem / vídeo**: `messageType` contém `image`/`video`; legenda em `text`; mime em `content.mimetype`; bytes via download.
- **áudio / PTT**: `messageType` contém `audio`/`ptt`; duração em `content.seconds`; sem texto.
- **documento**: `content.fileName` (ou `content.title`); mime em `content.mimetype`.
- **sticker**: `messageType` contém `sticker`.
- **localização**: `content.latitude`/`content.longitude` (ou `degreesLatitude`/`degreesLongitude`), `content.address`.
- **contato (vcard)**: `content.displayName` + `content.vcard` (ou `vCard`).
- **resposta de lista/botão**: campo `buttonOrListid` → tratado como **texto** (usa o
  título selecionado) e o id vai pra `media_metadata.selected_id`
  ([`webhook-zapi-receive/index.ts:96`](supabase/functions/webhook-zapi-receive/index.ts:96)).

### Mídia recebida — como baixar (o pulo do gato)
A `fileURL` que chega no webhook aponta para o arquivo **criptografado `.enc`** do
WhatsApp — **não dá pra usar direto**. O projeto:

1. Persiste a mensagem na hora com um placeholder `media_url = "pending:uazapi"` (a coluna
   tem CHECK que proíbe nulo) — [`webhook-zapi-receive/index.ts:123`](supabase/functions/webhook-zapi-receive/index.ts:123).
2. Em **background** (`EdgeRuntime.waitUntil`) baixa os bytes e sobe pro Supabase Storage,
   depois troca `media_url` pelo caminho do bucket.

O download tem 3 fontes, nesta ordem — `obterBytesMidia()` em
[`webhook-zapi-receive/index.ts:1518`](supabase/functions/webhook-zapi-receive/index.ts:1518):

1. **`POST /message/download` com `return_base64: true`** (fonte confiável, bytes decodificados):
   ```ts
   // _shared/uazapi-client.ts:256
   const resp = await chamar("POST", "/message/download", { id, return_base64: true });
   // resposta: { base64Data | base64 | fileBase64 | data, mimetype, fileName, fileURL }
   ```
2. `fileURL` da resposta do download, se for `http(s)` (já decodificada pela uazapi).
3. Último recurso: a `fileURL` original do webhook, **só se for http** (a `.enc` é ignorada).

> A resposta do `/message/download` tem nomes de campo variáveis; o cliente tenta
> `base64Data ?? base64 ?? fileBase64 ?? data` e `mimetype ?? mimeType`
> ([`_shared/uazapi-client.ts:261`](supabase/functions/_shared/uazapi-client.ts:261)).

### Payload de status de mensagem
Evento `messages_update` (ou payload só com `id` + `status`). O receiver lê
`status`/`messageStatus` e mapeia por **substring** (os textos exatos são incertos) —
[`webhook-zapi-receive/index.ts:42`](supabase/functions/webhook-zapi-receive/index.ts:42):

```ts
function mapStatusWhatsapp(s) {
  const u = String(s).toUpperCase();
  if (u.includes("DELIVER"))               return "entregue";
  if (u.includes("READ") || u.includes("PLAYED")) return "lido";
  if (u.includes("SENT"))                  return "enviado";
  if (u.includes("FAIL") || u.includes("ERROR")) return "falha_whatsapp";
  return null;
}
```
Casa o `id` (owner:messageid) com `mensagens.zapi_message_id` e atualiza `status_whatsapp`.
Status de mensagem que não achamos no banco vira "status órfão" (logado, ignorado).

### Payload de conexão
Evento `connection` → o receiver **apenas loga**, sem ação no banco
([`webhook-zapi-receive/index.ts:535`](supabase/functions/webhook-zapi-receive/index.ts:535)). O estado de conexão vivo
é lido sob demanda via `GET /instance/status` (seção 2).

---

## 4. Envio de mensagens

Todos os envios: **`POST`**, header `token`, `Content-Type: application/json`,
número em **dígitos puros** (`soDigitos` remove `+`, espaços, traços).

### Texto
`POST /send/text` — [`_shared/uazapi-client.ts:136`](supabase/functions/_shared/uazapi-client.ts:136):
```jsonc
// payload
{ "number": "5511988887777", "text": "Olá!", "replyid": "5511...:3EB0..." }  // replyid opcional
```

### Mídia (imagem / vídeo / áudio-PTT / documento / sticker)
`POST /send/media` — [`_shared/uazapi-client.ts:168`](supabase/functions/_shared/uazapi-client.ts:168):
```jsonc
{
  "number": "5511988887777",
  "type": "image",                 // ver enum abaixo
  "file": "https://.../signed-url", // URL pública (preferida) OU base64
  "text": "legenda opcional",       // caption
  "docName": "contrato.pdf",        // só para type=document
  "replyid": "..."                  // opcional
}
```
Enum de `type` da uazapi (comentado em [`_shared/uazapi-client.ts:10`](supabase/functions/_shared/uazapi-client.ts:10)):
`image | video | document | audio | ptt | ptv | sticker | myaudio`.

**Mapeamento interno do projeto** ([`_shared/uazapi-client.ts:148`](supabase/functions/_shared/uazapi-client.ts:148)):
```ts
const MAPA_TIPO_UAZAPI = { image: "image", audio: "ptt", video: "video", document: "document" };
```
> ⚠️ **Nota de voz = `ptt`** (não `audio`). Áudio gravado no navegador é WebM/Opus; a
> uazapi só transcodifica pra OGG/Opus (que o WhatsApp do celular exige) se o arquivo
> chegar **rotulado com o formato de origem correto**. Rotular WebM como `.ogg` fazia a
> uazapi repassar os bytes crus → tocava no WhatsApp Web mas dava "formato não suportado"
> no celular. Ver [`send-whatsapp-audio/index.ts:49`](supabase/functions/send-whatsapp-audio/index.ts:49).

### Lista / menu interativo
`POST /send/menu` — [`_shared/uazapi-client.ts:206`](supabase/functions/_shared/uazapi-client.ts:206):
```jsonc
{
  "number": "5511988887777",
  "type": "list",
  "text": "Escolha o setor:",
  "listButton": "Ver setores",
  "footerText": "Atendimento",
  "choices": ["Vendas|vendas_id|Fala com comercial", "Suporte|suporte_id"]
}
```
Formato de `choices`: `"texto|id|descrição"`. Quando o cliente escolhe, o webhook devolve
`buttonOrListid` = o `id` da opção.

### Reply / citação
Em **todos** os envios, o campo é **`replyid`** = o `id` (owner:messageid) da mensagem
citada. Ver `EnviarTextoParams.quotedZapiMessageId` → `payload.replyid`
([`_shared/uazapi-client.ts:141`](supabase/functions/_shared/uazapi-client.ts:141)).

### Localização / contato (ENVIO)
**Não temos isso.** O projeto **recebe** localização e contato (seção 3), mas **não envia**
nenhum dos dois. Se precisar, seriam endpoints uazapi tipo `/send/location` e
`/send/contact` — **não implementados aqui**.

### Resposta do envio e o `id`
A resposta de `/send/*` é um **objeto Message com `id` no topo** (formato `owner:messageid`).
Extração — [`_shared/uazapi-client.ts:236`](supabase/functions/_shared/uazapi-client.ts:236):
```ts
export function extrairMessageId(resposta) {
  return resposta?.id ?? resposta?.messageid ?? null;
}
```
Resposta típica:
```jsonc
{ "id": "5511999998888:3EB0FF...", "messageType": "text", "fromMe": true, /* ... */ }
```

### Relação entre o id do envio e o id do webhook
**São o MESMO id.** O que você guarda de `extrairMessageId(resposta)` é idêntico ao `id`
que volta no webhook quando a mensagem ecoa como `fromMe:true`. **Não há id temporário.**
É exatamente isso que garante a idempotência: o UNIQUE em `zapi_message_id` faz a mensagem
que nós enviamos (e gravamos) não ser duplicada quando o eco chega. Fluxo real em
[`send-whatsapp-message/index.ts:337`](supabase/functions/send-whatsapp-message/index.ts:337) (grava o id) e
[`webhook-zapi-receive/index.ts:714`](supabase/functions/webhook-zapi-receive/index.ts:714) (dedup do eco).

### Marcar como lido ("tique azul") — IMPLEMENTADO
`POST /chat/read` `{ number: <dígitos>, read: true }` marca o chat inteiro como lido e
dispara a confirmação de leitura pro remetente (o "tique azul"), **desde que a conta
conectada esteja com "confirmações de leitura" ligado** nas configs do WhatsApp.
Cliente: `marcarChatComoLido()` em [`_shared/uazapi-client.ts`](supabase/functions/_shared/uazapi-client.ts).
Edge Function: [`mark-chat-read`](supabase/functions/mark-chat-read/index.ts) — o front
chama ao abrir uma conversa **que o próprio atendente está atendendo** (gate estrito:
`assigned_to === auth.uid()` E `status='em_atendimento'`; admin espiando/pré-visualização
não disparam). Alternativa por mensagem: `POST /message/markread` `{ id: [<ids>] }`.

### Presença/"digitando", reagir
**Não temos isso.** Os endpoints existem na uazapi (`/message/presence`, `/message/react`)
mas **este projeto não os usa** — não vou chutar payloads.

### Rota de código do envio outbound
1. Frontend faz **INSERT otimista** da mensagem (`status_envio='aguardando_envio'`).
2. Chama a Edge Function (`send-whatsapp-message` p/ texto; `-media` p/ imagem/vídeo/doc;
   `-audio` p/ PTT). Auth via **JWT do atendente** (header `Authorization: Bearer`).
3. A função valida permissão, marca `enviando`, **responde 200 na hora** e chama a uazapi
   em **background** (`EdgeRuntime.waitUntil`). Sucesso → `enviado` + `zapi_message_id`;
   falha → `falha` + `media_metadata.erro_motivo`.
4. `cron-retry-mensagens-falha` reprocessa as em `falha`.

---

## 5. Contatos e perfil

### Foto de perfil
**Não temos isso.** Não há chamada a nenhum endpoint de foto de perfil. O frontend usa
**avatar por iniciais** do nome (`src/lib/inbox-queries.ts:486`). Sem cache/TTL de foto
porque não há foto. Se precisar, a uazapi tem algo como `/chat/GetProfilePicture` — **não
implementado aqui**.

### Resolver nome do contato
Três fontes, em ordem de preferência:
1. **Inbound**: campo `senderName` do próprio webhook.
2. **fromMe** (você iniciou pelo celular): o webhook não traz o nome do destinatário, então
   busca sob demanda em **`POST /chat/details`** — [`_shared/uazapi-client.ts:361`](supabase/functions/_shared/uazapi-client.ts:361):
   ```ts
   const r = await chamar("POST", "/chat/details", { number: soDigitos(numero) });
   // candidatos: r.name, r.wa_name, r.wa_contactName, r.lead_fullName, r.lead_name
   ```
   Ignora valores puramente numéricos (que seriam o próprio telefone).
3. Objeto `chat` do envelope em fromMe: `wa_contactName`, `wa_name`, `name`, `pushName`,
   `verifiedName`… ([`webhook-zapi-receive/index.ts:734`](supabase/functions/webhook-zapi-receive/index.ts:734)).

### @lid — sim, a uazapi tem
A uazapi usa **LID** (identificador anônimo do WhatsApp), igual ao conceito da z-api. O
`chatid` pode terminar em:
- `@s.whatsapp.net` ou `@c.us` → contato normal (tem telefone)
- `@lid` → contato só com LID (sem telefone visível)
- `@g.us` → **grupo** (descartado, ver abaixo)

Campos-chave: **`sender_pn`** (telefone) e **`sender_lid`** (LID). A heurística de decisão
está em `ehLid()` — [`webhook-zapi-receive/index.ts:210`](supabase/functions/webhook-zapi-receive/index.ts:210):
```ts
// @lid → LID; @g.us → grupo; sem sender_pn mas com sender_lid → LID; senão E.164.
```

**Telefone vs jid vs lid** no banco (tabela `clients`):
- `numero_whatsapp`: E.164 com `+`, com CHECK `^\+[1-9][0-9]{7,14}$` — chave primária de
  contato ([`migrations/...multitenant_base.sql`](supabase/migrations/20260630193000_multitenant_base.sql)).
- `chat_lid`: guarda o LID (UNIQUE parcial por empresa). Quando um contato E.164 conhecido
  aparece com LID, o LID é **populado** no registro existente
  ([`webhook-zapi-receive/index.ts:285`](supabase/functions/webhook-zapi-receive/index.ts:285)).
- Inbound **só com LID e sem cliente prévio** → ignorado, porque não dá pra criar cliente
  sem E.164 (o CHECK proíbe). Fica visível quando o contato mandar algo com telefone.

### Grupos
**Descartados explicitamente.** `chatid` terminando em `@g.us` (ou `isGroup:true`) é
ignorado — criaria cliente violando o CHECK E.164. Ver `ehGrupo()` em
[`webhook-zapi-receive/index.ts:232`](supabase/functions/webhook-zapi-receive/index.ts:232).

---

## 6. Mapeamento z-api → uazapi

> O cliente z-api antigo **não existe mais neste repo** (foi substituído). A coluna
> `zapi_message_id` e a classe `ZapiError` são cosméticas. A tabela abaixo usa a convenção
> típica da z-api (baseada no que os nomes legados indicam) contra o que **de fato** este
> projeto faz na uazapi.

| Conceito | z-api (convenção típica) | **uazapi (real neste projeto)** | Diferença que pega |
|---|---|---|---|
| **Auth** | `Client-Token` header + instance id + token na **URL** (`/instances/{id}/token/{tok}/...`) | header **`token`** (instância) / **`admintoken`** (admin); base = subdomínio | uazapi tira credencial da URL e põe **no header**; número no corpo |
| **Enviar texto** | `POST .../send-text` `{ phone, message }` | `POST /send/text` `{ number, text, replyid? }` | `phone`→`number`, `message`→`text` |
| **Enviar mídia** | endpoints separados: `/send-image`, `/send-document`, `/send-audio`… `{ phone, image/document (url\|base64) }` | **um só** `POST /send/media` `{ number, type, file, text?, docName? }` | uazapi unifica em `/send/media` com `type`; `file` aceita URL ou base64 |
| **Nota de voz** | `/send-audio` | `/send/media` com **`type:"ptt"`** | precisa `ptt` (não `audio`) e rótulo de formato correto p/ transcodar |
| **Lista/botões** | `/send-option-list` / `/send-button-list` | `POST /send/menu` `{ type:"list", listButton, choices:["txt\|id\|desc"] }` | formato `choices` em string com `\|` |
| **Reply/citação** | `messageId` no corpo | campo **`replyid`** | nome do campo |
| **QR / conectar** | `GET .../qr-code` (imagem) / `GET .../qr-code/image` | `POST /instance/connect` (sem `phone`→QR base64; com `phone`→paircode) | uazapi é **POST**, devolve base64 PNG no `instance.qrcode` |
| **Status instância** | `GET .../status` `{ connected, ... }` | `GET /instance/status` `{ status:{connected,loggedIn,jid}, instance:{status,profileName} }` | estrutura aninhada em `status`/`instance` |
| **Desconectar** | `GET/POST .../disconnect` | `POST /instance/disconnect` | — |
| **Registrar webhook** | endpoints por evento: `/update-webhook-received`, `/update-webhook-delivery`, `/update-webhook-message-status`… | **um** `POST /webhook` `{ url, events:[...], excludeMessages, enabled }` | uazapi: **1 endpoint + lista de eventos** em vez de 1 por tipo |
| **Baixar mídia** | URL já vem utilizável no webhook | `.enc` criptografada → **`POST /message/download` `{ id, return_base64:true }`** | uazapi **exige download** por endpoint |
| **Foto de perfil** | `GET .../profile-picture?phone=` | **não temos isso** | — |
| **Nome do contato** | vem no webhook / `/contacts` | `senderName` no webhook + `POST /chat/details` `{ number }` | — |
| **Deletar mensagem** | `/messages/{id}` DELETE | `POST /message/delete` `{ id }` (id = `owner:messageid`) | id composto |
| **Webhook: identificar instância** | instance id na URL / no corpo | campo **`token`** no corpo (comparado ao secret) | — |
| **Webhook: msg recebida** | `{ phone, text.message, messageId, fromMe, ... }` (achatado) | `{ EventType, token, chat, message:{ id, messageType, text, content, chatid, sender_pn, sender_lid, fromMe, ... } }` | uazapi **aninha** em `message`; JID em `chatid`; tipos por substring |
| **id da mensagem** | `messageId` (string) | `id` = **`owner:messageid`** | formato composto |
| **Anti-eco** | filtrar `fromMe` | eco recebido de propósito; dedup por `zapi_message_id` + adoção (`webhook-zapi-receive/eco.ts`) | uazapi ecoa o próprio envio como `fromMe:true` |

---

## 7. Armadilhas de produção

### Rate limit / timeouts / retries
- **429** da uazapi = limite da instância. O cliente faz **backoff crescente 1s → 3s → 9s**,
  **3 tentativas** ([`_shared/uazapi-client.ts:103`](supabase/functions/_shared/uazapi-client.ts:103)):
  ```ts
  if (resp.status === 429 && tentativa < MAX_TENTATIVAS) {
    const esperaMs = Math.pow(3, tentativa - 1) * 1000; // 1s, 3s, 9s
    await new Promise(r => setTimeout(r, esperaMs));
    continue;
  }
  ```
- Só o **429** faz retry automático; outros erros HTTP sobem como `UazapiError` na hora.
- Envio outbound roda em **background** (`EdgeRuntime.waitUntil`) — o frontend recebe 200
  imediato e o resultado real (enviado/falha) vem via realtime na linha da mensagem.
- Mensagens em `falha` são reprocessadas pelo **`cron-retry-mensagens-falha`**.
- Limite de mídia: **16 MB** ([`send-whatsapp-media/index.ts:18`](supabase/functions/send-whatsapp-media/index.ts:18)).

### Formato de número / JID
- **Envio**: dígitos puros, sem `+` (`soDigitos`): `5511988887777`.
- **Armazenamento** (`clients.numero_whatsapp`): E.164 **com `+`**, CHECK
  `^\+[1-9][0-9]{7,14}$`. O receiver normaliza qualquer `chatid`/`sender_pn` extraindo
  dígitos e prefixando `+` ([`webhook-zapi-receive/index.ts:190`](supabase/functions/webhook-zapi-receive/index.ts:190)).
- **JID no webhook**: `<num>@s.whatsapp.net` / `@c.us` / `@lid` / `@g.us` — sempre extrair
  só os dígitos antes de `@`.
- **9º dígito / DDI**: o Brasil (55) tem a variação do 9º dígito em celulares. Este projeto
  **não normaliza o 9º dígito** — confia no que o WhatsApp entrega no `sender_pn`. Fique
  atento se for casar número digitado por humano com o do webhook.

### Mídia `.enc`
A `fileURL` do webhook é **criptografada** — nunca dá `fetch` direto nela esperando bytes
úteis. Sempre `POST /message/download`. Enquanto o download roda em background, a mensagem
fica com `media_url = "pending:uazapi"` (placeholder não-http, ignorado pelas tentativas de
fetch direto).

### Idempotência / dedup
- **A uazapi reenvia webhooks** se você não responder **200** — por isso o receiver
  **sempre retorna 200** (até em payload inválido ou erro interno), exceto o 401 de token
  inválido ([`webhook-zapi-receive/index.ts:510`](supabase/functions/webhook-zapi-receive/index.ts:510)).
- **A uazapi ecoa as próprias mensagens** como `fromMe:true`. Envios feitos **pela API**
  vêm com `wasSentByApi:true` e **são processados** (é assim que enxergamos o que o outro
  sistema manda pela mesma instância). O eco do NOSSO envio é reconhecido em duas
  tentativas — dedup por `zapi_message_id` e, se a linha ainda estiver sem id, adoção pelo
  conteúdo ([`eco.ts`](supabase/functions/webhook-zapi-receive/eco.ts)). Não reconhecido →
  vira `sender_type='externo'` com `media_metadata.origem='api_externa'`. Mensagem digitada
  **no celular** vem `fromMe:true` **sem** `wasSentByApi` → `externo` com `origem='celular'`.
- **Dedup forte**: UNIQUE parcial `uniq_mensagens_zapi_message_id` em
  `mensagens(zapi_message_id)`. O receiver checa antes (SELECT) e trata `23505` como
  duplicada silenciosa. Isso cobre tanto reentrega de webhook quanto o eco do próprio envio.
- **Corrida de atendimento**: cliente mandando mensagens em rajada dispara várias invocações
  concorrentes do webhook. UNIQUE `uniq_atendimento_ativo_por_cliente` barra atendimentos
  ativos duplicados; no `23505` o código reaproveita o atendimento vencedor
  ([`webhook-zapi-receive/index.ts:1359`](supabase/functions/webhook-zapi-receive/index.ts:1359)).
- **`zapi_message_id` é imutável** após preenchido (trigger no banco) — evita sobrescrever
  o id real por engano.

### Outros gotchas já enfrentados
- **Áudio "formato não suportado" no celular**: rotular o áudio com o formato de origem
  real (WebM), senão a uazapi não transcoda pra OGG/Opus PTT (seção 4).
- **Status strings incertas**: os textos exatos de status/tipo da uazapi variam → todo o
  mapeamento é por **substring case-insensitive** (`mapStatusWhatsapp`, `mapMessageType`),
  nunca igualdade exata.
- **Nome em fromMe**: o webhook de mensagem enviada pelo celular **não traz** o nome do
  destinatário → busca sob demanda em `/chat/details`.

---

## Arquivos-chave deste projeto (por parte)

| Parte | Arquivo |
|---|---|
| **Cliente HTTP uazapi** (auth, retries, todos os endpoints, envio, download, instância, webhook, chat/details) | [`supabase/functions/_shared/uazapi-client.ts`](supabase/functions/_shared/uazapi-client.ts) |
| **Recebimento** (webhook público, parse de todos os tipos, dedup, LID/grupos, download de mídia, status, fromMe/externo) | [`supabase/functions/webhook-zapi-receive/index.ts`](supabase/functions/webhook-zapi-receive/index.ts) |
| **Conexão/QR/status/disconnect + setup de webhook** (backend) | [`supabase/functions/whatsapp-connection/index.ts`](supabase/functions/whatsapp-connection/index.ts) |
| **Tela de conexão** (QR base64, polling de status) — frontend | [`src/components/ConexaoWhatsAppTab.tsx`](src/components/ConexaoWhatsAppTab.tsx) |
| **Envio de texto** (+ mídia por URL já existente) | [`supabase/functions/send-whatsapp-message/index.ts`](supabase/functions/send-whatsapp-message/index.ts) |
| **Envio de imagem/vídeo/documento** (upload → signed URL → send/media) | [`supabase/functions/send-whatsapp-media/index.ts`](supabase/functions/send-whatsapp-media/index.ts) |
| **Envio de áudio PTT** (rótulo de formato correto) | [`supabase/functions/send-whatsapp-audio/index.ts`](supabase/functions/send-whatsapp-audio/index.ts) |
| **Retry de mensagens em falha** | [`supabase/functions/cron-retry-mensagens-falha/index.ts`](supabase/functions/cron-retry-mensagens-falha/index.ts) |
| **Schema — contato/LID** (numero_whatsapp E.164, chat_lid) | [`supabase/migrations/20260630193000_multitenant_base.sql`](supabase/migrations/20260630193000_multitenant_base.sql) |
| **Schema — dedup mensagem** (`uniq_mensagens_zapi_message_id`) e **atendimento ativo único** | `supabase/migrations/*zapi_message_id*.sql`, [`supabase/migrations/20260703130000_uniq_atendimento_ativo_por_cliente.sql`](supabase/migrations/20260703130000_uniq_atendimento_ativo_por_cliente.sql) |

### Secrets a configurar no projeto novo
```
UAZAPI_URL=https://SEU-SUBDOMINIO.uazapi.com
UAZAPI_TOKEN=<token-da-instancia>
UAZAPI_ADMIN_TOKEN=<token-admin>          # opcional (não usado em runtime aqui)
UAZAPI_WEBHOOK_SECRET=<segredo-query>     # validação secundária do webhook
```

### Endpoints uazapi realmente usados (lista fechada)
`POST /send/text` · `POST /send/media` · `POST /send/menu` · `POST /message/delete` ·
`POST /message/download` · `POST /instance/connect` · `GET /instance/status` ·
`POST /instance/disconnect` · `POST /webhook` · `GET /webhook` · `POST /chat/details`
</content>
</invoke>
