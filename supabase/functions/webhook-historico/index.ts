// Edge Function: webhook-historico
//
// Endpoint público que recebe SÓ o evento `history` da uazapi — o retorno
// assíncrono dos pedidos feitos por historico-solicitar (/message/history-sync).
//
// Por que é uma função separada do webhook-zapi-receive: o receiver principal
// cria atendimento, roda triagem, dispara bot e RESPONDE ao cliente. Um lote de
// histórico caindo lá mandaria mensagem automática para conversa de semanas
// atrás. Aqui o contrato é único e estreito: SÓ GRAVA.
//
// Esta função nunca:
//   - responde ao cliente ou chama a uazapi para enviar qualquer coisa;
//   - cria cliente, atendimento ou evento de timeline;
//   - promove/reabre atendimento (grava sender_type 'externo' para outbound, que
//     é o único valor que não dispara promote_atendimento_em_atendimento).
//
// Onde a mensagem encaixa: no atendimento MAIS ANTIGO do cliente, com
// `created_at` = hora real no WhatsApp. Os triggers de `mensagens` usam GREATEST
// com guarda, então nada de last_message_at/ordenação da Inbox anda para trás.
//
// Só aceita lote com pedido ABERTO em historico_import_pedidos para aquele chat.
// Isso importa: o evento `history` também dispara sozinho numa reconexão de QR
// code, e sem esse portão qualquer releitura de QR jogaria histórico no sistema
// sem ninguém ter pedido.

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";
import { baixarESalvarMidia } from "../_shared/midia-mensagem.ts";
import { dataDaMensagem, parseMensagem, TIPOS_COM_DOWNLOAD } from "../_shared/mensagem-uazapi.ts";
import {
  chatIdDaMensagem,
  dentroDaJanela,
  idsPossiveis,
  mensagensDoEventoHistory,
} from "../_shared/historico.ts";

