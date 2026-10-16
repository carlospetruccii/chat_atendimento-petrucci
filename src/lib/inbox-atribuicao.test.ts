import { describe, expect, test } from "vitest";
import type { InboxConversation } from "@/lib/inbox-queries";
import { aplicarAtribuicao } from "@/lib/inbox-atribuicao";

function conversa(over: Partial<InboxConversation> = {}): InboxConversation {
  return {
    id: "a1",
    clientId: "c1",
    clientNome: "Cliente",
    clientNumero: "5511999999999",
    clientFotoUrl: null,
    status: "em_triagem",
    departmentId: null,
    departmentNome: null,
    departmentCor: null,
    assignedTo: null,
    assignedNome: null,
    lastMessageAt: null,
    lastMessagePreview: null,
    unread: 0,
    ...over,
  };
}

describe("aplicarAtribuicao", () => {
  test("marca a conversa como em atendimento e atribuída a quem assumiu", () => {
    const lista = [conversa({ id: "a1" }), conversa({ id: "a2", clientId: "c2" })];

    const nova = aplicarAtribuicao(lista, "a1", { id: "u1", nome: "João" });

    expect(nova?.[0]).toMatchObject({
      status: "em_atendimento",
      assignedTo: "u1",
      assignedNome: "João",
    });
  });

  test("não mexe nas outras conversas", () => {
    const lista = [conversa({ id: "a1" }), conversa({ id: "a2", clientId: "c2" })];

    const nova = aplicarAtribuicao(lista, "a1", { id: "u1", nome: "João" });

    expect(nova?.[1]).toBe(lista[1]);
  });

  test("não muda a lista original", () => {
    const lista = [conversa({ id: "a1" })];

    aplicarAtribuicao(lista, "a1", { id: "u1", nome: "João" });

    expect(lista[0].assignedTo).toBeNull();
    expect(lista[0].status).toBe("em_triagem");
  });

  test("devolve a lista igual quando a conversa não está nela", () => {
    const lista = [conversa({ id: "a1" })];

    expect(aplicarAtribuicao(lista, "zzz", { id: "u1", nome: "João" })).toEqual(lista);
  });

  test("lista ausente vira undefined (cache ainda não carregou)", () => {
    expect(aplicarAtribuicao(undefined, "a1", { id: "u1", nome: "João" })).toBeUndefined();
  });
});
