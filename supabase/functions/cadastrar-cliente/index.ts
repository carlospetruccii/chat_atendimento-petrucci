// Edge Function: cadastrar-cliente
// Cria/atualiza clientes em modo single ou csv_batch.
// Auth: JWT obrigatório, exige is_superadmin OR has_permission('view_all_departments').
// UPSERT por numero_whatsapp (telefone existente => sobrescreve nome).

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";

const FUNCAO = "cadastrar-cliente";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const E164 = /^\+[1-9][0-9]{7,14}$/;

interface LinhaIn {
  nome?: string;
  telefone?: string;
}
interface PayloadSingle {
  modo: "single";
  nome: string;
  telefone: string;
}
interface PayloadBatch {
  modo: "csv_batch";
  linhas: LinhaIn[];
}
type Payload = PayloadSingle | PayloadBatch;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function normalizarTelefone(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  // Remove tudo que não for dígito ou +.
  const limpo = trimmed.replace(/[^\d+]/g, "");
  let comPais = limpo;
  if (!comPais.startsWith("+")) {
    // Se já começa com 55 e tem 12-13 dígitos, prefixa +; senão prefixa +55.
    if (/^55\d{10,11}$/.test(comPais)) {
      comPais = "+" + comPais;
    } else {
      comPais = "+55" + comPais;
    }
  }
  return E164.test(comPais) ? comPais : null;
}

