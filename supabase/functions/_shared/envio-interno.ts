// Avisos INTERNOS enviados por WhatsApp (repasse, alerta, notificação de cron).
//
// Eles saem pela mesma API que as mensagens de cliente, então o webhook recebe
// o eco deles também. Cinco pessoas da equipe existem em `clients`, e sem esta
// marcação o aviso "Novo atendimento pra você" viraria mensagem na conversa de
// cliente delas — permanentemente, porque `mensagens` não aceita DELETE.
//
// Quem envia registra o id aqui logo depois do envio; o webhook consulta antes
// de gravar. O corte é por MENSAGEM, não por número: documento que a
// contabilidade mandar para o mesmo colaborador continua aparecendo.

import { getSupabaseAdmin } from "./supabase-client.ts";
import { log } from "./logger.ts";
import { extrairMessageId } from "./uazapi-client.ts";

/**
 * Marca a resposta de um envio como aviso interno.
 *
 * Best-effort: se falhar, o pior caso é um aviso interno aparecer na conversa —
 * ruim, mas não justifica derrubar o envio da notificação, que já aconteceu.
 */
export async function registrarEnvioInterno(
  funcao: string,
  respostaUazapi: unknown,
): Promise<void> {
  const messageId = extrairMessageId(respostaUazapi);
  if (!messageId) return;
  try {
    const supabase = getSupabaseAdmin();
    await supabase
      .from("envios_internos_whatsapp")
      .upsert({ uazapi_message_id: messageId }, { onConflict: "uazapi_message_id" });
  } catch (err) {
    log({
      funcao,
      evento: "registrar_envio_interno_falhou",
      status: "erro",
      erro_msg: err instanceof Error ? err.message.slice(0, 140) : String(err),
    });
  }
}

/** O eco corresponde a um aviso interno que nós mandamos? */
export async function ehEnvioInterno(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  messageId: string | null,
): Promise<boolean> {
  if (!messageId) return false;
  const { data } = await supabase
    .from("envios_internos_whatsapp")
    .select("uazapi_message_id")
    .eq("uazapi_message_id", messageId)
    .maybeSingle();
  return !!data;
}
