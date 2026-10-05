// Edge Function: reprocessar-midia
// Tenta de novo o download de uma mídia que falhou ("Tentar novamente" na bolha).
//
// Contrato com o frontend:
//   POST { mensagem_id: uuid, escopo?: "individual" | "grupo" }
//     → 202 { ok: true }              (download rodando em background)
//     → 200 { ok: false, motivo }     (recusa de negócio: nada a reprocessar,
//                                      sem id da uazapi, tentativa recente)
//
// ASSÍNCRONO de propósito: a busca na uazapi pode levar dezenas de segundos num
// anexo grande (foi exatamente isso que quebrou o .rar). Segurar a requisição
// até o fim faria o navegador desistir antes. O resultado chega pela linha da
// mensagem via realtime, igual ao download que roda no webhook.

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";
import { exigirMembroAtivo } from "../_shared/empresa.ts";
import { baixarESalvarMidia, type EscopoMidia } from "../_shared/midia-mensagem.ts";
import { TIPOS_COM_DOWNLOAD, type TipoMensagem } from "../_shared/mensagem-uazapi.ts";
import { MAX_BYTES } from "../_shared/midia-download.ts";

const FUNCAO = "reprocessar-midia";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Rate limit: cada tentativa é uma ida à uazapi que pode durar um minuto. Sem
 * um intervalo mínimo, clicar repetido no botão (ou um script) enfileiraria
 * downloads do mesmo arquivo e derrubaria o limite da instância. O carimbo fica
 * na própria linha, então vale para todos os atendentes e entre isolates.
 */
const INTERVALO_MIN_MS = 30_000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function emBackground(tarefa: Promise<unknown>): void {
  const edge = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } })
    .EdgeRuntime;
  if (edge?.waitUntil) edge.waitUntil(tarefa);
  else tarefa.catch(() => {});
}

interface Payload {
  mensagem_id?: unknown;
  escopo?: unknown;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ ok: false, erro: "method_not_allowed" }, 405);

  const cron = iniciarCronometro();
  const supabase = getSupabaseAdmin();

  // 1) Quem está chamando.
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  if (!jwt) return jsonResponse({ ok: false, erro: "unauthorized" }, 401);

  const { data: userRes, error: errUser } = await supabase.auth.getUser(jwt);
  if (errUser || !userRes?.user) {
    return jsonResponse({ ok: false, erro: "unauthorized" }, 401);
  }
  const membro = await exigirMembroAtivo(supabase, userRes.user.id);
  if (!membro) return jsonResponse({ ok: false, erro: "forbidden" }, 403);

  // 2) Payload.
  let payload: Payload;
  try {
    payload = (await req.json()) as Payload;
  } catch {
    return jsonResponse({ ok: false, erro: "payload_invalido" }, 400);
  }

  const mensagemId = typeof payload.mensagem_id === "string" ? payload.mensagem_id.trim() : "";
  if (!UUID_RE.test(mensagemId)) {
    return jsonResponse(
      { ok: false, erro: "payload_invalido", detalhe: "mensagem_id inválido" },
      400,
    );
  }
  const escopo: EscopoMidia = payload.escopo === "grupo" ? "grupo" : "individual";

  // 3) A mensagem, sempre restrita à empresa de quem pediu.
  const tabela = escopo === "grupo" ? "grupo_mensagens" : "mensagens";
  const colunaDono = escopo === "grupo" ? "grupo_id" : "atendimento_id";
  const colunaZapi = escopo === "grupo" ? "uazapi_message_id" : "zapi_message_id";

  const { data: linha, error: errLinha } = await supabase
    .from(tabela)
    .select(`id, tipo, media_url, media_metadata, ${colunaDono}, ${colunaZapi}`)
    .eq("id", mensagemId)
    .eq("company_id", membro.companyId)
    .maybeSingle();

  if (errLinha) {
    log({
      funcao: FUNCAO,
      evento: "leitura_mensagem",
      status: "erro",
      mensagem_id: mensagemId,
      duracao_ms: cron(),
      erro_msg: errLinha.message,
    });
    return jsonResponse({ ok: false, erro: "erro_interno" }, 500);
  }
  if (!linha) return jsonResponse({ ok: false, erro: "nao_encontrada" }, 404);

  const registro = linha as unknown as Record<string, unknown>;
  const tipo = registro.tipo as TipoMensagem;
  const meta = (registro.media_metadata ?? {}) as Record<string, unknown>;
  const zapiMessageId = registro[colunaZapi] as string | null;
  const donoId = registro[colunaDono] as string | null;

  if (!TIPOS_COM_DOWNLOAD.has(tipo)) {
    return jsonResponse({ ok: false, motivo: "tipo_sem_download" });
  }
  if (typeof meta.storage_path === "string" && meta.storage_path) {
    // Já baixou (provavelmente outra aba reprocessou antes).
    return jsonResponse({ ok: false, motivo: "ja_disponivel" });
  }
  if (!zapiMessageId || !donoId) {
    return jsonResponse({ ok: false, motivo: "sem_referencia_whatsapp" });
  }
  // Recusa só o que AINDA não cabe: o teto já mudou uma vez, e comparar com o
  // valor atual deixa as mensagens antigas voltarem a ser baixáveis sozinhas.
  const bytesRegistrados = Number(meta.download_erro_bytes ?? 0);
  if (meta.download_erro_codigo === "grande_demais" && bytesRegistrados > MAX_BYTES) {
    return jsonResponse({ ok: false, motivo: "grande_demais" });
  }

  const ultima = typeof meta.download_tentativa_em === "string"
    ? Date.parse(meta.download_tentativa_em)
    : NaN;
  if (Number.isFinite(ultima) && Date.now() - ultima < INTERVALO_MIN_MS) {
    return jsonResponse({ ok: false, motivo: "tentativa_recente" });
  }

  // 4) Carimba a tentativa ANTES de disparar — é o que segura o clique repetido.
  const metaTentativa = { ...meta, download_tentativa_em: new Date().toISOString() };
  const { error: errCarimbo } = await supabase
    .from(tabela)
    .update({ media_metadata: metaTentativa })
    .eq("id", mensagemId);
  if (errCarimbo) {
    log({
      funcao: FUNCAO,
      evento: "carimbo_tentativa",
      status: "erro",
      mensagem_id: mensagemId,
      duracao_ms: cron(),
      erro_msg: errCarimbo.message,
    });
    return jsonResponse({ ok: false, erro: "erro_interno" }, 500);
  }

  log({
    funcao: FUNCAO,
    evento: "reprocesso_disparado",
    status: "ok",
    mensagem_id: mensagemId,
    duracao_ms: cron(),
    extra: { escopo, tipo },
  });

  emBackground(
    baixarESalvarMidia({
      funcao: FUNCAO,
      escopo,
      mensagemId,
      atendimentoId: donoId,
      zapiMessageId,
      urlOriginal: typeof meta.url_original_zapi === "string" &&
          /^https?:\/\//i.test(meta.url_original_zapi)
        ? meta.url_original_zapi
        : null,
      tipo,
      metaInicial: metaTentativa,
    }),
  );

  return jsonResponse({ ok: true }, 202);
});
