// Validação pura dos pedidos da função docs-acao (testada em logic.test.ts).

export const MAX_IDS_APAGAR = 10;
export const MAX_CHARS_EDICAO = 4096;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PedidoAcao =
  | { acao: "apagar"; mensagemIds: string[] }
  | { acao: "editar"; mensagemId: string; texto: string }
  | { acao: "encaminhar"; mensagemId: string; conversaIdDestino: string }
  | { acao: "reprocessar_midia"; mensagemId: string }
  | { acao: "marcar_lido"; conversaId: string };

export type ResultadoPedido =
  | { ok: true; pedido: PedidoAcao }
  | { ok: false; erro: string };

function uuid(v: unknown): string | null {
  return typeof v === "string" && UUID.test(v.trim()) ? v.trim().toLowerCase() : null;
}

export function validarPedidoAcao(p: Record<string, unknown>): ResultadoPedido {
  switch (p.acao) {
    case "apagar": {
      if (!Array.isArray(p.mensagem_ids)) return { ok: false, erro: "mensagem_ids_obrigatorio" };
      const ids = p.mensagem_ids.map(uuid);
      if (ids.some((i) => i === null)) return { ok: false, erro: "mensagem_id_invalido" };
      const unicos = [...new Set(ids as string[])];
      if (unicos.length === 0) return { ok: false, erro: "mensagem_ids_obrigatorio" };
      if (unicos.length > MAX_IDS_APAGAR) return { ok: false, erro: "muitas_mensagens" };
      return { ok: true, pedido: { acao: "apagar", mensagemIds: unicos } };
    }
    case "editar": {
      const mensagemId = uuid(p.mensagem_id);
      if (!mensagemId) return { ok: false, erro: "mensagem_id_invalido" };
      const texto = typeof p.texto === "string" ? p.texto.trim() : "";
      if (!texto) return { ok: false, erro: "texto_vazio" };
      if (texto.length > MAX_CHARS_EDICAO) return { ok: false, erro: "texto_muito_longo" };
      return { ok: true, pedido: { acao: "editar", mensagemId, texto } };
    }
    case "encaminhar": {
      const mensagemId = uuid(p.mensagem_id);
      const conversaIdDestino = uuid(p.conversa_id_destino);
      if (!mensagemId || !conversaIdDestino) return { ok: false, erro: "parametros_invalidos" };
      return { ok: true, pedido: { acao: "encaminhar", mensagemId, conversaIdDestino } };
    }
    case "reprocessar_midia": {
      const mensagemId = uuid(p.mensagem_id);
      if (!mensagemId) return { ok: false, erro: "mensagem_id_invalido" };
      return { ok: true, pedido: { acao: "reprocessar_midia", mensagemId } };
    }
    case "marcar_lido": {
      const conversaId = uuid(p.conversa_id);
      if (!conversaId) return { ok: false, erro: "conversa_id_invalido" };
      return { ok: true, pedido: { acao: "marcar_lido", conversaId } };
    }
    default:
      return { ok: false, erro: "acao_invalida" };
  }
}

/** Mexer no que já foi enviado: o dono da conversa em andamento, ou admin. */
export function ehDonoOuAdmin(
  conversa: { status: string; assigned_to: string | null },
  userId: string,
  isSuperadmin: boolean,
): boolean {
  if (isSuperadmin) return true;
  return conversa.status === "em_andamento" && conversa.assigned_to === userId;
}
