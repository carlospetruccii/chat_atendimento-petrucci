// Edge Function: notificar-repasse
// Avisa no WhatsApp PESSOAL do colaborador que um atendimento foi
// repassado/atribuído a ele. Chamada pelo frontend logo após um repasse
// (repassar_atendimento) ou atribuição de pendente (assign_pendente_a_usuario)
// concluir com sucesso.
//
// Contrato com o frontend:
//   POST { atendimento_id: string, to_user_id: string }
//
// Fluxo:
//  1. Valida JWT do usuário (quem repassou).
//  2. Confere que o atendimento existe e que `assigned_to` == to_user_id
//     (só notifica sobre um repasse REAL e vigente — evita spam/replay).
//  3. Confere que houve um evento de repasse/atribuição recente para esse
//     colaborador (janela de 2 min) — trava anti-abuso.
//  4. Busca o WhatsApp pessoal do colaborador. Sem número → no-op (skip).
//  5. Envia o aviso via uazapi. Falha no envio NÃO quebra o repasse.
//
// SECURITY: nunca envia para número arbitrário vindo do payload — o destino é
// sempre resolvido do cadastro do colaborador (users.whatsapp).

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";
import { enviarTexto } from "../_shared/uazapi-client.ts";

const FUNCAO = "notificar-repasse";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Janela em que um evento de repasse/atribuição é considerado "recente".
const JANELA_EVENTO_MS = 2 * 60 * 1000;

interface PayloadNotificacao {
  atendimento_id?: string;
  to_user_id?: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// Monta o texto do aviso. Pura para facilitar leitura/teste.
export function montarMensagem(params: {
  clienteNome: string;
  departamentoNome: string | null;
  atorNome: string | null;
  observacao: string | null;
  appUrl: string | null;
}): string {
  const linhas: string[] = ["🔔 Novo atendimento pra você"];
  const porQuem = params.atorNome ? ` por ${params.atorNome}` : "";
  linhas.push("");
  linhas.push(`*${params.clienteNome}* foi repassado(a) pra você${porQuem}.`);
  if (params.departamentoNome) linhas.push(`🏷️ ${params.departamentoNome}`);
  if (params.observacao) linhas.push(`📝 ${params.observacao}`);
  linhas.push("");
  linhas.push(
    params.appUrl
      ? `Abra o painel para atender: ${params.appUrl}`
      : "Abra o painel para atender.",
  );
  return linhas.join("\n");
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

  // 1) Autenticação: resolve o usuário a partir do JWT.
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";
  if (!jwt) {
    log({ funcao: FUNCAO, evento: "sem_token", status: "erro", duracao_ms: cron() });
    return jsonResponse({ ok: false, erro: "unauthorized" }, 401);
  }

  const { data: userRes, error: errUser } = await supabase.auth.getUser(jwt);
  if (errUser || !userRes?.user) {
    log({
      funcao: FUNCAO,
      evento: "token_invalido",
      status: "erro",
      duracao_ms: cron(),
      erro_msg: errUser?.message,
    });
    return jsonResponse({ ok: false, erro: "unauthorized" }, 401);
  }
  const callerId = userRes.user.id;

  // 2) Parse do payload.
  let payload: PayloadNotificacao;
  try {
    payload = (await req.json()) as PayloadNotificacao;
  } catch {
    return jsonResponse({ ok: false, erro: "payload_invalido" }, 400);
  }
  const atendimentoId = payload.atendimento_id?.trim();
  const toUserId = payload.to_user_id?.trim();
  if (!atendimentoId || !toUserId) {
    return jsonResponse(
      { ok: false, erro: "campos_obrigatorios", detalhe: "atendimento_id e to_user_id são obrigatórios" },
      400,
    );
  }

  // Não faz sentido avisar a si mesmo (ex.: auto-assumir um pendente).
  if (toUserId === callerId) {
    return jsonResponse({ ok: true, skipped: "auto_atribuicao" });
  }

  // 3) Carrega o atendimento + nome do cliente + departamento atual.
  const { data: atend, error: errAtend } = await supabase
    .from("atendimentos")
    .select(
      "id, assigned_to, current_department_id, clients:client_id(nome, numero_whatsapp), departments:current_department_id(nome)",
    )
    .eq("id", atendimentoId)
    .maybeSingle();

  if (errAtend) {
    log({
      funcao: FUNCAO,
      evento: "leitura_atendimento",
      status: "erro",
      atendimento_id: atendimentoId,
      duracao_ms: cron(),
      erro_msg: errAtend.message,
    });
    return jsonResponse({ ok: false, erro: "erro_interno" }, 500);
  }
  // Respostas de "não enviado" são sempre genéricas ({ ok: true }) para não
  // servirem de oráculo de enumeração; o motivo real vai só para o log interno.
  const skip = (motivo: string): Response => {
    log({
      funcao: FUNCAO,
      evento: motivo,
      status: "ok",
      atendimento_id: atendimentoId,
      duracao_ms: cron(),
    });
    return jsonResponse({ ok: true });
  };

  if (!atend) return skip("atendimento_nao_encontrado");

  // Anti-abuso: só notifica se o colaborador realmente detém o atendimento agora.
  if (atend.assigned_to !== toUserId) return skip("assigned_to_divergente");

  // Anti-abuso: exige um evento de repasse/atribuição recente cujo AUTOR seja o
  // próprio chamador — só quem realmente fez o repasse pode disparar o aviso.
  const desdeIso = new Date(Date.now() - JANELA_EVENTO_MS).toISOString();
  const { data: evento } = await supabase
    .from("timeline_events")
    .select("id, payload")
    .eq("atendimento_id", atendimentoId)
    .eq("target_user_id", toUserId)
    .eq("actor_user_id", callerId)
    .in("tipo_evento", ["repassado", "reservado"])
    .gte("created_at", desdeIso)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!evento) return skip("sem_evento_recente");

