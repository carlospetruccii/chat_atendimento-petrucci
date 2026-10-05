// Resposta automática do número financeiro (aba Docs): quando o cliente escreve,
// avisa que o número é só para envio de documentos e passa o do atendimento.
// Texto no template `docs_aviso_somente_documentos` (ativo = liga/desliga).
// No máximo 1 aviso a cada 3h por conversa, e nunca se a conversa tem dono.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { log } from "./logger.ts";
import { enviarTexto, extrairMessageId } from "./uazapi-client.ts";
import { gravarIdPosEnvio } from "./pos-envio.ts";
import { atualizacaoAposErroEnvio } from "./erro-envio.ts";
import { TRACK_SOURCE_DOCS } from "./docs-rastreio.ts";

export const CHAVE_TEMPLATE_AVISO = "docs_aviso_somente_documentos";
export const INTERVALO_AVISO_MS = 3 * 60 * 60 * 1000;
/** Depois de uma falha clara, espera isto antes de tentar de novo. */
export const ESPERA_APOS_FALHA_MS = 10 * 60 * 1000;

/**
 * Valor da trava depois de uma falha clara: "venceu" daqui a 10 min. Sem isto,
 * com o número fora do ar, cada mensagem do cliente geraria uma tentativa (e
 * uma linha de falha) nova.
 */
export function travaAposFalha(agoraMs: number): string {
  return new Date(agoraMs - INTERVALO_AVISO_MS + ESPERA_APOS_FALHA_MS).toISOString();
}

/** Instante (ISO) antes do qual o último aviso já "venceu". */
export function cortePorIntervalo(agoraMs: number): string {
  return new Date(agoraMs - INTERVALO_AVISO_MS).toISOString();
}

/** Com dono, alguém já está conversando com o cliente: aviso seria ruído. */
export function deveAvisar(status: string): boolean {
  return status !== "em_andamento";
}

/** Texto principal ou uma das variações, sorteado. null se nada utilizável. */
export function escolherVersao(
  texto: string,
  variacoes: readonly string[],
  aleatorio: () => number = Math.random,
): string | null {
  const versoes = [texto, ...variacoes].map((v) => v.trim()).filter((v) => v.length > 0);
  if (versoes.length === 0) return null;
  return versoes[Math.min(versoes.length - 1, Math.floor(aleatorio() * versoes.length))];
}

/**
 * Manda o aviso se for a hora. Best-effort: qualquer falha só loga — o webhook
 * já gravou a mensagem do cliente e isso não pode ser desfeito por um aviso.
 */
export async function avisarSeNecessario(params: {
  supabase: SupabaseClient;
  funcao: string;
  companyId: string;
  conversaId: string;
  telefone: string;
}): Promise<void> {
  const { supabase, funcao, companyId, conversaId, telefone } = params;

  const { data: tpl } = await supabase
    .from("templates_mensagem")
    .select("texto, variacoes")
    .eq("company_id", companyId)
    .eq("chave", CHAVE_TEMPLATE_AVISO)
    .eq("ativo", true)
    .maybeSingle();
  const texto = tpl
    ? escolherVersao(String(tpl.texto ?? ""), (tpl.variacoes as string[] | null) ?? [])
    : null;
  if (!texto) return;

  // Reserva atômica: só UMA das mensagens simultâneas passa daqui.
  const agora = new Date().toISOString();
  const { data: reservada } = await supabase
    .from("docs_conversas")
    .update({ ultimo_aviso_automatico_at: agora })
    .eq("id", conversaId)
    .neq("status", "em_andamento")
    .or(`ultimo_aviso_automatico_at.is.null,ultimo_aviso_automatico_at.lt.${cortePorIntervalo(Date.now())}`)
    .select("id");
  if (!reservada || reservada.length === 0) return;

  const { data: linha, error: errIns } = await supabase
    .from("docs_mensagens")
    .insert({
      company_id: companyId,
      conversa_id: conversaId,
      direction: "outbound",
      sender_type: "sistema",
      sent_by_user_id: null,
      tipo: "texto",
      content: texto,
      media_metadata: { kind: "aviso_automatico_docs" },
      status_envio: "enviando",
    })
    .select("id")
    .single();
  if (errIns || !linha) {
    log({ funcao, evento: "aviso_automatico_insert_falhou", status: "erro", erro_msg: errIns?.message });
    await supabase.from("docs_conversas").update({ ultimo_aviso_automatico_at: null }).eq("id", conversaId);
    return;
  }
  const mensagemId = linha.id as string;

  try {
    const resp = await enviarTexto({
      telefone,
      mensagem: texto,
      instancia: "financeiro",
      rastreio: { origem: TRACK_SOURCE_DOCS, id: mensagemId },
    });
    await gravarIdPosEnvio({
      supabase,
      tabela: "docs_mensagens",
      colunaMessageId: "uazapi_message_id",
      mensagemId,
      messageId: extrairMessageId(resp),
    });
    log({ funcao, evento: "aviso_automatico_enviado", status: "ok", mensagem_id: mensagemId });
  } catch (err) {
    const upd = atualizacaoAposErroEnvio(err, { kind: "aviso_automatico_docs" });
    await supabase.from("docs_mensagens").update(upd).eq("id", mensagemId);
    // Falha clara: nova tentativa em 10 min (não a cada mensagem). Incerto
    // (timeout): mantém as 3h — pode ter saído.
    if (upd.status_envio === "falha") {
      await supabase
        .from("docs_conversas")
        .update({ ultimo_aviso_automatico_at: travaAposFalha(Date.now()) })
        .eq("id", conversaId);
    }
    log({
      funcao,
      evento: "aviso_automatico_falhou",
      status: "erro",
      mensagem_id: mensagemId,
      erro_msg: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
  }
}
