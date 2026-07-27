import { describe, expect, test } from "vitest";
import { agruparMensagensGrupo, autorDaMensagem, corDoParticipante } from "./grupos-history";
import type { GrupoMessage } from "./grupos-queries";

function msg(over: Partial<GrupoMessage> & { id: string; createdAt: string }): GrupoMessage {
  return {
    grupoId: "g1",
    direction: "inbound",
    senderType: "participante",
    sentByUserId: null,
    sentByNome: null,
    participanteNumero: "+5511999998888",
    participanteNome: "Maria",
    tipo: "texto",
    content: "oi",
    mediaUrl: null,
    mediaMetadata: null,
    statusEnvio: "enviado",
    statusWhatsapp: null,
    replyToMessageId: null,
    ...over,
  };
}

describe("agruparMensagensGrupo", () => {
  test("lista vazia não gera itens", () => {
    expect(agruparMensagensGrupo([])).toEqual([]);
  });

  test("emite um separador de dia antes da primeira mensagem", () => {
    const itens = agruparMensagensGrupo([msg({ id: "m1", createdAt: "2026-07-27T13:00:00Z" })]);
    expect(itens[0].kind).toBe("date-separator");
    expect(itens[1].kind).toBe("message");
  });

  test("mensagens do mesmo dia compartilham um separador", () => {
    const itens = agruparMensagensGrupo([
      msg({ id: "m1", createdAt: "2026-07-27T13:00:00Z" }),
      msg({ id: "m2", createdAt: "2026-07-27T14:00:00Z" }),
    ]);
    expect(itens.filter((i) => i.kind === "date-separator")).toHaveLength(1);
  });

  test("dia novo gera separador novo", () => {
    const itens = agruparMensagensGrupo([
      msg({ id: "m1", createdAt: "2026-07-26T13:00:00Z" }),
      msg({ id: "m2", createdAt: "2026-07-27T14:00:00Z" }),
    ]);
    expect(itens.filter((i) => i.kind === "date-separator")).toHaveLength(2);
  });

  test("mesmo participante em sequência: só o primeiro mostra o nome", () => {
    const itens = agruparMensagensGrupo([
      msg({ id: "m1", createdAt: "2026-07-27T13:00:00Z" }),
      msg({ id: "m2", createdAt: "2026-07-27T13:01:00Z" }),
    ]);
    const msgs = itens.filter((i) => i.kind === "message");
    expect(msgs[0]).toMatchObject({ mostrarAutor: true, colada: false });
    expect(msgs[1]).toMatchObject({ mostrarAutor: false, colada: true });
  });

  test("participante diferente reabre o bloco de autor", () => {
    const itens = agruparMensagensGrupo([
      msg({ id: "m1", createdAt: "2026-07-27T13:00:00Z" }),
      msg({
        id: "m2",
        createdAt: "2026-07-27T13:01:00Z",
        participanteNumero: "+5511911112222",
        participanteNome: "José",
      }),
    ]);
    const msgs = itens.filter((i) => i.kind === "message");
    expect(msgs[1]).toMatchObject({ mostrarAutor: true, colada: false });
  });

  test("virada de dia reinicia o bloco mesmo com o mesmo autor", () => {
    const itens = agruparMensagensGrupo([
      msg({ id: "m1", createdAt: "2026-07-26T23:00:00Z" }),
      msg({ id: "m2", createdAt: "2026-07-27T13:00:00Z" }),
    ]);
    const msgs = itens.filter((i) => i.kind === "message");
    expect(msgs[1]).toMatchObject({ mostrarAutor: true, colada: false });
  });

  test("atendentes diferentes não são agrupados juntos", () => {
    const itens = agruparMensagensGrupo([
      msg({
        id: "m1",
        createdAt: "2026-07-27T13:00:00Z",
        direction: "outbound",
        senderType: "atendente",
        sentByUserId: "u1",
        participanteNumero: null,
        participanteNome: null,
      }),
      msg({
        id: "m2",
        createdAt: "2026-07-27T13:01:00Z",
        direction: "outbound",
        senderType: "atendente",
        sentByUserId: "u2",
        participanteNumero: null,
        participanteNome: null,
      }),
    ]);
    const msgs = itens.filter((i) => i.kind === "message");
    expect(msgs[1]).toMatchObject({ mostrarAutor: true });
  });
});

describe("corDoParticipante", () => {
  test("a mesma chave sempre devolve a mesma cor", () => {
    expect(corDoParticipante("+5511999998888")).toBe(corDoParticipante("+5511999998888"));
  });

  test("chaves diferentes tendem a cores diferentes", () => {
    const cores = new Set(
      ["+5511999998888", "+5511911112222", "+5521988887777", "+554899996666"].map(
        corDoParticipante,
      ),
    );
    expect(cores.size).toBeGreaterThan(1);
  });

  test("chave nula tem cor de fallback válida", () => {
    expect(corDoParticipante(null)).toMatch(/^#[0-9A-F]{6}$/i);
  });
});

describe("autorDaMensagem", () => {
  const ctx = { meuUserId: "u1", nomesDeContato: new Map([["+5511999998888", "Maria Silva"]]) };

  test("contato do Google tem prioridade sobre o nome público", () => {
    const m = msg({ id: "m1", createdAt: "2026-07-27T13:00:00Z" });
    expect(autorDaMensagem(m, ctx)).toBe("Maria Silva");
  });

  test("sem contato, usa o nome público do WhatsApp", () => {
    const m = msg({
      id: "m1",
      createdAt: "2026-07-27T13:00:00Z",
      participanteNumero: "+5511911112222",
      participanteNome: "Zé da Obra",
    });
    expect(autorDaMensagem(m, ctx)).toBe("Zé da Obra");
  });

  test("sem contato e sem nome, usa o número", () => {
    const m = msg({
      id: "m1",
      createdAt: "2026-07-27T13:00:00Z",
      participanteNumero: "+5511911112222",
      participanteNome: null,
    });
    expect(autorDaMensagem(m, ctx)).toBe("+5511911112222");
  });

  test("minha própria mensagem é 'Você'", () => {
    const m = msg({
      id: "m1",
      createdAt: "2026-07-27T13:00:00Z",
      direction: "outbound",
      senderType: "atendente",
      sentByUserId: "u1",
      sentByNome: "Eu",
      participanteNumero: null,
      participanteNome: null,
    });
    expect(autorDaMensagem(m, ctx)).toBe("Você");
  });

  test("mensagem de outro atendente mostra o nome dele", () => {
    const m = msg({
      id: "m1",
      createdAt: "2026-07-27T13:00:00Z",
      direction: "outbound",
      senderType: "atendente",
      sentByUserId: "u2",
      sentByNome: "Ana",
      participanteNumero: null,
      participanteNome: null,
    });
    expect(autorDaMensagem(m, ctx)).toBe("Ana");
  });

  test("mensagem enviada pelo celular da empresa é 'Fora do sistema'", () => {
    const m = msg({
      id: "m1",
      createdAt: "2026-07-27T13:00:00Z",
      direction: "outbound",
      senderType: "externo",
      participanteNumero: null,
      participanteNome: null,
    });
    expect(autorDaMensagem(m, ctx)).toBe("Fora do sistema");
  });
});