  // 4) WhatsApp pessoal do colaborador. Sem número → no-op.
  const { data: destino, error: errDestino } = await supabase
    .from("users")
    .select("nome, whatsapp, ativo, is_system_user")
    .eq("id", toUserId)
    .maybeSingle();

  if (errDestino) return jsonResponse({ ok: false, erro: "erro_interno" }, 500);
  if (!destino || destino.ativo === false || destino.is_system_user === true) {
    return skip("destino_invalido");
  }
  const numeroDestino = (destino.whatsapp ?? "").replace(/\D/g, "");
  if (!numeroDestino) return skip("destino_sem_whatsapp");

  // Idempotência/anti-spam: reivindica o evento com um claim atômico. Só quem
  // marca `notificacao_repasse_enviada_at` (NULL → agora) segue e envia; chamadas
  // repetidas do mesmo evento caem aqui e param (no máximo 1 aviso por evento).
  const { data: claimed } = await supabase
    .from("timeline_events")
    .update({ notificacao_repasse_enviada_at: new Date().toISOString() })
    .eq("id", (evento as { id: string }).id)
    .is("notificacao_repasse_enviada_at", null)
    .select("id")
    .maybeSingle();

  if (!claimed) return skip("ja_notificado");

  // Nome de quem repassou (= o próprio chamador, já validado como autor do evento).
  const { data: ator } = await supabase
    .from("users")
    .select("nome")
    .eq("id", callerId)
    .maybeSingle();

  const cliente = (atend as { clients?: { nome?: string | null; numero_whatsapp?: string } }).clients;
  const departamento = (atend as { departments?: { nome?: string | null } }).departments;
  const clienteNome = cliente?.nome?.trim() || cliente?.numero_whatsapp || "Cliente";

  const payloadEvento = (evento as { payload?: { observacao?: unknown } | null }).payload;
  const observacao = typeof payloadEvento?.observacao === "string" && payloadEvento.observacao.trim()
    ? payloadEvento.observacao.trim()
    : null;

  const mensagem = montarMensagem({
    clienteNome,
    departamentoNome: departamento?.nome?.trim() || null,
    atorNome: ator?.nome?.trim() || null,
    observacao,
    appUrl: Deno.env.get("APP_URL")?.trim() || null,
  });

  // 5) Envio em background — o aviso não pode segurar/quebrar o repasse.
  const tarefa = (async () => {
    const t = iniciarCronometro();
    try {
      await enviarTexto({ telefone: numeroDestino, mensagem });
      log({
        funcao: FUNCAO,
        evento: "aviso_enviado",
        status: "ok",
        atendimento_id: atendimentoId,
        duracao_ms: t(),
      });
    } catch (err) {
      log({
        funcao: FUNCAO,
        evento: "aviso_falha",
        status: "erro",
        atendimento_id: atendimentoId,
        duracao_ms: t(),
        erro_msg: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  const edge = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } })
    .EdgeRuntime;
  if (edge?.waitUntil) edge.waitUntil(tarefa);
  else tarefa.catch(() => {});

  return jsonResponse({ ok: true, notificado: true });
});
