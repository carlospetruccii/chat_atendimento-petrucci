// Edge Function: atualizar-fotos
//
// Puxa/renova a foto de perfil de clientes e grupos cuja foto nunca foi
// buscada ou passou do TTL (o link do WhatsApp expira). O webhook já renova a
// foto de quem manda mensagem; esta função cobre quem está parado — e a carga
// inicial, quando os clientes já existiam antes da feature.
//
// Chamada pelo pg_cron (job `atualizar-fotos`), no mesmo padrão dos outros
// crons: verify_jwt + chave pública. Não recebe input que mude o alvo — só
// trabalha nos registros vencidos, em lote limitado — então chamar de fora no
// máximo antecipa uma renovação que já ia acontecer.
//
// Contrato: POST {} → { ok, processados, tem_mais }

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";
import { FOTO_TTL_MS } from "../_shared/foto-perfil.ts";
import { atualizarFotoPerfil } from "../_shared/foto-perfil-sync.ts";

const FUNCAO = "atualizar-fotos";
const LOTE_POR_TABELA = 60;
const CONCORRENCIA = 5;
// Folga para o limite de tempo da Edge Function (~150s): um lote iniciado no
// limite ainda pode levar 2 × 60s (foto de grupo). O que faltar sai no próximo cron.
const PRAZO_MS = 20_000;

type Tabela = "clients" | "grupos";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function vencidos(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  tabela: Tabela,
): Promise<string[]> {
  const corte = new Date(Date.now() - FOTO_TTL_MS).toISOString();
  let q = supabase
    .from(tabela)
    .select("id")
    .or(`foto_atualizada_em.is.null,foto_atualizada_em.lt.${corte}`)
    .order("foto_atualizada_em", { ascending: true, nullsFirst: true })
    .limit(LOTE_POR_TABELA);
  if (tabela === "grupos") q = q.eq("ativo", true);
  const { data, error } = await q;
  if (error) throw new Error(`select_${tabela}: ${error.message}`);
  return ((data ?? []) as { id: string }[]).map((r) => r.id);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return jsonResponse({ ok: false, erro: "method_not_allowed" }, 405);

  const cron = iniciarCronometro();
  const inicio = Date.now();
  const supabase = getSupabaseAdmin();

  try {
    const alvos: { tabela: Tabela; id: string }[] = [
      ...(await vencidos(supabase, "clients")).map((id) => ({ tabela: "clients" as const, id })),
      ...(await vencidos(supabase, "grupos")).map((id) => ({ tabela: "grupos" as const, id })),
    ];

    let processados = 0;
    for (let i = 0; i < alvos.length; i += CONCORRENCIA) {
      if (Date.now() - inicio > PRAZO_MS) break;
      const fatia = alvos.slice(i, i + CONCORRENCIA);
      await Promise.all(
        fatia.map((a) => atualizarFotoPerfil(supabase, { ...a, urlConhecida: null }, FUNCAO)),
      );
      processados += fatia.length;
    }

    const temMais = processados < alvos.length || alvos.length >= LOTE_POR_TABELA;
    log({
      funcao: FUNCAO,
      evento: "fotos_atualizadas",
      status: "ok",
      duracao_ms: cron(),
      extra: { processados, alvos: alvos.length },
    });
    return jsonResponse({ ok: true, processados, tem_mais: temMais });
  } catch (err) {
    log({
      funcao: FUNCAO,
      evento: "erro_inesperado",
      status: "erro",
      duracao_ms: cron(),
      erro_msg: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    return jsonResponse({ ok: false, erro: "erro_interno" }, 500);
  }
});
