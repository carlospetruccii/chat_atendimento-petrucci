// Edge Function: webhook-zapi-receive
// Endpoint público chamado pela uazapi para entregar eventos de WhatsApp.
// (O nome da função/pasta e a coluna zapi_message_id são cosméticos e ficam.)
//
// Princípios:
//   - Sempre responde 200 quando o payload é parseável (evita reentrega em loop).
//   - Idempotente via UNIQUE em mensagens.zapi_message_id (guarda o `id` da uazapi).
//   - NÃO consulta bot_ativo: webhook só recebe; quem responde respeita kill switch.
//   - Mídias: persiste imediatamente e, em background, baixa via
//     POST /message/download (ou data.fileURL) e sobe ao Storage.
//
// Validação de origem: segredo na query string (?secret=...) vs UAZAPI_WEBHOOK_SECRET.

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";
import { buscarNomeContato } from "../_shared/uazapi-client.ts";
import { ehEnvioInterno } from "../_shared/envio-interno.ts";
import { fotoDoChat } from "../_shared/foto-perfil.ts";
import { atualizarFotoEmSegundoPlano } from "../_shared/foto-perfil-sync.ts";
import { baixarESalvarMidia } from "../_shared/midia-mensagem.ts";
import {
  dataDaMensagem,
  parseMensagem,
  TIPOS_COM_DOWNLOAD,
} from "../_shared/mensagem-uazapi.ts";
import { adotarEcoProprio, aguardarAssentarEco } from "./eco.ts";
import {
  type AtendimentoContinuidadeFields,
  type AtendimentoEncerradoAnterior,
  type Continuidade,
  devePularReabertura,
  type NovoAtendimentoFields,
  montarAtendimentoContinuidade,
  montarNovoAtendimento,
  resolverContinuidade,
  resolverModo,
} from "./logic.ts";
import { normalizarJidGrupo } from "./grupos-logic.ts";
import { registrarMensagemGrupo } from "./grupos.ts";

const FUNCAO = "webhook-zapi-receive";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type StatusWhatsapp = "enviado" | "entregue" | "lido" | "falha_whatsapp";

// Status string da uazapi → enum status_whatsapp_mensagem.
// Os textos exatos são incertos → mapeamento defensivo por SUBSTRING (uppercase).
function mapStatusWhatsapp(s: string | undefined | null): StatusWhatsapp | null {
  if (!s) return null;
  const u = String(s).toUpperCase();
  if (u.includes("DELIVER")) return "entregue";
  if (u.includes("READ") || u.includes("PLAYED")) return "lido";
  if (u.includes("SENT")) return "enviado";
  if (u.includes("FAIL") || u.includes("ERROR")) return "falha_whatsapp";
  return null;
}

const STATUS_INSTAVEL_ATENDIMENTO = ["em_triagem", "reservado", "pendente", "em_atendimento"];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// Compara dois segredos em tempo constante (não sai no primeiro byte diferente).
// O comprimento em si não é secreto, então a saída antecipada por tamanho é ok.
function comparaConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Normaliza número para E.164 com '+'. Aceita "<numero>@s.whatsapp.net",
// "@c.us", "@lid" ou dígitos puros — extrai só os dígitos e prefixa '+'.
function normalizarNumero(n: string | null | undefined): string | null {
  if (!n) return null;
  const digits = String(n).replace(/\D/g, "");
  if (!digits) return null;
  return `+${digits}`;
}

// Mascarar número para logs: mantém DDI+DDD e últimos 2 dígitos.
function mascararNumero(n: string | null | undefined): string | null {
  if (!n) return null;
  const d = String(n).replace(/\D/g, "");
  if (d.length < 6) return "***";
  return `${d.slice(0, 4)}***${d.slice(-2)}`;
}

// Detecta se o chatid da uazapi é LID (não E.164). Regra composta:
//  - sufixo @lid → LID
//  - sufixo @g.us → grupo (não LID, tratado pelo guard de grupo)
//  - se sender_lid existe e não há telefone (sender_pn) → LID
//  - caso contrário, assume E.164.
function ehLid(
  chatid: string | null | undefined,
  senderLid: string | null | undefined,
  senderPn: string | null | undefined,
): boolean {
  const s = chatid ? String(chatid) : "";
  if (s.includes("@lid")) return true;
  if (s.includes("@g.us")) return false;
  // Sem telefone resolvível e com LID disponível → caminho LID.
  const temPn = senderPn && String(senderPn).replace(/\D/g, "") !== "";
  const temLid = senderLid && String(senderLid).replace(/\D/g, "") !== "";
  if (!temPn && temLid) return true;
  return false;
}

function extrairLid(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).split("@")[0];
  const digits = s.replace(/\D/g, "");
  return digits || null;
}

// Só é grupo quando existe um JID de grupo utilizável (`...@g.us`), no payload ou
// no envelope. `isGroup` sozinho NÃO basta: um payload com `isGroup: true` e
// `chatid` individual entraria no desvio de grupo, não resolveria JID e a
// mensagem seria descartada — uma primitiva de supressão de mensagem de cliente.
// Sem JID de grupo, segue o fluxo normal de atendimento.
function ehGrupo(
  data: Record<string, unknown>,
  envelope?: Record<string, unknown>,
): boolean {
  return normalizarJidGrupo(data.chatid) !== null ||
    normalizarJidGrupo((data as { chatId?: unknown }).chatId) !== null ||
    normalizarJidGrupo(envelope?.chatid) !== null;
}

// Mascara LID para logs (RNF-S10): mantém 4 primeiros e 2 últimos.
function mascararLid(lid: string | null | undefined): string | null {
  if (!lid) return null;
  const s = String(lid);
  if (s.length < 8) return "***";
  return `${s.slice(0, 4)}***${s.slice(-2)}`;
}

interface ClienteResolvido {
  id: string;
  nome: string | null;
  via: "e164" | "lid";
}

type ResolverErro =
  | { erro: "sem_telefone" }
  | { erro: "lid_desconhecido"; via_tentada: "e164" | "lid" }
  | { erro: "criar_erro"; detalhe?: string };