const FUNCAO = "webhook-historico";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Teto de mensagens gravadas por requisição. Um lote de history pode vir grande;
// o que passar disso volta no próximo pedido (a âncora recua a cada rodada).
const MAX_POR_LOTE = 200;
// Depois disto, para de BAIXAR mídia (a mensagem ainda é gravada, com a mídia
// pendente). Evita a função ser morta no meio e perder o lote inteiro.
const ORCAMENTO_MIDIA_MS = 45_000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function comparaConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface Pedido {
  id: string;
  client_id: string;
  desde: string;
  ate: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ ok: false, erro: "method_not_allowed" }, 405);

  const cron = iniciarCronometro();
  const supabase = getSupabaseAdmin();

  let envelope: Record<string, unknown>;
  try {
    envelope = (await req.json()) as Record<string, unknown>;
  } catch {
    log({ funcao: FUNCAO, evento: "payload_invalido", status: "erro", duracao_ms: cron() });
    // 200 para a uazapi não reenviar payload quebrado.
    return jsonResponse({ ok: true, ignorado: "payload_invalido" });
  }

  // Origem: a uazapi manda o token da instância no corpo. FAIL-CLOSED — sem o
  // secret configurado, recusa. Aqui isso vale dobrado: um POST forjado gravaria
  // mensagem com texto, autoria e DATA arbitrários numa conversa real, e
  // `mensagens` não aceita DELETE.
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

  // Este endpoint é registrado só com events:["history"], mas se outro evento
  // chegar aqui por configuração errada, ignora — não é o lugar de tratar.
  const eventLc = String((envelope.EventType ?? envelope.event ?? "")).toLowerCase();
  if (eventLc && !eventLc.includes("history")) {
    log({
      funcao: FUNCAO,
      evento: "evento_ignorado",
      status: "ok",
      duracao_ms: cron(),
      extra: { motivo: "evento_nao_history", event: eventLc },
    });
    return jsonResponse({ ok: true, ignorado: "evento_nao_history" });
  }

  const mensagens = mensagensDoEventoHistory(envelope).slice(0, MAX_POR_LOTE);
  if (mensagens.length === 0) {
    return jsonResponse({ ok: true, ignorado: "lote_vazio" });
  }

  const inicio = Date.now();
  const pedidosPorChat = new Map<string, Pedido | null>();
  const atendimentoPorCliente = new Map<string, { id: string; current_department_id: string | null } | null>();
  const contadores = new Map<string, { recebidas: number; inseridas: number }>();

  let recebidas = 0;
  let inseridas = 0;
  let ignoradas = 0;
  let semPedido = 0;

  // Da mais antiga para a mais nova: se duas caírem no mesmo atendimento, a
  // ordem de inserção acompanha a ordem real da conversa.
  const ordenadas = mensagens
    .map((m) => ({ m, quando: dataDaMensagem(m) }))
    .filter((x): x is { m: Record<string, unknown>; quando: string } => x.quando !== null)
    .sort((a, b) => Date.parse(a.quando) - Date.parse(b.quando));

  for (const { m, quando } of ordenadas) {
    recebidas++;

    const chatid = chatIdDaMensagem(m, envelope);
    if (!chatid) {
      ignoradas++;
      continue;
    }
    // Grupo tem outro destino no sistema (grupo_mensagens) e outra semântica de
    // autoria — histórico de grupo fica fora desta importação.
    if (/@g\.us$/i.test(chatid)) {
      ignoradas++;
      continue;
    }

    if (!pedidosPorChat.has(chatid)) {
      const { data } = await supabase
        .from("historico_import_pedidos")
        .select("id, client_id, desde, ate")
        .eq("chatid", chatid)
        .gt("expira_em", new Date().toISOString())
        .order("solicitado_em", { ascending: false })
        .limit(1)
        .maybeSingle();
      pedidosPorChat.set(chatid, (data as Pedido | null) ?? null);
    }
    const pedido = pedidosPorChat.get(chatid) ?? null;
    if (!pedido) {
      semPedido++;
      continue;
    }

    if (!dentroDaJanela(quando, pedido.desde, pedido.ate)) {
      ignoradas++;
      continue;
    }

    const { preferido, todos } = idsPossiveis(m);
    if (!preferido) {
      ignoradas++;
      continue;
    }

    const { data: existentes } = await supabase
      .from("mensagens")
      .select("id")
      .in("zapi_message_id", todos)
      .limit(1);
    if ((existentes ?? []).length > 0) {
      ignoradas++;
      continue;
    }

    const parsed = parseMensagem(m);
    if (!parsed) {
      ignoradas++;
      continue;
    }

    if (!atendimentoPorCliente.has(pedido.client_id)) {
      const { data: atend } = await supabase
        .from("atendimentos")
        .select("id, current_department_id")
        .eq("client_id", pedido.client_id)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      atendimentoPorCliente.set(
        pedido.client_id,
        (atend as { id: string; current_department_id: string | null } | null) ?? null,
      );
    }
    const atendimento = atendimentoPorCliente.get(pedido.client_id) ?? null;
    if (!atendimento) {
      // Sem atendimento não há onde pendurar, e importar não cria atendimento
      // retroativo (isso inventaria histórico de atendimento que não houve).
      ignoradas++;
      continue;
    }

    const fromMe = m.fromMe === true;
    const meta = {
      ...(parsed.media_metadata ?? {}),
      origem: "historico_whatsapp",
      historico_importado: true,
    };

    const { data: nova, error: errIns } = await supabase
      .from("mensagens")
      .insert({
        atendimento_id: atendimento.id,
        client_id: pedido.client_id,
        department_id: atendimento.current_department_id,
        direction: fromMe ? "outbound" : "inbound",
        // 'externo' para o que saiu do nosso número: é o único sender_type de
        // outbound que NÃO dispara promote_atendimento_em_atendimento, ou seja,
        // não reabre atendimento encerrado nem carimba first_response_at antigo.
        sender_type: fromMe ? "externo" : "cliente",
        sent_by_user_id: null,
        tipo: parsed.tipo,
        content: parsed.content,
        media_url: parsed.media_url,
        media_metadata: meta,
        zapi_message_id: preferido,
        status_envio: "enviado",
        status_whatsapp: fromMe ? "enviado" : null,
        created_at: quando,
      })
      .select("id")
      .maybeSingle();

    if (errIns) {
      // 23505 = alguém gravou no meio do caminho (outro lote, ou o receiver).
      const ehUnique = errIns.code === "23505" || /duplicate key/i.test(errIns.message);
      if (ehUnique) {
        ignoradas++;
        continue;
      }
      log({
        funcao: FUNCAO,
        evento: "insert_mensagem_erro",
        status: "erro",
        erro_msg: errIns.message.slice(0, 160),
      });
      ignoradas++;
      continue;
    }
    if (!nova?.id) {
      ignoradas++;
      continue;
    }

    inseridas++;
    const c = contadores.get(pedido.id) ?? { recebidas: 0, inseridas: 0 };
    contadores.set(pedido.id, { recebidas: c.recebidas + 1, inseridas: c.inseridas + 1 });

    if (TIPOS_COM_DOWNLOAD.has(parsed.tipo)) {
      // Mídia antiga pode não existir mais no WhatsApp. Best-effort: se falhar,
      // a mensagem fica registrada com a mídia pendente, e isso é melhor que
      // perder a mensagem. Dentro do orçamento de tempo — passou, só grava.
      if (Date.now() - inicio < ORCAMENTO_MIDIA_MS) {
        try {
          await baixarESalvarMidia({
            funcao: FUNCAO,
            mensagemId: nova.id as string,
            atendimentoId: atendimento.id,
            clientId: pedido.client_id,
            zapiMessageId: preferido,
            urlOriginal: parsed.media_url,
            tipo: parsed.tipo,
            metaInicial: meta,
          });
        } catch (err) {
          log({
            funcao: FUNCAO,
            evento: "midia_historico_falhou",
            status: "erro",
            erro_msg: err instanceof Error ? err.message.slice(0, 140) : "falha_midia",
          });
        }
      }
    }
  }

  // Contadores do pedido: dá para acompanhar o progresso da importação sem
  // vasculhar log (as mensagens chegam em vários lotes, ao longo de horas).
  for (const [pedidoId, c] of contadores) {
    const { data: atual } = await supabase
      .from("historico_import_pedidos")
      .select("recebidas, inseridas")
      .eq("id", pedidoId)
      .maybeSingle();
    await supabase
      .from("historico_import_pedidos")
      .update({
        recebidas: ((atual?.recebidas as number | undefined) ?? 0) + c.recebidas,
        inseridas: ((atual?.inseridas as number | undefined) ?? 0) + c.inseridas,
      })
      .eq("id", pedidoId);
  }

  log({
    funcao: FUNCAO,
    evento: "historico_processado",
    status: "ok",
    duracao_ms: cron(),
    extra: { recebidas, inseridas, ignoradas, sem_pedido: semPedido, chats: pedidosPorChat.size },
  });

  // Sempre 200: a uazapi reenvia em erro, e reenviar histórico não conserta nada
  // (a dedupe já garante que nada duplica, mas o retry só gasta tempo).
  return jsonResponse({ ok: true, recebidas, inseridas, ignoradas, sem_pedido: semPedido });
});
