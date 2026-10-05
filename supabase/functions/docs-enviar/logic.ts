// Validação pura do envio da aba Docs. As regras de formato (tamanho, tipos,
// legenda, áudio sem legenda) são EXATAMENTE as do envio para grupo — reaproveita
// a validação de lá em vez de duplicar, e só troca o identificador do destino.
// A outra regra do Docs (só o dono escreve) depende do banco: fica no index.

import {
  type EnvioValidado as EnvioGrupoValidado,
  type PayloadEnvioGrupo,
  validarEnvioGrupo,
} from "../grupo-enviar/logic.ts";

export {
  deduzirExtensao,
  MAX_BYTES_ANEXO,
  TIPO_MENSAGEM_POR_ENVIO,
  type TipoEnvioGrupo as TipoEnvioDocs,
} from "../grupo-enviar/logic.ts";

export interface PayloadEnvioDocs extends Omit<PayloadEnvioGrupo, "grupo_id"> {
  conversa_id?: unknown;
}

export interface EnvioDocsValidado extends Omit<EnvioGrupoValidado, "grupoId"> {
  conversaId: string;
}

export type ResultadoValidacaoDocs =
  | { ok: true; envio: EnvioDocsValidado }
  | { ok: false; erro: string; status: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validarEnvioDocs(p: PayloadEnvioDocs): ResultadoValidacaoDocs {
  // Id torto viraria 22P02 do banco (500); é pedido malformado (400).
  if (typeof p.conversa_id === "string" && p.conversa_id.trim() && !UUID.test(p.conversa_id.trim())) {
    return { ok: false, erro: "conversa_id_invalido", status: 400 };
  }
  if (
    typeof p.reply_to_message_id === "string" && p.reply_to_message_id.trim() &&
    !UUID.test(p.reply_to_message_id.trim())
  ) {
    return { ok: false, erro: "reply_invalido", status: 400 };
  }
  const r = validarEnvioGrupo({ ...p, grupo_id: p.conversa_id });
  if (!r.ok) {
    return {
      ok: false,
      erro: r.erro === "grupo_id_obrigatorio" ? "conversa_id_obrigatorio" : r.erro,
      status: r.status,
    };
  }
  const { grupoId, ...resto } = r.envio;
  return { ok: true, envio: { ...resto, conversaId: grupoId } };
}

/** Só o dono de uma conversa em andamento escreve (decisão de produto). */
export function podeEscrever(
  conversa: { status: string; assigned_to: string | null },
  userId: string,
): boolean {
  return conversa.status === "em_andamento" && conversa.assigned_to === userId;
}
