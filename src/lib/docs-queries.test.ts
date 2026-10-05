import { beforeEach, describe, expect, test, vi } from "vitest";

type Resposta = { data: unknown; error: unknown };

type Chamada = { tabela: string; metodo: string; args: unknown[] };
/** Resposta fixa por tabela, ou calculada a partir das chamadas DESTA query. */
const respostas = new Map<string, Resposta | ((daQuery: Chamada[]) => Resposta)>();
const chamadas: Chamada[] = [];
const rpc = vi.fn();

/** Query builder encadeável do supabase-js: cada método devolve o próprio builder. */
function builder(tabela: string) {
  const daQuery: Chamada[] = [];
  const b: Record<string, unknown> = {};
  for (const metodo of ["select", "order", "limit", "in", "eq", "lt", "not", "maybeSingle"]) {
    b[metodo] = (...args: unknown[]) => {
      const c = { tabela, metodo, args };
      chamadas.push(c);
      daQuery.push(c);
      return b;
    };
  }
  b.then = (ok: (r: Resposta) => unknown, falha: (e: unknown) => unknown) => {
    const r = respostas.get(tabela);
    const resposta = typeof r === "function" ? r(daQuery) : (r ?? { data: [], error: null });
    return Promise.resolve(resposta).then(ok, falha);
  };
  return b;
}

/** rpc(nome, args) → resposta por nome. */
function rpcPorNome(mapa: Record<string, Resposta>) {
  rpc.mockImplementation((nome: string) =>
    Promise.resolve(mapa[nome] ?? { data: null, error: null }),
  );
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (tabela: string) => builder(tabela),
    rpc: (...args: unknown[]) => rpc(...args),
  },
}));

import {
  assumirDocsConversa,
  contarDocsAtivas,
  encerrarDocsConversa,
  fetchDocsConversaById,
  fetchDocsConversaInfo,
  fetchDocsMensagemById,
  fetchDocsUnreadTotal,
  iniciarDocsConversa,
  listarPessoasDocs,
  listDocsConversas,
  listDocsEventos,
  listDocsMensagensPage,
  listMinhasDocsConversas,
  marcarDocsConversaLida,
  repassarDocsConversa,
} from "./docs-queries";

const linhaMensagem = (id: string, created_at: string, over: Record<string, unknown> = {}) => ({
  id,
  conversa_id: "c1",
  direction: "inbound",
  sender_type: "cliente",
  sent_by_user_id: null,
  tipo: "texto",
  content: id,
  media_url: null,
  media_metadata: null,
  uazapi_message_id: "wa-1",
  status_envio: "enviado",
  status_whatsapp: null,
  reply_to_message_id: null,
  created_at,
  apagada_em: null,
  editada_em: null,
  sent_by: null,
  ...over,
});