function nomeValido(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  return trimmed.length >= 2 ? trimmed : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, erro: "method_not_allowed" }, 405);

  const cron = iniciarCronometro();
  const supabase = getSupabaseAdmin();

  // Auth
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  if (!jwt) return json({ ok: false, erro: "unauthorized" }, 401);

  const { data: userRes, error: errUser } = await supabase.auth.getUser(jwt);
  if (errUser || !userRes?.user) return json({ ok: false, erro: "unauthorized" }, 401);
  const userId = userRes.user.id;

  // Permissão: superadmin OU view_all_departments OU flag clientes_visivel_para_todos = true
  const [{ data: userRow }, { data: permRow }, { data: flagRow }] = await Promise.all([
    supabase.from("users").select("is_superadmin").eq("id", userId).maybeSingle(),
    supabase
      .from("user_permissions")
      .select("permission")
      .eq("user_id", userId)
      .eq("permission", "view_all_departments")
      .maybeSingle(),
    supabase
      .from("system_config")
      .select("valor")
      .eq("chave", "clientes_visivel_para_todos")
      .maybeSingle(),
  ]);
  const visivelParaTodos = flagRow?.valor === "true";
  if (!userRow?.is_superadmin && !permRow && !visivelParaTodos) {
    log({ funcao: FUNCAO, evento: "forbidden", status: "erro", duracao_ms: cron() });
    return json({ ok: false, erro: "forbidden" }, 403);
  }

  let payload: Payload;
  try {
    payload = (await req.json()) as Payload;
  } catch {
    return json({ ok: false, erro: "payload_invalido" }, 400);
  }

  // Modo single
  if (payload.modo === "single") {
    const nome = nomeValido(payload.nome);
    const telefone = normalizarTelefone(payload.telefone);
    if (!nome) return json({ ok: false, erro: "nome_invalido", detalhe: "Nome deve ter ao menos 2 caracteres" }, 400);
    if (!telefone) {
      return json(
        { ok: false, erro: "telefone_invalido", detalhe: "Telefone fora do padrão E.164" },
        400,
      );
    }

    // Checa se já existe (para informar nome anterior).
    const { data: existente } = await supabase
      .from("clients")
      .select("id, nome")
      .eq("numero_whatsapp", telefone)
      .maybeSingle();

    const { data: up, error: errUp } = await supabase
      .from("clients")
      .upsert(
        { nome, numero_whatsapp: telefone, updated_at: new Date().toISOString() },
        { onConflict: "numero_whatsapp" },
      )
      .select("id, nome, numero_whatsapp")
      .single();

    if (errUp) {
      log({ funcao: FUNCAO, evento: "upsert_single_erro", status: "erro", duracao_ms: cron(), erro_msg: errUp.message });
      return json({ ok: false, erro: "erro_interno", detalhe: errUp.message }, 500);
    }

    log({ funcao: FUNCAO, evento: "upsert_single_ok", status: "ok", duracao_ms: cron(), client_id: up.id });
    return json({
      ok: true,
      criado: !existente,
      atualizado: !!existente,
      cliente: up,
      nome_anterior: existente?.nome ?? null,
    });
  }

  // Modo csv_batch
  if (payload.modo === "csv_batch") {
    const linhas = Array.isArray(payload.linhas) ? payload.linhas : [];
    if (linhas.length === 0) return json({ ok: false, erro: "linhas_vazias" }, 400);
    if (linhas.length > 5000) return json({ ok: false, erro: "limite_excedido", detalhe: "Máximo 5000 linhas por importação" }, 400);

    interface ErroLinha {
      linha: number;
      motivo: string;
      nome?: string;
      telefone?: string;
    }
    const erros: ErroLinha[] = [];
    const validosPorTelefone = new Map<string, { nome: string; telefone: string }>();

    linhas.forEach((l, idx) => {
      const numLinha = idx + 2; // header é linha 1
      const nome = nomeValido(l?.nome);
      const telefone = normalizarTelefone(l?.telefone);
      if (!nome) {
        erros.push({ linha: numLinha, motivo: "nome inválido", nome: l?.nome, telefone: l?.telefone });
        return;
      }
      if (!telefone) {
        erros.push({ linha: numLinha, motivo: "telefone inválido", nome: l?.nome, telefone: l?.telefone });
        return;
      }
      // Última ocorrência ganha
      validosPorTelefone.set(telefone, { nome, telefone });
    });

    const validos = Array.from(validosPorTelefone.values());

    // Checa quais já existem
    let existentes = new Set<string>();
    if (validos.length > 0) {
      const tels = validos.map((v) => v.telefone);
      const { data: jaTem, error: errSel } = await supabase
        .from("clients")
        .select("numero_whatsapp")
        .in("numero_whatsapp", tels);
      if (errSel) {
        log({ funcao: FUNCAO, evento: "select_existentes_erro", status: "erro", duracao_ms: cron(), erro_msg: errSel.message });
        return json({ ok: false, erro: "erro_interno", detalhe: errSel.message }, 500);
      }
      existentes = new Set((jaTem ?? []).map((r) => r.numero_whatsapp as string));
    }

    let criados = 0;
    let atualizados = 0;

    if (validos.length > 0) {
      const now = new Date().toISOString();
      const rows = validos.map((v) => ({
        nome: v.nome,
        numero_whatsapp: v.telefone,
        updated_at: now,
      }));
      const { error: errUp } = await supabase
        .from("clients")
        .upsert(rows, { onConflict: "numero_whatsapp" });
      if (errUp) {
        log({ funcao: FUNCAO, evento: "upsert_batch_erro", status: "erro", duracao_ms: cron(), erro_msg: errUp.message });
        return json({ ok: false, erro: "erro_interno", detalhe: errUp.message }, 500);
      }
      for (const v of validos) {
        if (existentes.has(v.telefone)) atualizados++;
        else criados++;
      }
    }

    // Audit log
    await supabase.from("config_audit_log").insert({
      user_id: userId,
      entidade: "clients",
      entidade_id: "importacao_csv_em_massa",
      campo: "csv_upload",
      valor_anterior: null,
      valor_novo: JSON.stringify({
        total: linhas.length,
        criados,
        atualizados,
        erros: erros.length,
        timestamp: new Date().toISOString(),
      }),
    });

    log({
      funcao: FUNCAO,
      evento: "csv_batch_ok",
      status: "ok",
      duracao_ms: cron(),
      extra: { total: linhas.length, criados, atualizados, erros: erros.length },
    });

    return json({
      ok: true,
      total: linhas.length,
      criados,
      atualizados,
      erros,
    });
  }

  return json({ ok: false, erro: "modo_invalido" }, 400);
});
