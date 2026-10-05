import { describe, expect, test } from "vitest";
import { dedupeAndSort } from "./useChatHistory";
import type { InboxMessage } from "@/lib/inbox-queries";

function msg(id: string, createdAt: string, over: Partial<InboxMessage> = {}): InboxMessage {
  return {
    id,
    atendimentoId: "a1",
    direction: "outbound",
    senderType: "atendente",
    sentByUserId: "u1",
    sentByNome: "Fulano",
    tipo: "texto",
    content: "oi",
    mediaUrl: null,
    mediaMetadata: null,
    createdAt,
    replyToMessageId: null,
    otimizadoIa: null,
    contentOriginal: null,
    statusEnvio: "aguardando_envio",
    apagadaEm: null,
    editadaEm: null,
    temIdWhatsapp: false,
    ...over,
  };
}

/**
 * `dedupeAndSort` é o que sustenta a inserção otimista do envio: a tela pinta a
 * bolha assim que o banco devolve o id, e o eco do realtime chega DEPOIS com o
 * mesmo id. Se essa função duplicasse por id, toda mensagem enviada apareceria
 * duas vezes — que é justamente o modo de falhar que o fix poderia introduzir.
 */
describe("dedupeAndSort", () => {
  test("o eco do realtime não duplica a mensagem já pintada no envio", () => {
    const otimista = msg("m1", "2026-01-01T10:00:00Z");
    const ecoDoRealtime = msg("m1", "2026-01-01T10:00:00Z");

    const resultado = dedupeAndSort([otimista], [ecoDoRealtime]);

    expect(resultado).toHaveLength(1);
    expect(resultado[0].id).toBe("m1");
  });

  test("o eco mais novo substitui a versão otimista (status de envio avança)", () => {
    const otimista = msg("m1", "2026-01-01T10:00:00Z", { statusEnvio: "aguardando_envio" });
    const confirmada = msg("m1", "2026-01-01T10:00:00Z", { statusEnvio: "enviado" });

    const resultado = dedupeAndSort([otimista], [confirmada]);

    expect(resultado).toHaveLength(1);
    expect(resultado[0].statusEnvio).toBe("enviado");
  });

  test("mantém ordem cronológica ao intercalar mensagem nova", () => {
    const antiga = msg("m1", "2026-01-01T10:00:00Z");
    const nova = msg("m3", "2026-01-01T12:00:00Z");
    const doMeio = msg("m2", "2026-01-01T11:00:00Z");

    const resultado = dedupeAndSort([antiga, nova], [doMeio]);

    expect(resultado.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  test("lista vazia de entrada devolve a anterior intacta", () => {
    const anterior = [msg("m1", "2026-01-01T10:00:00Z")];
    expect(dedupeAndSort(anterior, [])).toBe(anterior);
  });
});