beforeEach(() => {
  respostas.clear();
  chamadas.length = 0;
  rpc.mockReset();
  rpc.mockResolvedValue({ data: null, error: null });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("listDocsConversas", () => {
  const params = { meuUserId: "u1", filtro: "todas" as const, busca: "" };

  test("lista vazia não faz as consultas de prévia", async () => {
    rpcPorNome({ docs_listar_conversas: { data: [], error: null } });
    expect(await listDocsConversas(params)).toEqual([]);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  test("filtro e busca vão para o banco; busca vazia vai como ausente", async () => {
    rpcPorNome({ docs_listar_conversas: { data: [], error: null } });
    await listDocsConversas({ ...params, filtro: "sem_dono", busca: "  maria " });
    expect(rpc).toHaveBeenCalledWith("docs_listar_conversas", {
      p_filtro: "sem_dono",
      p_busca: "maria",
    });
    await listDocsConversas({ ...params, busca: "   " });
    expect(rpc).toHaveBeenLastCalledWith("docs_listar_conversas", {
      p_filtro: "todas",
      p_busca: undefined,
    });
  });

  test("junta dono, prévia exata, não lidas e nome do contato", async () => {
    rpcPorNome({
      docs_listar_conversas: {
        data: [
          {
            id: "c1",
            client_id: "cli1",
            status: "em_andamento",
            assigned_to: "u2",
            last_message_at: "2026-09-29T10:00:00Z",
            last_inbound_at: "2026-09-29T09:00:00Z",
            created_at: "2026-09-01T00:00:00Z",
            cliente_nome: "Maria WA",
            cliente_numero: "+5511",
          },
          {
            id: "c2",
            client_id: "cli2",
            status: "so_envio",
            assigned_to: null,
            last_message_at: null,
            last_inbound_at: null,
            created_at: "2026-09-02T00:00:00Z",
            cliente_nome: null,
            cliente_numero: "+5522",
          },
        ],
        error: null,
      },
      docs_ultimas_mensagens: {
        data: [
          {
            conversa_id: "c1",
            id: "m1",
            direction: "outbound",
            sender_type: "externo",
            tipo: "documento",
            content: null,
            file_name: "boleto.pdf",
            created_at: "2026-09-29T10:00:00Z",
            apagada_em: null,
          },
        ],
        error: null,
      },
      get_docs_unread_counts: { data: [{ conversa_id: "c1", unread: 3 }], error: null },
    });
    respostas.set("users", { data: [{ id: "u2", nome: "Ana" }], error: null });
    respostas.set("contatos", {
      data: [{ numero_whatsapp: "+5511", nome: "Maria Google" }],
      error: null,
    });

    const r = await listDocsConversas(params);

    expect(rpc).toHaveBeenCalledWith("docs_ultimas_mensagens", { p_conversa_ids: ["c1", "c2"] });
    expect(r[0]).toMatchObject({
      id: "c1",
      clientNome: "Maria Google",
      assignedNome: "Ana",
      lastInboundAt: "2026-09-29T09:00:00Z",
      lastMessagePreview: "Financeiro: 📎 boleto.pdf",
      unread: 3,
    });
    expect(r[1]).toMatchObject({
      id: "c2",
      clientNome: "+5522",
      assignedNome: null,
      lastMessagePreview: "",
      unread: 0,
    });
  });

  test("falha no nome dos donos não derruba a lista", async () => {
    rpcPorNome({
      docs_listar_conversas: {
        data: [
          {
            id: "c1",
            client_id: "cli1",
            status: "em_andamento",
            assigned_to: "u2",
            last_message_at: null,
            last_inbound_at: null,
            created_at: "2026-09-01T00:00:00Z",
            cliente_nome: "Maria",
            cliente_numero: "+5511",
          },
        ],
        error: null,
      },
      docs_ultimas_mensagens: { data: [], error: null },
      get_docs_unread_counts: { data: [], error: null },
    });
    respostas.set("users", { data: null, error: new Error("rls") });
    const [c] = await listDocsConversas(params);
    expect(c.assignedNome).toBeNull();
  });

  test("erro na lista ou na prévia é propagado", async () => {
    const erro = new Error("boom");
    rpcPorNome({ docs_listar_conversas: { data: null, error: erro } });
    await expect(listDocsConversas(params)).rejects.toBe(erro);
  });
});

describe("conversa avulsa, minhas e contadores", () => {
  test("busca por id monta a conversa (sem prévia) e devolve null se não existe", async () => {
    respostas.set("docs_conversas", {
      data: {
        id: "c9",
        client_id: "cli9",
        status: "em_andamento",
        assigned_to: "u1",
        last_message_at: null,
        last_inbound_at: null,
        created_at: "2026-09-30T00:00:00Z",
        client: { nome: "Novo", numero_whatsapp: "+5533" },
        dono: { nome: "Eu" },
      },
      error: null,
    });
    expect(await fetchDocsConversaById("c9")).toMatchObject({
      id: "c9",
      clientNome: "Novo",
      assignedNome: "Eu",
      lastMessagePreview: "",
      unread: 0,
    });
    respostas.set("docs_conversas", { data: null, error: null });
    expect(await fetchDocsConversaById("c9")).toBeNull();
  });

  test("minhas conversas em andamento filtram por dono e status", async () => {
    respostas.set("docs_conversas", {
      data: [{ id: "c1", client: { nome: null, numero_whatsapp: "+5511" } }],
      error: null,
    });
    expect(await listMinhasDocsConversas("u1")).toEqual([
      { id: "c1", clientNome: "+5511", clientNumero: "+5511" },
    ]);
    expect(chamadas).toContainEqual({
      tabela: "docs_conversas",
      metodo: "eq",
      args: ["assigned_to", "u1"],
    });
  });

  test("contadores exatos de sem dono e em andamento", async () => {
    respostas.set("docs_conversas", (daQuery) => {
      const status = daQuery.find((c) => c.metodo === "eq")?.args[1];
      return { data: null, error: null, count: status === "sem_dono" ? 4 : 2 } as Resposta;
    });
    expect(await contarDocsAtivas()).toEqual({ semDono: 4, emAndamento: 2 });
  });
});

describe("mensagens", () => {
  test("página devolve em ordem crescente e avisa se há mais", async () => {
    respostas.set("docs_mensagens", {
      data: [
        linhaMensagem("m3", "2026-09-29T03:00:00Z"),
        linhaMensagem("m2", "2026-09-29T02:00:00Z"),
        linhaMensagem("m1", "2026-09-29T01:00:00Z"),
      ],
      error: null,
    });
    const r = await listDocsMensagensPage({ conversaId: "c1", limit: 2, beforeCreatedAt: "x" });
    expect(r.hasMore).toBe(true);
    expect(r.messages.map((m) => m.id)).toEqual(["m2", "m3"]);
    expect(r.messages[0].temIdWhatsapp).toBe(true);
    expect(chamadas).toContainEqual({
      tabela: "docs_mensagens",
      metodo: "lt",
      args: ["created_at", "x"],
    });
  });

  test("busca por id mapeia autor e devolve null quando não existe", async () => {
    respostas.set("docs_mensagens", {
      data: linhaMensagem("m1", "2026-09-29T01:00:00Z", {
        direction: "outbound",
        sender_type: "atendente",
        sent_by_user_id: "u1",
        sent_by: { id: "u1", nome: "Ana" },
        uazapi_message_id: null,
      }),
      error: null,
    });
    const m = await fetchDocsMensagemById("m1");
    expect(m).toMatchObject({ sentByNome: "Ana", temIdWhatsapp: false, conversaId: "c1" });

    respostas.set("docs_mensagens", { data: null, error: null });
    expect(await fetchDocsMensagemById("m1")).toBeNull();
  });
});

describe("eventos e info", () => {
  test("eventos trazem nomes de quem fez e de quem recebeu", async () => {
    respostas.set("docs_eventos", {
      data: [
        {
          id: "e1",
          tipo: "repassada",
          actor_user_id: "u1",
          target_user_id: "u2",
          observacao: null,
          created_at: "2026-09-29T00:00:00Z",
          actor: { nome: "Ana" },
          target: { nome: "Zé" },
        },
      ],
      error: null,
    });
    expect(await listDocsEventos("c1")).toEqual([
      {
        id: "e1",
        tipo: "repassada",
        actorUserId: "u1",
        actorNome: "Ana",
        targetUserId: "u2",
        targetNome: "Zé",
        observacao: null,
        createdAt: "2026-09-29T00:00:00Z",
      },
    ]);
  });

  test("info da conversa cai no número quando o cliente não tem nome", async () => {
    respostas.set("docs_conversas", {
      data: {
        status: "sem_dono",
        assigned_to: null,
        client: { nome: null, numero_whatsapp: "+5511" },
      },
      error: null,
    });
    expect(await fetchDocsConversaInfo("c1")).toEqual({
      status: "sem_dono",
      assignedTo: null,
      clientNome: "+5511",
    });
    respostas.set("docs_conversas", { data: null, error: new Error("x") });
    expect(await fetchDocsConversaInfo("c1")).toBeNull();
  });
});

describe("RPCs", () => {
  test("assumir traduz 23505 (conversa de outra pessoa)", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "23505", message: "x" } });
    await expect(assumirDocsConversa("c1")).rejects.toThrow(/outra pessoa/);
    expect(rpc).toHaveBeenCalledWith("docs_assumir", { p_conversa_id: "c1" });
  });

  test("repassar manda observação aparada (ou nada)", async () => {
    await repassarDocsConversa({ conversaId: "c1", toUserId: "u2", observacao: "  " });
    expect(rpc).toHaveBeenCalledWith("docs_repassar", {
      p_conversa_id: "c1",
      p_to_user_id: "u2",
      p_observacao: undefined,
    });
    rpc.mockResolvedValue({ data: null, error: { code: "22023" } });
    await expect(
      repassarDocsConversa({ conversaId: "c1", toUserId: "u2", observacao: " vip " }),
    ).rejects.toThrow(/não tem acesso/);
    expect(rpc).toHaveBeenLastCalledWith("docs_repassar", {
      p_conversa_id: "c1",
      p_to_user_id: "u2",
      p_observacao: "vip",
    });
  });

  test("encerrar e iniciar", async () => {
    await expect(encerrarDocsConversa("c1")).resolves.toBeUndefined();
    rpc.mockResolvedValue({ data: "c9", error: null });
    expect(await iniciarDocsConversa("cli1")).toBe("c9");
    expect(rpc).toHaveBeenLastCalledWith("docs_iniciar_conversa", { p_client_id: "cli1" });
    rpc.mockResolvedValue({ data: null, error: null });
    await expect(iniciarDocsConversa("cli1")).rejects.toThrow(/iniciar/);
    rpc.mockResolvedValue({ data: null, error: { code: "42501" } });
    await expect(encerrarDocsConversa("c1")).rejects.toThrow(/dono/);
  });

  test("marcar lida nunca lança", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "x" } });
    await expect(marcarDocsConversaLida("c1")).resolves.toBeUndefined();
  });

  test("total de não lidas e pessoas com acesso", async () => {
    rpc.mockResolvedValue({ data: 4, error: null });
    expect(await fetchDocsUnreadTotal()).toBe(4);
    rpc.mockResolvedValue({
      data: [
        {
          user_id: "u1",
          nome: "Ana",
          department_id: null,
          department_nome: null,
          is_superadmin: true,
          tem_acesso: true,
        },
      ],
      error: null,
    });
    expect(await listarPessoasDocs()).toEqual([
      { userId: "u1", nome: "Ana", departamentoNome: null, isSuperadmin: true, temAcesso: true },
    ]);
    const erro = new Error("x");
    rpc.mockResolvedValue({ data: null, error: erro });
    await expect(fetchDocsUnreadTotal()).rejects.toBe(erro);
  });
});