async function resolverClienteIdent(
  data: Record<string, unknown>,
  supabase: ReturnType<typeof getSupabaseAdmin>,
  opts: { permitirCriar: boolean; senderName: string | null; preferChatid?: boolean },
): Promise<ClienteResolvido | ResolverErro> {
  const chatid = (data.chatid as string | undefined) ?? null;
  // Em mensagens fromMe (enviadas pelo celular da empresa) o REMETENTE é a
  // empresa; o cliente é o destinatário, que vem no chatid. Nesse caso
  // ignoramos sender_pn/sender_lid (dados do nosso próprio número) e
  // identificamos o cliente exclusivamente pelo chatid.
  const senderPn = opts.preferChatid ? null : ((data.sender_pn as string | undefined) ?? null);
  const senderLid = opts.preferChatid ? null : ((data.sender_lid as string | undefined) ?? null);
  // LID normalizado: preferir sender_lid; senão o chatid quando for @lid.
  const chatLidNorm = extrairLid(senderLid) ??
    (chatid && String(chatid).includes("@lid") ? extrairLid(chatid) : null);

  if (!ehLid(chatid, senderLid, senderPn)) {
    // Caminho E.164. Número vem de sender_pn ou do chatid (@s.whatsapp.net/@c.us).
    const numero = normalizarNumero(senderPn ?? chatid);
    if (!numero) return { erro: "sem_telefone" };

    const { data: c } = await supabase
      .from("clients")
      .select("id, nome, chat_lid")
      .eq("numero_whatsapp", numero)
      .maybeSingle();

    if (c) {
      if (chatLidNorm && !c.chat_lid) {
        const { error } = await supabase
          .from("clients")
          .update({ chat_lid: chatLidNorm })
          .eq("id", c.id)
          .is("chat_lid", null);
        if (!error) {
          log({
            funcao: FUNCAO,
            evento: "chat_lid_populado",
            status: "ok",
            client_id: c.id,
            extra: { chat_lid_mask: mascararLid(chatLidNorm) },
          });
        }
      }
      if (!c.nome && opts.senderName) {
        await supabase.from("clients").update({ nome: opts.senderName }).eq("id", c.id);
      }
      return { id: c.id, nome: c.nome, via: "e164" };
    }

    if (!opts.permitirCriar) return { erro: "lid_desconhecido", via_tentada: "e164" };

    const { data: novo, error } = await supabase
      .from("clients")
      .insert({ numero_whatsapp: numero, nome: opts.senderName, chat_lid: chatLidNorm })
      .select("id, nome")
      .single();
    if (error || !novo) return { erro: "criar_erro", detalhe: error?.message };
    return { id: novo.id, nome: novo.nome, via: "e164" };
  }

  // Caminho LID.
  const lid = chatLidNorm ??
    (chatid && String(chatid).includes("@lid") ? extrairLid(chatid) : null);
  if (!lid) return { erro: "sem_telefone" };

  const { data: c } = await supabase
    .from("clients")
    .select("id, nome")
    .eq("chat_lid", lid)
    .maybeSingle();
  if (c) return { id: c.id, nome: c.nome, via: "lid" };

  return { erro: "lid_desconhecido", via_tentada: "lid" };
}

// Verifica se o atendimento já recebeu alguma mensagem outbound enviada
// FORA do sistema (sender_type='externo'). Sinaliza que existe uma atendente
// humana cuidando do cliente diretamente pelo WhatsApp e que o bot não deve
// reabrir triagem nem encerrar por virada de dia.
async function temAtividadeExterna(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  atendimentoId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("mensagens")
    .select("id")
    .eq("atendimento_id", atendimentoId)
    .eq("direction", "outbound")
    .eq("sender_type", "externo")
    .limit(1)
    .maybeSingle();
  return !!data;
}

// Procura o último atendimento encerrado nas últimas 24h desse cliente que
// merece reabertura automática: ou foi encerrado por inatividade, ou tem
// conversa externa registrada (atendente respondeu pelo WhatsApp pessoal).
// Retorna { id, current_department_id, assigned_to, close_reason } ou null.
//
// opts.apenasInatividade: quando true, só reabre encerramentos automáticos por
// inatividade (ignora a heurística de conversa externa). Usado no caminho
// inbound do cliente, onde um encerramento manual deve cair em triagem nova.
async function buscarEncerradoReabrivel(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  clientId: string,
  opts?: { apenasInatividade?: boolean },
): Promise<
  {
    id: string;
    current_department_id: string | null;
    assigned_to: string | null;
    closed_at: string | null;
    close_reason: string | null;
  } | null
> {
  const cutoff24hIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: candidatos } = await supabase
    .from("atendimentos")
    .select("id, current_department_id, assigned_to, closed_at, close_reason")
    .eq("client_id", clientId)
    .eq("status", "encerrado")
    .gte("closed_at", cutoff24hIso)
    .order("closed_at", { ascending: false })
    .limit(5);
  if (!candidatos || candidatos.length === 0) return null;

  for (const c of candidatos as Array<{
    id: string;
    current_department_id: string | null;
    assigned_to: string | null;
    closed_at: string | null;
    close_reason: string | null;
  }>) {
    if (c.close_reason === "automatico_inatividade") return c;
    // Atendimento criado pela importação inicial só guarda conversa antiga.
    // Reabri-lo jogaria histórico importado de volta na fila.
    if (c.close_reason === "migracao_inicial") continue;
    // Inbound: encerramento manual (ou qualquer não-inatividade) é definitivo →
    // cai em triagem nova. A heurística de conversa externa só vale no fromMe.
    if (opts?.apenasInatividade) continue;
    if (await temAtividadeExterna(supabase, c.id)) return c;
  }
  return null;
}

// Janela (em horas) em que a resposta do cliente continua no setor da conversa
// anterior em vez de voltar para o menu de departamentos. 0 = desligado.
const JANELA_CONTINUIDADE_DEFAULT_H = 72;

async function lerJanelaContinuidadeHoras(
  supabase: ReturnType<typeof getSupabaseAdmin>,
): Promise<number> {
  const { data } = await supabase
    .from("system_config")
    .select("valor")
    .eq("chave", "janela_continuidade_apos_encerramento")
    .maybeSingle();
  const bruto = ((data?.valor ?? "") as string).trim();
  if (bruto === "") return JANELA_CONTINUIDADE_DEFAULT_H;
  const n = Number.parseInt(bruto, 10);
  // Chave presente com lixo dentro: cai no default em vez de desligar sem aviso.
  return Number.isFinite(n) && n >= 0 ? n : JANELA_CONTINUIDADE_DEFAULT_H;
}

