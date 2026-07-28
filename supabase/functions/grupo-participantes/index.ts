// Edge Function: grupo-participantes
// Lista os participantes (número + nome, quando a uazapi souber) de um grupo.
//
// Contrato com o frontend:
//   POST { grupo_id }  → { ok: true, participantes: [{ numero, nome }] }
//
// Autorização: qualquer membro ativo da empresa dona do grupo — mesma regra de
// grupo-enviar/sincronizar-grupos (grupo não tem atribuição, é de todos).
//
// Sem persistência: busca direto na uazapi a cada chamada, então o painel de
// participantes sempre mostra quem está no grupo agora.

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";
import { participantesGrupo, statusInstancia, ZapiError } from "../_shared/uazapi-client.ts";
import { exigirMembroAtivo } from "../_shared/empresa.ts";

const FUNCAO = "grupo-participantes";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ ok: false, erro: "method_not_allowed" }, 405);

  const cron = iniciarCronometro();
  const supabase = getSupabaseAdmin();

  // 1) Autenticação.
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  if (!jwt) return jsonResponse({ ok: false, erro: "unauthorized" }, 401);
  const { data: userRes, error: errUser } = await supabase.auth.getUser(jwt);
  if (errUser || !userRes?.user) return jsonResponse({ ok: false, erro: "unauthorized" }, 401);
  const userId = userRes.user.id;

  // 2) Payload.
  let bruto: unknown;
  try {
    bruto = await req.json();
  } catch {
    return jsonResponse({ ok: false, erro: "payload_invalido" }, 400);
  }
  const grupoId = (bruto as { grupo_id?: unknown })?.grupo_id;
  if (typeof grupoId !== "string" || grupoId.trim() === "") {
    return jsonResponse({ ok: false, erro: "payload_invalido" }, 400);
  }

  // 3) Autorização: vínculo ativo em company_members + users.ativo.
  const membro = await exigirMembroAtivo(supabase, userId);
  if (!membro) {
    log({ funcao: FUNCAO, evento: "sem_vinculo_ativo", status: "erro", duracao_ms: cron() });
    return jsonResponse({ ok: false, erro: "forbidden" }, 403);
  }
  const companyId = membro.companyId;

  // 4) Grupo precisa existir e ser da mesma empresa.
  const { data: grupo, error: errGrupo } = await supabase
    .from("grupos")
    .select("id, company_id, wa_jid")
    .eq("id", grupoId)
    .maybeSingle();
  if (errGrupo) {
    log({
      funcao: FUNCAO,
      evento: "select_grupo_erro",
      status: "erro",
      erro_msg: errGrupo.message,
    });
    return jsonResponse({ ok: false, erro: "erro_interno" }, 500);
  }
  if (!grupo) return jsonResponse({ ok: false, erro: "grupo_nao_encontrado" }, 404);
  if (grupo.company_id !== companyId) return jsonResponse({ ok: false, erro: "forbidden" }, 403);

  try {
    const participantes = await participantesGrupo(grupo.wa_jid as string);

    // Marca qual participante é o nosso próprio número (a instância conectada),
    // pra UI mostrar "Você" em vez de um número solto. Best-effort: se o status
    // falhar, segue sem a marcação em vez de derrubar a lista de participantes.
    const meuNumero = await statusInstancia()
      .then((s) => s.numero ?? null)
      .catch(() => null);
    const comSouNos = participantes.map((p) => ({ ...p, souNos: p.numero === meuNumero }));

    log({
      funcao: FUNCAO,
      evento: "participantes_listados",
      status: "ok",
      duracao_ms: cron(),
      extra: { total: participantes.length, identificou_nosso_numero: meuNumero !== null },
    });
    return jsonResponse({ ok: true, participantes: comSouNos });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const ehUazapi = err instanceof ZapiError;
    log({
      funcao: FUNCAO,
      evento: ehUazapi ? "uazapi_erro" : "erro_inesperado",
      status: "erro",
      duracao_ms: cron(),
      erro_msg: msg.slice(0, 200),
    });
    return jsonResponse(
      {
        ok: false,
        erro: ehUazapi ? "uazapi_indisponivel" : "erro_interno",
        detalhe: ehUazapi ? "Não foi possível falar com o WhatsApp agora." : undefined,
      },
      ehUazapi ? 502 : 500,
    );
  }
});
