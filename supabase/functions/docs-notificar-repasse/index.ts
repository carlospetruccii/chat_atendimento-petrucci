// Edge Function: docs-notificar-repasse
// Avisa no WhatsApp PESSOAL do colaborador que uma conversa da aba Docs foi
// repassada a ele. Mesmo aviso da Inbox (montarMensagem), saindo pelo número
// PRINCIPAL — é mensagem interna da empresa, não do financeiro.
//
// Contrato: POST { conversa_id, to_user_id } (JWT de quem repassou) → { ok }
// Chamado pela tela logo depois de `docs_repassar` dar certo. Best-effort: o
// repasse já aconteceu; falhar aqui não desfaz nada.
//
// SECURITY: o destino vem SEMPRE do cadastro (users.whatsapp), nunca do corpo.
// Só avisa se existir um evento 'repassada' recente, do próprio chamador para
// esse destino, ainda não avisado (claim atômico em docs_eventos.notificado_em).

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";
import { enviarTexto, extrairMessageId } from "../_shared/uazapi-client.ts";
import { montarMensagem } from "../_shared/formato.ts";
import { exigirAcessoDocs, usuarioDoJwt } from "../_shared/docs-acesso.ts";
import { numeroCanonicoWhatsapp } from "../_shared/telefone-whatsapp.ts";

const FUNCAO = "docs-notificar-repasse";
const JANELA_EVENTO_MS = 2 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const callerId = await usuarioDoJwt(supabase, req);
  if (!callerId) return jsonResponse({ ok: false, erro: "unauthorized" }, 401);

  let body: { conversa_id?: unknown; to_user_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, erro: "payload_invalido" }, 400);
  }
  const conversaId = typeof body.conversa_id === "string" ? body.conversa_id.trim() : "";
  const toUserId = typeof body.to_user_id === "string" ? body.to_user_id.trim() : "";
  if (!UUID.test(conversaId) || !UUID.test(toUserId)) {
    return jsonResponse({ ok: false, erro: "campos_obrigatorios" }, 400);
  }

  const membro = await exigirAcessoDocs(supabase, callerId);
  if (!membro) return jsonResponse({ ok: false, erro: "forbidden" }, 403);

  const pular = (motivo: string): Response => {
    log({ funcao: FUNCAO, evento: motivo, status: "ok", duracao_ms: cron() });
    return jsonResponse({ ok: true, pulado: motivo });
  };
  if (toUserId === callerId) return pular("auto_atribuicao");

  const { data: conversa } = await supabase
    .from("docs_conversas")
    .select("id, company_id, assigned_to, clients!inner(nome, numero_whatsapp)")
    .eq("id", conversaId)
    .eq("company_id", membro.companyId)
    .maybeSingle();
  if (!conversa) return pular("conversa_nao_encontrada");
  if (conversa.assigned_to !== toUserId) return pular("assigned_to_divergente");

  const desde = new Date(Date.now() - JANELA_EVENTO_MS).toISOString();
  const { data: evento } = await supabase
    .from("docs_eventos")
    .select("id, observacao")
    .eq("conversa_id", conversaId)
    .eq("tipo", "repassada")
    .eq("actor_user_id", callerId)
    .eq("target_user_id", toUserId)
    .is("notificado_em", null)
    .gte("created_at", desde)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!evento) return pular("sem_evento_recente");

  const { data: destino } = await supabase
    .from("users")
    .select("whatsapp, ativo, is_system_user")
    .eq("id", toUserId)
    .maybeSingle();
  if (!destino || destino.ativo === false || destino.is_system_user === true) {
    return pular("destino_invalido");
  }
  const numeroDestino = (destino.whatsapp ?? "").replace(/\D/g, "");
  if (!numeroDestino) return pular("destino_sem_whatsapp");

  // Claim: quem marcar primeiro envia.
  const { data: claim } = await supabase
    .from("docs_eventos")
    .update({ notificado_em: new Date().toISOString() })
    .eq("id", evento.id)
    .is("notificado_em", null)
    .select("id");
  if (!claim || claim.length === 0) return pular("ja_notificado");

  const { data: ator } = await supabase.from("users").select("nome").eq("id", callerId).maybeSingle();
  const cli = (Array.isArray(conversa.clients) ? conversa.clients[0] : conversa.clients) as
    | { nome?: string | null; numero_whatsapp?: string }
    | null;
  const mensagem = montarMensagem({
    clienteNome: cli?.nome?.trim() || cli?.numero_whatsapp || "Cliente",
    departamentoNome: "Docs (número financeiro)",
    atorNome: ator?.nome?.trim() || null,
    observacao: typeof evento.observacao === "string" ? evento.observacao : null,
    appUrl: Deno.env.get("APP_URL")?.trim() || null,
  });

  try {
    const resp = await enviarTexto({ telefone: numeroDestino, mensagem });
    // Aviso interno: o webhook principal não pode gravar o eco disso na
    // conversa do colaborador (5 deles também são clientes). Mesmo registro do
    // `registrarEnvioInterno` da Inbox: id + destino canônico (o destino é o
    // que faz a resposta digitada ao aviso ser reconhecida como tal).
    //
    // Não usa o helper direto porque a coluna `destino_numero` vem de uma
    // migration ainda não aplicada em produção (20260910120000): sem a coluna,
    // grava só o id — que é o que o webhook de hoje consulta.
    const id = extrairMessageId(resp);
    if (id) {
      const e164 = `+${numeroDestino}`;
      const destino = numeroCanonicoWhatsapp(e164) ?? e164;
      let { error } = await supabase
        .from("envios_internos_whatsapp")
        .upsert({ uazapi_message_id: id, destino_numero: destino }, {
          onConflict: "uazapi_message_id",
        });
      if (error && (error.code === "42703" || error.code === "PGRST204")) {
        ({ error } = await supabase
          .from("envios_internos_whatsapp")
          .upsert({ uazapi_message_id: id }, { onConflict: "uazapi_message_id" }));
      }
      if (error) {
        log({
          funcao: FUNCAO,
          evento: "registro_envio_interno_falhou",
          status: "erro",
          erro_msg: error.message,
        });
      }
    }
    log({ funcao: FUNCAO, evento: "aviso_enviado", status: "ok", duracao_ms: cron() });
    return jsonResponse({ ok: true });
  } catch (err) {
    // Solta o claim para uma nova tentativa poder avisar.
    await supabase.from("docs_eventos").update({ notificado_em: null }).eq("id", evento.id);
    log({
      funcao: FUNCAO,
      evento: "aviso_falhou",
      status: "erro",
      duracao_ms: cron(),
      erro_msg: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    return jsonResponse({ ok: false, erro: "falha_envio" });
  }
});
