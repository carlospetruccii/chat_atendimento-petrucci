# 07 — Referência da integração uazapi

> Migração do motor de WhatsApp de **Z‑API** para **uazapi**. Contrato confirmado na
> documentação oficial (**docs.uazapi.com**, OpenAPI **uazapiGO v2.0.1**) e na fonte do
> SDK/CLI oficial. Este documento é a referência técnica do que o sistema usa hoje.

## Onde ficam as credenciais (secrets do Supabase)

Nenhum token vai para o frontend. As Edge Functions leem estes secrets:

| Secret | Para que serve | Quem fornece |
|--------|----------------|--------------|
| `UAZAPI_URL` | Servidor da instância, ex.: `https://SEU-SUBDOMINIO.uazapi.com` | **Você (conta uazapi)** |
| `UAZAPI_TOKEN` | Token da instância (header `token`) — envio, status, QR, webhook | **Você (conta uazapi)** |
| `UAZAPI_ADMIN_TOKEN` | (Opcional) `admintoken` — só se for criar instância pelo sistema | Você (opcional) |
| `UAZAPI_WEBHOOK_SECRET` | Segredo na URL do webhook p/ validar origem | Gerado pelo sistema |

## Base e autenticação
- Base URL: `https://{subdominio}.uazapi.com` (cada conta tem o seu).
- Header `token: <instância>` nas operações normais; `admintoken` nas administrativas.
- **Número:** apenas dígitos, sem `+`, espaços ou traços (ex.: `5511999998888`).

## Envio (o sistema → WhatsApp)
| Ação | Endpoint | Corpo (principais) |
|------|----------|--------------------|
| Texto | `POST /send/text` | `{ number, text, replyid? }` |
| Mídia | `POST /send/media` | `{ number, type, file (URL ou base64), text? (legenda), docName? }` |
| Menu/lista (triagem) | `POST /send/menu` | `{ number, type:"list", text, listButton, choices:["[Seção]","texto\|id\|desc"], footerText? }` |
| Apagar | `POST /message/delete` | `{ id }` (id = `owner:messageid`) |
| Baixar mídia recebida | `POST /message/download` | `{ id, return_base64? }` |

`type` de mídia: `image · video · document · audio · ptt · ptv · sticker · myaudio`.
**Nota de voz do atendente = `ptt`.** A resposta de `/send/*` é um objeto `Message`
(tem `id`/`messageid`) — guardamos o `id` em `mensagens.zapi_message_id` (coluna com
nome antigo, mantida por ser cosmética).

## Recebimento (WhatsApp → o sistema, via webhook)
- Configuração: `POST /webhook { url, events:["messages","messages_update","connection"], excludeMessages:["wasSentByApi"] }`.
  O `excludeMessages:["wasSentByApi"]` evita loop (não recebemos de volta o que a própria API enviou).
- A uazapi chama nossa função `webhook-zapi-receive` com envelope:
  ```
  { event: string, instance: string, data: {...} }
  ```
- Para eventos de mensagem, `data` é um objeto **Message** com, entre outros:
  `id` (owner:messageid), `messageid`, `chatid` (`<num>@s.whatsapp.net` | `@g.us` | `@lid`),
  `sender`, `sender_pn`, `senderName`, `isGroup`, `fromMe`, `wasSentByApi`,
  `messageType`, `text`, `fileURL`, `buttonOrListid` (opção escolhida na lista),
  `messageTimestamp`, `quoted`.
- Eventos tratados: `messages` (nova), `messages_update` (status entregue/lido/falha),
  `connection` (estado). Mensagem enviada pelo celular por fora = `fromMe:true` +
  `wasSentByApi:false` → registrada como `externo`. Grupos são ignorados.

## Conexão / QR code (aba "Conexão do WhatsApp" em Configurações)
| Ação | Endpoint | Retorno |
|------|----------|---------|
| Conectar / QR | `POST /instance/connect` (sem `phone`) | `{ instance:{ qrcode (base64 PNG) }, connected, loggedIn }` |
| Pareamento por código | `POST /instance/connect { phone }` | `{ instance:{ paircode } }` |
| Status | `GET /instance/status` | `{ status:{ connected, loggedIn, jid }, instance:{...} }` |
| Desconectar | `POST /instance/disconnect` | — |

Fluxo da tela: `connect` → mostra QR → usuário escaneia → `status` (polling) até
`connected && loggedIn`. Ao conectar, o backend também (re)configura o webhook.

## Segurança do webhook
A URL pública configurada na uazapi inclui `?secret=UAZAPI_WEBHOOK_SECRET`; a função
valida esse segredo (não há header `Client-Token` como na Z‑API).

## Pontos a confirmar na primeira mensagem real
A doc oficial é levemente inconsistente em dois nomes; o código trata os dois casos de
forma **defensiva** e **loga o envelope cru** (sem dados sensíveis) nas primeiras
mensagens para confirmarmos contra a instância real:
- valor exato de `event` (`"messages"` vs `"message"`, `"messages_update"` vs `"status"`);
- strings de `messageType` (mapeadas por substring) e de status (entregue/lido/falha).

## O que NÃO foi ligado ainda
O robô (`bot_ativo`) e os agendamentos (pg_cron) **continuam desligados** de propósito —
serão ligados só depois de confirmar que o número conecta e mensagens entram e saem.