// Último atendimento encerrado do cliente que tem setor definido — é dele que a
// continuidade herda o departamento. Ignora encerrados sem setor (triagem
// abandonada, por exemplo), que não têm nada a herdar.
async function buscarUltimoEncerradoComSetor(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  clientId: string,
): Promise<AtendimentoEncerradoAnterior | null> {
  const { data } = await supabase
    .from("atendimentos")
    .select("id, current_department_id, closed_at")
    .eq("client_id", clientId)
    .eq("status", "encerrado")
    .not("current_department_id", "is", null)
    .not("closed_at", "is", null)
    .order("closed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as AtendimentoEncerradoAnterior | null) ?? null;
}

// Reabre o atendimento encerrado escolhido. Retorna o id se sucesso.
async function reabrirAtendimentoEncerrado(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  enc: {
    id: string;
    current_department_id: string | null;
    assigned_to: string | null;
    closed_at: string | null;
    close_reason: string | null;
  },
  clientId: string,
  origem: string,
  zapiMessageId: string | null,
): Promise<{ id: string; current_department_id: string | null } | null> {
  const novoStatus = enc.assigned_to ? "em_atendimento" : "pendente";
  const closedAtAnterior = enc.closed_at;
  const closeReasonAnterior = enc.close_reason;

  const { error: errReabrir } = await supabase
    .from("atendimentos")
    .update({
      status: novoStatus,
      closed_at: null,
      closed_by_user_id: null,
      close_reason: null,
    })
    .eq("id", enc.id)
    .eq("status", "encerrado");

  if (errReabrir) {
    log({
      funcao: FUNCAO,
      evento: "reabertura_automatica_erro",
      status: "erro",
      atendimento_id: enc.id,
      client_id: clientId,
      erro_msg: errReabrir.message,
    });
    return null;
  }

  await supabase.from("timeline_events").insert({
    atendimento_id: enc.id,
    tipo_evento: "reabertura_automatica",
    actor_user_id: null,
    target_user_id: enc.assigned_to ?? null,
    payload: {
      motivo: origem,
      closed_at_anterior: closedAtAnterior,
      close_reason_anterior: closeReasonAnterior,
      novo_status: novoStatus,
      zapi_message_id: zapiMessageId,
    },
  });

  log({
    funcao: FUNCAO,
    evento: "atendimento_reaberto_automatico",
    status: "ok",
    atendimento_id: enc.id,
    client_id: clientId,
    extra: {
      novo_status: novoStatus,
      close_reason_anterior: closeReasonAnterior,
      origem,
    },
  });

  return { id: enc.id, current_department_id: enc.current_department_id };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, erro: "method_not_allowed" }, 405);
  }

  const cron = iniciarCronometro();
  const supabase = getSupabaseAdmin();

  // 1) A validação de origem é feita APÓS o parse do corpo, comparando o `token`
  // que a uazapi envia no payload com o secret UAZAPI_TOKEN (ver 2b). A uazapi
  // inclui o token da instância no corpo — mais confiável que query string.

  // 2) Parse do envelope.
  let envelope: Record<string, unknown>;
  try {
    envelope = (await req.json()) as Record<string, unknown>;
  } catch {
    log({ funcao: FUNCAO, evento: "payload_invalido", status: "erro", duracao_ms: cron() });
    // 200 mesmo assim para a uazapi não reenviar payload quebrado.
    return jsonResponse({ ok: true, ignorado: "payload_invalido" });
  }

  // 2b) Validação de origem: a uazapi inclui o token da instância no corpo
  // (`token`). Conferimos contra o secret UAZAPI_TOKEN — é o jeito real como a
  // uazapi entrega e não depende de query string.
  //
  // FAIL-CLOSED: sem o secret configurado, RECUSA. Antes a condição era
  // `if (expectedToken && ...)`, ou seja, secret ausente = qualquer POST aceito.
  // Isso passou a importar muito mais quando o desvio de grupo começou a GRAVAR:
  // um payload forjado criaria grupos e mensagens com autoria inventada e
  // dispararia download de mídia de URL arbitrária.
  const expectedToken = Deno.env.get("UAZAPI_TOKEN");
  if (!expectedToken) {
    log({ funcao: FUNCAO, evento: "secret_ausente", status: "erro", duracao_ms: cron() });
    return jsonResponse({ ok: false, erro: "misconfigured" }, 503);
  }
  const bodyToken = typeof envelope.token === "string" ? (envelope.token as string) : null;
  if (!bodyToken || !comparaConstante(bodyToken, expectedToken)) {
    log({ funcao: FUNCAO, evento: "token_invalido", status: "erro", duracao_ms: cron() });
    return jsonResponse({ ok: false, erro: "unauthorized" }, 401);
  }

  // Formato REAL da uazapi (confirmado em produção): envelope
  //   { EventType, chat, message, owner, token, instanceName, ... }
  // O tipo do evento vem em `EventType`; a mensagem em `message`.
  const eventStr = ((envelope.EventType ?? envelope.event) as string | undefined) ?? null;
  const payload = ((envelope.message && typeof envelope.message === "object")
    ? envelope.message
    : (envelope.data && typeof envelope.data === "object")
    ? envelope.data
    : envelope) as Record<string, unknown>;

  // Conexão: apenas logar, sem ação no banco.
  const eventLc = (eventStr ?? "").toLowerCase();
  if (eventLc === "connection") {
    log({
      funcao: FUNCAO,
      evento: "uazapi_connection",
      status: "ok",
      extra: { event: eventStr },
    });
    return jsonResponse({ ok: true });
  }

  // Detecção de rota. Eventos de status: "messages_update"/"status". Mensagem
  // nova: "messages"/"message". Se o `event` não bater, roteia pela forma do
  // `data`: cara de mensagem (tem messageType/text/chatid) → mensagem;
  // só id+status → status.
  const statusRaw =
    (payload.status as string | undefined) ??
      (payload.messageStatus as string | undefined) ??
      null;
  const temCaraDeMensagem = payload.messageType != null ||
    typeof payload.text === "string" ||
    payload.chatid != null ||
    payload.fromMe != null;
  const ehEventoStatus = eventLc === "messages_update" || eventLc === "status" ||
    (!eventLc.startsWith("message") && !temCaraDeMensagem && statusRaw != null);
  const ehEventoMensagem = eventLc === "messages" || eventLc === "message" ||
    (!ehEventoStatus && temCaraDeMensagem);

  const fromMe = payload.fromMe === true;
  const wasSentByApi = payload.wasSentByApi === true;
  const zapiMessageId =
    (payload.id as string | undefined) ??
      (payload.messageid as string | undefined) ??
      null;

  // Mensagem de grupo é decidida aqui porque muda o resto do roteamento.
  const ehMensagemDeGrupo = ehEventoMensagem && ehGrupo(payload, envelope);

  // `quoted`: id (owner:messageid) da mensagem citada. Resolve para nossa
  // mensagens.id correspondente, se existir. Em grupo NÃO fazemos esta busca:
  // a citação de grupo mora em `grupo_mensagens` e é resolvida lá dentro.
  const quotedId =
    (typeof payload.quoted === "string" ? (payload.quoted as string) : null) ??
      null;
  let replyToMessageId: string | null = null;
  if (quotedId && !ehMensagemDeGrupo) {
    const { data: refRow } = await supabase
      .from("mensagens")
      .select("id")
      .eq("zapi_message_id", quotedId)
      .maybeSingle();
    if (refRow?.id) replyToMessageId = refRow.id as string;
  }

  // Bring-up/observabilidade: log estruturado sem dados sensíveis (nada de
  // texto, número completo ou tokens) para confirmar o formato real da uazapi.
  log({
    funcao: FUNCAO,
    evento: "uazapi_webhook_recebido",
    status: "ok",
    extra: {
      event: eventStr,
      message_type: (payload.messageType as string | undefined) ?? null,
      from_me: fromMe,
      was_sent_by_api: wasSentByApi,
      is_group: (payload as { isGroup?: unknown }).isGroup === true,
      has_file: typeof payload.fileURL === "string" && !!payload.fileURL,
      has_button_or_list: typeof payload.buttonOrListid === "string" &&
        (payload.buttonOrListid as string).trim() !== "",
      status_raw: statusRaw,
    },
  });

  // Mensagens enviadas pela API voltam com wasSentByApi=true. Elas NÃO são
  // ignoradas: a mesma instância uazapi é usada por outro sistema (envio de
  // documentos), e sem esses eventos o chat mostra a resposta do cliente sem a
  // mensagem que a motivou. Seguem pelo caminho `fromMe` normal, que só grava —
  // não responde, não chama bot, não reenvia nada — então não existe loop.
  // O eco do NOSSO próprio envio é reconhecido e adotado (ver ./eco.ts).
  if (wasSentByApi && !fromMe) {
    // Combinação inesperada (enviada pela API mas não é nossa saída): sem
    // semântica definida, ignora em vez de adivinhar.
    log({
      funcao: FUNCAO,
      evento: "evento_ignorado",
      status: "ok",
      extra: { motivo: "was_sent_by_api_sem_from_me", event: eventStr },
    });
    return jsonResponse({ ok: true });
  }

  // Desvio de GRUPO: chatid termina em "@g.us". Sai do fluxo de atendimento
  // inteiro (não cria cliente — o JID violaria o CHECK E.164 — nem atendimento,
  // triagem ou bot) e vai para `grupo_mensagens`, que é o caminho paralelo.
  if (ehMensagemDeGrupo) {
    const parsedGrupo = parseMensagem(payload);
    if (!parsedGrupo) {
      log({
        funcao: FUNCAO,
        evento: "evento_ignorado",
        status: "ok",
        extra: { motivo: "grupo_sem_conteudo", event: eventStr },
      });
      return jsonResponse({ ok: true });
    }

    try {
      const res = await registrarMensagemGrupo({
        supabase,
        payload,
        // Só o que é usado: o envelope inteiro carrega `token` (= UAZAPI_TOKEN em
        // texto claro) e não tem por que descer para a camada de escrita.
        envelope: { chat: envelope.chat, chatid: envelope.chatid },
        parsed: parsedGrupo,
        uazapiMessageId: zapiMessageId,
        quotedUazapiId: quotedId,
        wasSentByApi,
      });
      if (!res.ok) {
        log({
          funcao: FUNCAO,
          evento: "evento_ignorado",
          status: "ok",
          extra: { motivo: res.motivo ?? "grupo_nao_registrado", event: eventStr },
        });
      }
      return jsonResponse({
        ok: true,
        grupo: true,
        mensagem_id: res.mensagemId,
        duplicada: res.duplicada ?? false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log({
        funcao: FUNCAO,
        evento: "grupo_erro_inesperado",
        status: "erro",
        erro_msg: msg.slice(0, 200),
      });
      // 200 mesmo assim: a uazapi não deve reenviar em loop.
      return jsonResponse({ ok: true, erro_interno: true });
    }
  }

  try {
    // 3) Roteamento por tipo de evento.

    // 3a) Status de mensagem outbound (delivered/read/...).
    if (ehEventoStatus) {
      const novoStatus = mapStatusWhatsapp(statusRaw);
      const ids: string[] = zapiMessageId ? [zapiMessageId] : [];

      if (!novoStatus || ids.length === 0) {
        log({
          funcao: FUNCAO,
          evento: "status_ignorado",
          status: "ok",
          extra: { event: eventStr, status_raw: statusRaw },
        });
        return jsonResponse({ ok: true });
      }

      let atualizadas = 0;
      let orfaos = 0;
      for (const id of ids) {
        const { data, error } = await supabase
          .from("mensagens")
          .update({ status_whatsapp: novoStatus })
          .eq("zapi_message_id", id)
          .select("id");
        if (error) {
          log({
            funcao: FUNCAO,
            evento: "status_update_erro",
            status: "erro",
            erro_msg: error.message,
            extra: { zapi_message_id: id },
          });
          continue;
        }
        if (!data || data.length === 0) {
          // Não é mensagem de atendimento: pode ser de GRUPO. O evento de status
          // não diz se o chat é grupo, então a tentativa em grupo_mensagens é o
          // que distingue — sem ela todo "entregue/lido" de grupo viraria órfão.
          const { data: dataGrupo } = await supabase
            .from("grupo_mensagens")
            .update({ status_whatsapp: novoStatus })
            .eq("uazapi_message_id", id)
            .select("id");
          if (dataGrupo && dataGrupo.length > 0) {
            atualizadas++;
            log({
              funcao: FUNCAO,
              evento: "status_atualizado_grupo",
              status: "ok",
              mensagem_id: dataGrupo[0].id,
              extra: { uazapi_message_id: id, status_novo: novoStatus },
            });
            continue;
          }
          orfaos++;
          log({
            funcao: FUNCAO,
            evento: "status_orfao",
            status: "ok",
            extra: { zapi_message_id: id, status_novo: novoStatus },
          });
        } else {
          atualizadas++;
          log({
            funcao: FUNCAO,
            evento: "status_atualizado",
            status: "ok",
            mensagem_id: data[0].id,
            extra: { zapi_message_id: id, status_novo: novoStatus },
          });
        }
      }
      return jsonResponse({ ok: true, atualizadas, orfaos });
    }

    // 3b) Mensagem outbound originada FORA do sistema (alguém respondeu pelo
    // celular usando o número da empresa). RN-20 / ADR-022 — registrar como
    // sender_type='externo' para dar visibilidade na Inbox.
    // Mensagens que NÓS mesmos enviamos via send-whatsapp-message também voltam
    // como fromMe=true; o UNIQUE em zapi_message_id garante idempotência —
    // tratamento de 23505 é idêntico ao caminho inbound (silenciar como duplicada).
    if (fromMe) {
      const parsedExt = parseMensagem(payload);
      if (!parsedExt) {
        log({
          funcao: FUNCAO,
          evento: "evento_ignorado",
          status: "ok",
          extra: { motivo: "from_me_tipo_nao_suportado", event: eventStr },
        });
        return jsonResponse({ ok: true });
      }
      if (!zapiMessageId) {
        log({
          funcao: FUNCAO,
          evento: "evento_ignorado",
          status: "ok",
          extra: { motivo: "from_me_sem_message_id" },
        });
        return jsonResponse({ ok: true });
      }

      // Idempotência prévia (cobre tanto o eco do nosso send-whatsapp-message
      // quanto reentrega de webhook).
      const { data: jaExiste } = await supabase
        .from("mensagens")
        .select("id")
        .eq("zapi_message_id", zapiMessageId)
        .maybeSingle();
      if (jaExiste) {
        log({
          funcao: FUNCAO,
          evento: "mensagem_duplicada",
          status: "ok",
          mensagem_id: jaExiste.id,
          extra: { zapi_message_id: zapiMessageId, origem: "from_me" },
        });
        return jsonResponse({ ok: true, duplicada: true });
      }

      // Nome do contato: em fromMe o senderName é o NOSSO nome; o nome do
      // contato (destinatário) vem no objeto `chat` do envelope. Testamos os
      // campos mais comuns da uazapi de forma defensiva (ignorando valores
      // puramente numéricos, que seriam o próprio telefone).
      const chatObj = (envelope.chat && typeof envelope.chat === "object")
        ? (envelope.chat as Record<string, unknown>)
        : {};
      const escolherNome = (...vals: unknown[]): string | null => {
        for (const v of vals) {
          if (typeof v === "string" && v.trim() && !/^\+?\d[\d\s-]*$/.test(v.trim())) {
            return v.trim();
          }
        }
        return null;
      };
      let nomeContato = escolherNome(
        chatObj.wa_contactName,
        chatObj.wa_name,
        chatObj.name,
        chatObj.lead_name,
        chatObj.pushName,
        chatObj.verifiedName,
        (payload as Record<string, unknown>).chatName,
        (payload as Record<string, unknown>).pushName,
      );
      // O webhook fromMe normalmente NÃO traz o nome do destinatário. Buscamos
      // sob demanda na uazapi (POST /chat/details) pelo número do chatid.
      if (!nomeContato) {
        const numeroChat = normalizarNumero(
          (payload.chatid as string | undefined) ?? null,
        );
        if (numeroChat) {
          nomeContato = await buscarNomeContato(numeroChat);
        }
      }

      // Cliente = o DESTINATÁRIO (chatid), pois em fromMe o remetente é a
      // empresa. permitirCriar: se você iniciou uma conversa nova pelo celular
      // com alguém que ainda não é cliente, criamos o cliente aqui (com o nome).
      const resolved = await resolverClienteIdent(payload, supabase, {
        permitirCriar: true,
        senderName: nomeContato,
        preferChatid: true,
      });
      if ("erro" in resolved) {
        if (resolved.erro === "sem_telefone") {
          log({
            funcao: FUNCAO,
            evento: "evento_ignorado",
            status: "ok",
            extra: { motivo: "from_me_sem_telefone" },
          });
        } else if (resolved.erro === "lid_desconhecido") {
          // Só cai aqui em chat LID sem E.164 conhecido: não dá para criar
          // cliente (CHECK exige E.164). Fica visível quando o cliente responder.
          log({
            funcao: FUNCAO,
            evento: "evento_ignorado",
            status: "ok",
            extra: {
              motivo: "from_me_lid_sem_e164",
              via_tentada: resolved.via_tentada,
              chat_lid_mask: mascararLid(
                extrairLid((payload.chatid as string | undefined) ?? null),
              ),
            },
          });
        } else {
          log({
            funcao: FUNCAO,
            evento: "evento_ignorado",
            status: "ok",
            extra: { motivo: "from_me_resolver_erro", detalhe: resolved.detalhe ?? null },
          });
        }
        return jsonResponse({ ok: true });
      }
      const clienteExt = { id: resolved.id };
      atualizarFotoEmSegundoPlano(
        supabase,
        { tabela: "clients", id: resolved.id, urlConhecida: fotoDoChat(chatObj) },
        FUNCAO,
      );

      // Eco do NOSSO envio: ou a linha já existe com o id (dedup normal), ou
      // existe sem o id porque o UPDATE pós-envio ainda não rodou (adoção).
      // Duas tentativas, com uma folga entre elas, porque quem envia pode ainda
      // não ter gravado nada. Tudo isso ANTES de procurar/abrir atendimento —
      // não há nada a criar quando a mensagem já é nossa.
      if (wasSentByApi) {
        const reconhecerProprio = async (): Promise<Response | null> => {
          const { data: jaGravada } = await supabase
            .from("mensagens")
            .select("id")
            .eq("zapi_message_id", zapiMessageId)
            .maybeSingle();
          if (jaGravada?.id) {
            log({
              funcao: FUNCAO,
              evento: "mensagem_duplicada",
              status: "ok",
              mensagem_id: jaGravada.id as string,
              extra: { zapi_message_id: zapiMessageId, origem: "eco_api" },
            });
            return jsonResponse({ ok: true, duplicada: true });
          }
          const adotadaId = await adotarEcoProprio({
            supabase,
            tabela: "mensagens",
            colunaMessageId: "zapi_message_id",
            escopo: { coluna: "client_id", valor: clienteExt.id },
            eco: parsedExt,
            messageId: zapiMessageId,
          });
          return adotadaId
            ? jsonResponse({ ok: true, mensagem_id: adotadaId, eco_proprio: true })
            : null;
        };

        const proprio = await reconhecerProprio();
        if (proprio) return proprio;
        await aguardarAssentarEco();
        const proprioTardio = await reconhecerProprio();
        if (proprioTardio) return proprioTardio;

        // Não é eco de mensagem do chat. Ainda pode ser um aviso INTERNO nosso
        // ("Novo atendimento pra você") — esses vão para o WhatsApp de
        // colaboradores, e cinco deles também são `clients`. O corte é por
        // mensagem, não por número: documento que a contabilidade mandar para o
        // mesmo colaborador continua entrando na conversa.
        if (await ehEnvioInterno(supabase, zapiMessageId)) {
          log({
            funcao: FUNCAO,
            evento: "evento_ignorado",
            status: "ok",
            client_id: clienteExt.id,
            extra: { motivo: "aviso_interno_do_sistema" },
          });
          return jsonResponse({ ok: true, ignorado: "aviso_interno" });
        }
      }

      // Procura atendimento ativo desse cliente (para anexar a mensagem nele).
      let atendExt = (await supabase
        .from("atendimentos")
        .select("id, current_department_id")
        .eq("client_id", clienteExt.id)
        .in("status", STATUS_INSTAVEL_ATENDIMENTO)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()).data as { id: string; current_department_id: string | null } | null;

      // Opção A: se não há atendimento ativo, tenta reabrir o último encerrado
      // que merece reabertura (inatividade automática OU já tinha conversa
      // externa em andamento) nas últimas 24h.
      if (!atendExt) {
        const enc = await buscarEncerradoReabrivel(supabase, clienteExt.id);
        if (enc) {
          const reaberto = await reabrirAtendimentoEncerrado(
            supabase,
            enc,
            clienteExt.id,
            "mensagem_externa_pos_encerramento",
            zapiMessageId,
          );
          if (!reaberto) {
            return jsonResponse({ ok: true });
          }
          atendExt = reaberto;
        }
      }

      // #2 — Conversa iniciada pelo celular com cliente sem atendimento aberto:
      // cria um atendimento visível SÓ para admins/supervisão. status
      // 'em_atendimento' SEM dono (assigned_to null): quem vê tudo (admin)
      // enxerga na Inbox; colaborador comum não (só vê o que é dele) e NÃO
      // entra em Pendentes (que lista pendente/em_triagem). E o bot não mexe.
      if (!atendExt) {
        // Departamento é obrigatório fora de em_triagem (CHECK do banco).
        // Preferência: config 'triagem_departamento_default' → "Outros"
        // (catch-all) → primeiro departamento ativo.
        const { data: cfgDept } = await supabase
          .from("system_config")
          .select("valor")
          .eq("chave", "triagem_departamento_default")
          .maybeSingle();
        let deptExt = (cfgDept?.valor ?? null) as string | null;
        if (!deptExt) {
          const { data: dOutros } = await supabase
            .from("departments")
            .select("id")
            .eq("ativo", true)
            .ilike("nome", "outros")
            .limit(1)
            .maybeSingle();
          deptExt = (dOutros?.id as string | undefined) ?? null;
        }
        if (!deptExt) {
          const { data: dPrim } = await supabase
            .from("departments")
            .select("id")
            .eq("ativo", true)
            .order("created_at", { ascending: true })
            .limit(1)
            .maybeSingle();
          deptExt = (dPrim?.id as string | undefined) ?? null;
        }
        if (!deptExt) {
          log({
            funcao: FUNCAO,
            evento: "externo_sem_departamento",
            status: "erro",
            client_id: clienteExt.id,
            extra: { motivo: "nenhum_departamento_ativo" },
          });
          return jsonResponse({ ok: true });
        }
        const agoraIso = new Date().toISOString();
        const { data: novoExt, error: errNovoExt } = await supabase
          .from("atendimentos")
          .insert({
            client_id: clienteExt.id,
            status: "em_atendimento",
            current_department_id: deptExt,
            assigned_to: null,
            triagem_estagio: "concluida",
            triagem_started_at: agoraIso,
            triagem_finished_at: agoraIso,
            first_response_at: agoraIso,
          })
          .select("id, current_department_id")
          .single();
        if (errNovoExt) {
          // 23505 = corrida com outra invocação (índice único
          // uniq_atendimento_ativo_por_cliente). Reaproveita o atendimento
          // ativo já existente em vez de perder a mensagem externa.
          const isUnique = (errNovoExt.code === "23505") ||
            /duplicate key|uniq_atendimento_ativo_por_cliente/i.test(errNovoExt.message);
          if (isUnique) {
            const { data: vencedorExt } = await supabase
              .from("atendimentos")
              .select("id, current_department_id")
              .eq("client_id", clienteExt.id)
              .in("status", STATUS_INSTAVEL_ATENDIMENTO)
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle();
            if (vencedorExt) {
              atendExt = vencedorExt as { id: string; current_department_id: string | null };
              log({
                funcao: FUNCAO,
                evento: "atendimento_corrida_reaproveitado",
                status: "ok",
                atendimento_id: atendExt.id,
                client_id: clienteExt.id,
                extra: { origem: "from_me" },
              });
            }
          }
          if (!atendExt) {
            log({
              funcao: FUNCAO,
              evento: "criar_atendimento_externo_erro",
              status: "erro",
              client_id: clienteExt.id,
              erro_msg: errNovoExt.message,
            });
            return jsonResponse({ ok: true });
          }
        } else if (!novoExt) {
          log({
            funcao: FUNCAO,
            evento: "criar_atendimento_externo_erro",
            status: "erro",
            client_id: clienteExt.id,
            erro_msg: "insert_sem_retorno",
          });
          return jsonResponse({ ok: true });
        } else {
          atendExt = novoExt as { id: string; current_department_id: string | null };
          await supabase.from("timeline_events").insert({
            atendimento_id: atendExt.id,
            tipo_evento: "iniciado_atendimento",
            actor_user_id: null,
            to_department_id: atendExt.current_department_id,
            payload: { origem: "mensagem_externa_celular" },
          });
          log({
            funcao: FUNCAO,
            evento: "atendimento_externo_criado",
            status: "ok",
            atendimento_id: atendExt.id,
            client_id: clienteExt.id,
            extra: { dept: atendExt.current_department_id },
          });
        }
      }

      // `origem` distingue as duas fontes de mensagem externa: celular da
      // empresa x outro sistema usando a mesma instância uazapi.
      const metaExt = {
        ...(parsedExt.media_metadata ?? {}),
        origem: wasSentByApi ? "api_externa" : "celular",
      };

      // Hora real da mensagem no WhatsApp, não a do INSERT: o eco pode demorar
      // alguns segundos (inclusive a folga que damos para reconhecê-lo) e a
      // conversa é ordenada por created_at. Sem timestamp confiável, cai no
      // DEFAULT now() da coluna.
      const criadoEmExt = dataDaMensagem(payload);

      const { data: msgExt, error: errExt } = await supabase
        .from("mensagens")
        .insert({
          atendimento_id: atendExt.id,
          client_id: clienteExt.id,
          department_id: atendExt.current_department_id,
          direction: "outbound",
          sender_type: "externo",
          sent_by_user_id: null,
          tipo: parsedExt.tipo,
          content: parsedExt.content,
          media_url: parsedExt.media_url,
          media_metadata: metaExt,
          zapi_message_id: zapiMessageId,
          status_envio: "enviado",
          status_whatsapp: "enviado",
          reply_to_message_id: replyToMessageId,
          ...(criadoEmExt ? { created_at: criadoEmExt } : {}),
        })
        .select("id")
        .maybeSingle();

      if (errExt) {
        const isUnique = (errExt.code === "23505") ||
          /duplicate key|uniq_mensagens_zapi_message_id/i.test(errExt.message);
        if (isUnique) {
          log({
            funcao: FUNCAO,
            evento: "mensagem_duplicada",
            status: "ok",
            extra: { zapi_message_id: zapiMessageId, origem: "from_me", via: "conflict" },
          });
          return jsonResponse({ ok: true, duplicada: true });
        }
        log({
          funcao: FUNCAO,
          evento: "insert_mensagem_erro",
          status: "erro",
          erro_msg: errExt.message,
          atendimento_id: atendExt.id,
          extra: { origem: "from_me" },
        });
        return jsonResponse({ ok: true });
      }

      const mensagemExtId = msgExt!.id as string;
      log({
        funcao: FUNCAO,
        evento: "mensagem_externa_persistida",
        status: "ok",
        atendimento_id: atendExt.id,
        mensagem_id: mensagemExtId,
        client_id: clienteExt.id,
        duracao_ms: cron(),
        extra: { tipo: parsedExt.tipo, zapi_message_id: zapiMessageId },
      });

      // Mídia: mesmo fluxo do inbound.
      if (TIPOS_COM_DOWNLOAD.has(parsedExt.tipo)) {
        const tarefa = baixarESalvarMidia({
          funcao: FUNCAO,
          mensagemId: mensagemExtId,
          atendimentoId: atendExt.id,
          clientId: clienteExt.id,
          zapiMessageId,
          urlOriginal: parsedExt.media_url,
          tipo: parsedExt.tipo,
          metaInicial: metaExt,
        });
        const edge = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } })
          .EdgeRuntime;
        if (edge?.waitUntil) edge.waitUntil(tarefa);
        else tarefa.catch(() => {});
      }

      return jsonResponse({ ok: true, mensagem_id: mensagemExtId, externo: true });
    }

    // 3c) Mensagem inbound do cliente.
    const parsed = parseMensagem(payload);
    if (!parsed) {
      log({
        funcao: FUNCAO,
        evento: "evento_ignorado",
        status: "ok",
        extra: {
          motivo: "tipo_nao_suportado",
          event: eventStr,
          message_type: (payload.messageType as string | undefined) ?? null,
        },
      });
      return jsonResponse({ ok: true });
    }

    if (!zapiMessageId) {
      log({ funcao: FUNCAO, evento: "evento_ignorado", status: "ok", extra: { motivo: "sem_message_id" } });
      return jsonResponse({ ok: true });
    }

    // 3c.1) Idempotência prévia: já existe mensagem com esse zapi_message_id?
    const { data: existente } = await supabase
      .from("mensagens")
      .select("id")
      .eq("zapi_message_id", zapiMessageId)
      .maybeSingle();
    if (existente) {
      log({
        funcao: FUNCAO,
        evento: "mensagem_duplicada",
        status: "ok",
        mensagem_id: existente.id,
        extra: { zapi_message_id: zapiMessageId },
      });
      return jsonResponse({ ok: true, duplicada: true });
    }

    // 3c.2) Resolve / cria cliente (E.164 ou LID — ADR-045).
    const senderName = (payload.senderName as string | undefined) ?? null;

    const resolvedIn = await resolverClienteIdent(payload, supabase, {
      permitirCriar: true,
      senderName,
    });
    if ("erro" in resolvedIn) {
      if (resolvedIn.erro === "sem_telefone") {
        log({ funcao: FUNCAO, evento: "evento_ignorado", status: "ok", extra: { motivo: "sem_telefone" } });
      } else if (resolvedIn.erro === "criar_erro") {
        log({
          funcao: FUNCAO,
          evento: "criar_cliente_erro",
          status: "erro",
          erro_msg: resolvedIn.detalhe,
          extra: {
            telefone_mask: mascararNumero(
              (payload.sender_pn as string | undefined) ??
                (payload.chatid as string | undefined),
            ),
          },
        });
      } else {
        // Inbound só com LID e sem cliente prévio: não dá para criar (CHECK E.164).
        log({
          funcao: FUNCAO,
          evento: "evento_ignorado",
          status: "ok",
          extra: {
            motivo: "inbound_lid_sem_cliente",
            via_tentada: resolvedIn.via_tentada,
            chat_lid_mask: mascararLid((payload as { sender_lid?: string }).sender_lid ?? null),
          },
        });
      }
      return jsonResponse({ ok: true });
    }
    const cliente = { id: resolvedIn.id, nome: resolvedIn.nome };
    atualizarFotoEmSegundoPlano(
      supabase,
      { tabela: "clients", id: resolvedIn.id, urlConhecida: fotoDoChat(envelope.chat) },
      FUNCAO,
    );

    // 3c.3) Resolve atendimento ativo OU cria novo em em_triagem.
    let { data: atend } = await supabase
      .from("atendimentos")
      .select("id, status, current_department_id, triagem_started_at, created_at")
      .eq("client_id", cliente.id)
      .in("status", STATUS_INSTAVEL_ATENDIMENTO)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle() as {
        data: {
          id: string;
          status: string;
          current_department_id: string | null;
          triagem_started_at: string | null;
          created_at: string;
        } | null;
      };

    // 3c.3.b) Se o atendimento ativo está em em_triagem e a data local
    // (America/Sao_Paulo) do início da triagem é anterior à data local de
    // agora, encerra-o e força a criação de um novo atendimento (nova triagem).
    if (atend && atend.status === "em_triagem") {
      const { data: cfgRow } = await supabase
        .from("system_config")
        .select("valor")
        .eq("chave", "triagem_reinicia_ao_virar_dia")
        .maybeSingle();
      const reiniciarVirarDia = (cfgRow?.valor ?? "true") === "true";

      if (reiniciarVirarDia) {
        const inicioIso = atend.triagem_started_at ?? atend.created_at;
        const TZ = "America/Sao_Paulo";
        const fmt = new Intl.DateTimeFormat("en-CA", {
          timeZone: TZ,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        });
        const dataInicio = fmt.format(new Date(inicioIso)); // YYYY-MM-DD
        const dataAgora = fmt.format(new Date());

        if (dataInicio < dataAgora) {
          // Antes de encerrar por virada de dia, verificar se há conversa
          // externa em andamento. Se sim, NÃO encerrar — apenas tirar da
          // triagem e promover para pendente, evitando que o bot recomece e
          // que o cliente perca o contexto da atendente humana.
          const temExterno = await temAtividadeExterna(supabase, atend.id);

          if (temExterno) {
            const { data: cfgDeptDefault } = await supabase
              .from("system_config")
              .select("valor")
              .eq("chave", "triagem_departamento_default")
              .maybeSingle();
            const deptDefault = (cfgDeptDefault?.valor ?? null) as string | null;
            const deptResolvido = atend.current_department_id ?? deptDefault;

            if (!deptResolvido) {
              log({
                funcao: FUNCAO,
                evento: "promocao_externa_sem_dept",
                status: "erro",
                atendimento_id: atend.id,
                client_id: cliente.id,
              });
            } else {
              const agoraIso = new Date().toISOString();
              const { error: errProm } = await supabase
                .from("atendimentos")
                .update({
                  status: "pendente",
                  current_department_id: deptResolvido,
                  triagem_estagio: "concluida",
                  triagem_finished_at: agoraIso,
                })
                .eq("id", atend.id)
                .eq("status", "em_triagem");

              if (!errProm) {
                await supabase.from("mensagens")
                  .update({ department_id: deptResolvido })
                  .eq("atendimento_id", atend.id)
                  .is("department_id", null);

                await supabase.from("timeline_events").insert({
                  atendimento_id: atend.id,
                  tipo_evento: "escalado",
                  actor_user_id: null,
                  to_department_id: deptResolvido,
                  payload: {
                    motivo: "atendimento_externo_detectado",
                    data_inicio_local: dataInicio,
                    data_agora_local: dataAgora,
                  },
                });

                log({
                  funcao: FUNCAO,
                  evento: "triagem_promovida_por_externo",
                  status: "ok",
                  atendimento_id: atend.id,
                  client_id: cliente.id,
                  extra: { dept: deptResolvido },
                });

                // Atualiza ref local para o restante do fluxo seguir nesse mesmo
                // atendimento, sem criar nova triagem.
                atend = {
                  ...atend,
                  status: "pendente",
                  current_department_id: deptResolvido,
                };
              } else {
                log({
                  funcao: FUNCAO,
                  evento: "triagem_promover_externo_erro",
                  status: "erro",
                  atendimento_id: atend.id,
                  client_id: cliente.id,
                  erro_msg: errProm.message,
                });
              }
            }
          } else {
            const { error: errEnc } = await supabase
              .from("atendimentos")
              .update({
                status: "encerrado",
                closed_at: new Date().toISOString(),
                close_reason: "triagem_expirada_dia",
                triagem_estagio: "concluida",
              })
              .eq("id", atend.id)
              .eq("status", "em_triagem");

            if (!errEnc) {
              await supabase.from("timeline_events").insert({
                atendimento_id: atend.id,
                tipo_evento: "encerrado",
                actor_user_id: null,
                payload: {
                  motivo: "triagem_expirada_dia",
                  data_inicio_local: dataInicio,
                  data_agora_local: dataAgora,
                },
              });
              log({
                funcao: FUNCAO,
                evento: "triagem_expirada_dia_encerrada",
                status: "ok",
                atendimento_id: atend.id,
                client_id: cliente.id,
                extra: { data_inicio_local: dataInicio, data_agora_local: dataAgora },
              });
              atend = null; // força criação de novo atendimento abaixo
            } else {
              log({
                funcao: FUNCAO,
                evento: "triagem_expirada_dia_encerrar_erro",
                status: "erro",
                atendimento_id: atend.id,
                client_id: cliente.id,
                erro_msg: errEnc.message,
              });
            }
          }
        }
      }
    }

    // 3c.3.b.2) Duas listas independentes de números liberados, consultadas só
    // quando vamos criar um atendimento do zero:
    //   - Sem Triagem (numeros_sem_triagem): pula TODA interação com o bot →
    //     atendimento já nasce concluído, direto em Pendentes geral.
    //   - Lista de Sessões (sessoes_triagem): roda o fluxo interno (saudação
    //     personalizada → escolhe departamento → escolhe o colaborador).
    // "Sem Triagem" tem prioridade caso o número esteja nas duas.
    let modoSessao = resolverModo(false, false);
    if (!atend) {
      const { data: cli } = await supabase
        .from("clients").select("numero_whatsapp").eq("id", cliente.id).maybeSingle();
      const numeroCli = (cli as { numero_whatsapp: string } | null)?.numero_whatsapp ?? null;
      if (numeroCli) {
        const [semTriagemRes, sessaoRes] = await Promise.all([
          supabase.from("numeros_sem_triagem").select("id")
            .eq("numero_whatsapp", numeroCli).eq("ativo", true).limit(1).maybeSingle(),
          supabase.from("sessoes_triagem").select("id")
            .eq("numero_whatsapp", numeroCli).eq("ativo", true).limit(1).maybeSingle(),
        ]);
        if (semTriagemRes.error) {
          log({
            funcao: FUNCAO,
            evento: "numeros_sem_triagem_lookup_erro",
            status: "erro",
            client_id: cliente.id,
            erro_msg: semTriagemRes.error.message,
          });
        }
        if (sessaoRes.error) {
          log({
            funcao: FUNCAO,
            evento: "sessoes_triagem_lookup_erro",
            status: "erro",
            client_id: cliente.id,
            erro_msg: sessaoRes.error.message,
          });
        }
        modoSessao = resolverModo(!!semTriagemRes.data, !!sessaoRes.data);
      }
    }

    // 3c.3.c) Antes de criar uma triagem nova, tentar reabrir o último
    // atendimento encerrado nas últimas 24h se ele tiver conversa externa
    // ou se foi encerrado por inatividade. Evita que um cliente sendo
    // atendido pelo WhatsApp pessoal volte para a triagem do bot.
    // Números do fluxo de sessão (setor+colaborador) pulam a reabertura:
    // sempre reiniciam o fluxo interno (podem querer falar com pessoas
    // diferentes a cada contato). "sem_triagem" não tem esse motivo e segue
    // como cliente normal.
    if (!atend && !devePularReabertura(modoSessao)) {
      // Inbound do cliente: encerramento manual é definitivo. Só reabre
      // automaticamente encerramentos por inatividade; qualquer outra coisa
      // (inclusive close manual com conversa externa antiga) inicia triagem nova.
      const enc = await buscarEncerradoReabrivel(supabase, cliente.id, {
        apenasInatividade: true,
      });
      if (enc) {
        const reaberto = await reabrirAtendimentoEncerrado(
          supabase,
          enc,
          cliente.id,
          "mensagem_inbound_pos_encerramento",
          zapiMessageId,
        );
        if (reaberto) {
          atend = {
            id: reaberto.id,
            status: enc.assigned_to ? "em_atendimento" : "pendente",
            current_department_id: reaberto.current_department_id,
            triagem_started_at: null,
            created_at: new Date().toISOString(),
          };
        }
      }
    }

    // 3c.3.d) Continuidade pós-encerramento: se o cliente está respondendo
    // pouco depois de um atendimento encerrado, o novo atendimento já nasce no
    // setor de antes, com triagem concluída — o bot nunca pergunta o setor de
    // novo. Vale tanto para a conversa que a empresa iniciou quanto para a que
    // o cliente iniciou; o encerramento (hoje sempre manual) não é desfeito.
    const agora = new Date().toISOString();
    let continuidade: Continuidade | null = null;
    if (!atend) {
      const [janelaHoras, anterior] = await Promise.all([
        lerJanelaContinuidadeHoras(supabase),
        buscarUltimoEncerradoComSetor(supabase, cliente.id),
      ]);
      continuidade = resolverContinuidade({
        modo: modoSessao,
        anterior,
        janelaHoras,
        agoraIso: agora,
      });
    }

    if (!atend) {
      let novoRegistro: NovoAtendimentoFields | AtendimentoContinuidadeFields;
      // Preenchido só no caminho de continuidade — é dele que saem o status
      // inicial e o responsável para a timeline/log.
      let camposContinuidade: AtendimentoContinuidadeFields | null = null;
      if (continuidade) {
        // Mesmo roteamento da triagem-bot ao concluir: último atendente do
        // cliente naquele setor (se ainda ativo e disponível) → reservado para
        // ele; senão → Pendentes do setor.
        const { data: ultimoAtendente } = await supabase.rpc(
          "ultimo_atendente_no_departamento",
          { p_client_id: cliente.id, p_department_id: continuidade.departmentId },
        );
        camposContinuidade = montarAtendimentoContinuidade(
          cliente.id,
          continuidade.departmentId,
          (ultimoAtendente as string | null) ?? null,
          agora,
        );
        novoRegistro = camposContinuidade;
      } else {
        novoRegistro = montarNovoAtendimento(cliente.id, modoSessao, agora);
      }
      const { data: novoAtend, error: errAt } = await supabase
        .from("atendimentos")
        .insert(novoRegistro)
        .select("id, status, current_department_id, triagem_started_at, created_at")
        .single();
      if (errAt) {
        // 23505 = corrida: outra invocação concorrente do webhook (cliente
        // mandou mensagens em rajada) já criou o atendimento ativo. O índice
        // único uniq_atendimento_ativo_por_cliente barra a duplicata; aqui
        // reaproveitamos o atendimento vencedor da corrida e seguimos anexando
        // a mensagem nele (em vez de perder a mensagem ou criar duplicata).
        const isUnique = (errAt.code === "23505") ||
          /duplicate key|uniq_atendimento_ativo_por_cliente/i.test(errAt.message);
        if (isUnique) {
          const { data: vencedor } = await supabase
            .from("atendimentos")
            .select("id, status, current_department_id, triagem_started_at, created_at")
            .eq("client_id", cliente.id)
            .in("status", STATUS_INSTAVEL_ATENDIMENTO)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (vencedor) {
            atend = vencedor;
            log({
              funcao: FUNCAO,
              evento: "atendimento_corrida_reaproveitado",
              status: "ok",
              atendimento_id: vencedor.id,
              client_id: cliente.id,
            });
          }
        }
        if (!atend) {
          log({
            funcao: FUNCAO,
            evento: "criar_atendimento_erro",
            status: "erro",
            erro_msg: errAt.message,
            client_id: cliente.id,
          });
          return jsonResponse({ ok: true });
        }
      } else if (!novoAtend) {
        log({
          funcao: FUNCAO,
          evento: "criar_atendimento_erro",
          status: "erro",
          erro_msg: "insert_sem_retorno",
          client_id: cliente.id,
        });
        return jsonResponse({ ok: true });
      } else {
        atend = novoAtend;
        if (continuidade && camposContinuidade) {
          await supabase.from("timeline_events").insert({
            atendimento_id: atend.id,
            tipo_evento: "iniciado_atendimento",
            actor_user_id: null,
            target_user_id: camposContinuidade.assigned_to,
            to_department_id: continuidade.departmentId,
            payload: {
              origem: "continuidade_pos_encerramento",
              atendimento_anterior_id: continuidade.anteriorId,
              horas_desde_fechamento: continuidade.horasDesdeFechamento,
            },
          });
        }
        log({
          funcao: FUNCAO,
          evento: continuidade ? "atendimento_continuidade_criado" : "atendimento_criado",
          status: "ok",
          atendimento_id: atend.id,
          client_id: cliente.id,
          extra: continuidade && camposContinuidade
            ? {
              modo_sessao: modoSessao,
              dept: continuidade.departmentId,
              anterior: continuidade.anteriorId,
              horas_desde_fechamento: continuidade.horasDesdeFechamento,
              status_inicial: camposContinuidade.status,
              assigned_to: camposContinuidade.assigned_to,
            }
            : { modo_sessao: modoSessao },
        });
      }
    }

    // Salvaguarda: neste ponto sempre há atendimento (criado, reaproveitado da
    // corrida ou reaberto). O guard satisfaz o compilador e é fail-safe.
    if (!atend) {
      log({ funcao: FUNCAO, evento: "atendimento_indefinido", status: "erro", client_id: cliente.id });
      return jsonResponse({ ok: true });
    }

    // 3c.4) Insere mensagem inbound (idempotência final via UNIQUE).
    const { data: msgInserida, error: errIns } = await supabase
      .from("mensagens")
      .insert({
        atendimento_id: atend.id,
        client_id: cliente.id,
        department_id: atend.current_department_id,
        direction: "inbound",
        sender_type: "cliente",
        sent_by_user_id: null,
        tipo: parsed.tipo,
        content: parsed.content,
        media_url: parsed.media_url,
        media_metadata: parsed.media_metadata,
        zapi_message_id: zapiMessageId,
        status_envio: "enviado",
        status_whatsapp: null,
        reply_to_message_id: replyToMessageId,
      })
      .select("id")
      .maybeSingle();

    if (errIns) {
      // Conflito UNIQUE = corrida; trata como duplicada.
      const isUnique = (errIns.code === "23505") ||
        /duplicate key|uniq_mensagens_zapi_message_id/i.test(errIns.message);
      if (isUnique) {
        log({
          funcao: FUNCAO,
          evento: "mensagem_duplicada",
          status: "ok",
          extra: { zapi_message_id: zapiMessageId, via: "conflict" },
        });
        return jsonResponse({ ok: true, duplicada: true });
      }
      log({
        funcao: FUNCAO,
        evento: "insert_mensagem_erro",
        status: "erro",
        erro_msg: errIns.message,
        atendimento_id: atend.id,
      });
      return jsonResponse({ ok: true });
    }

    const mensagemId = msgInserida!.id as string;
    log({
      funcao: FUNCAO,
      evento: "mensagem_persistida",
      status: "ok",
      atendimento_id: atend.id,
      mensagem_id: mensagemId,
      client_id: cliente.id,
      duracao_ms: cron(),
      extra: { tipo: parsed.tipo, zapi_message_id: zapiMessageId },
    });

    // 3c.5) Background: download da mídia para o Storage.
    if (TIPOS_COM_DOWNLOAD.has(parsed.tipo)) {
      const tarefa = baixarESalvarMidia({
        funcao: FUNCAO,
        mensagemId,
        atendimentoId: atend.id,
        clientId: cliente.id,
        zapiMessageId,
        urlOriginal: parsed.media_url,
        tipo: parsed.tipo,
        metaInicial: parsed.media_metadata ?? {},
      });
      const edge = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } })
        .EdgeRuntime;
      if (edge?.waitUntil) edge.waitUntil(tarefa);
      else tarefa.catch(() => {});
    }

    return jsonResponse({ ok: true, mensagem_id: mensagemId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log({ funcao: FUNCAO, evento: "erro_inesperado", status: "erro", erro_msg: msg.slice(0, 200) });
    // 200 mesmo assim — a uazapi não deve reenviar.
    return jsonResponse({ ok: true, erro_interno: true });
  }
});
