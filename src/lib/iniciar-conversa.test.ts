import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cadastrarClienteSingle: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("@/lib/clientes-queries", () => ({
  cadastrarClienteSingle: mocks.cadastrarClienteSingle,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke: mocks.invoke } },
}));

import { iniciarConversa } from "./iniciar-conversa";

const QUEM = { userId: "eu", canViewAll: false };

function erroComCorpo(corpo: unknown) {
  return {
    data: null,
    error: {
      message: "Edge Function returned a non-2xx status code",
      context: new Response(JSON.stringify(corpo)),
    },
  };
}

describe("iniciarConversa", () => {
  beforeEach(() => {
    mocks.cadastrarClienteSingle.mockReset();
    mocks.invoke.mockReset();
    mocks.cadastrarClienteSingle.mockResolvedValue({
      ok: true,
      criado: false,
      atualizado: false,
      cliente: { id: "cli-1", nome: "Mario", numero_whatsapp: "+559184008486" },
      nome_anterior: "Mario",
    });
  });

  test("garante o cliente e abre o atendimento atribuído a mim", async () => {
    mocks.invoke.mockResolvedValue({ data: { ok: true, atendimento_id: "at-1" }, error: null });

    const r = await iniciarConversa(
      { nome: "Contador Mario", numero: "+559184008486", manterNomeExistente: true },
      QUEM,
    );

    expect(mocks.cadastrarClienteSingle).toHaveBeenCalledWith("Contador Mario", "+559184008486", {
      manterNomeExistente: true,
    });
    expect(mocks.invoke).toHaveBeenCalledWith("iniciar-atendimento", {
      body: { client_id: "cli-1", assign_to_me: true },
    });
    expect(r).toEqual({ tipo: "aberta", atendimentoId: "at-1", jaExistia: false });
  });

  test("atendimento ativo meu: devolve o existente", async () => {
    mocks.invoke.mockResolvedValue(
      erroComCorpo({
        error: "cliente_com_atendimento_ativo",
        atendimento_id: "at-9",
        assigned_to: "eu",
      }),
    );

    const r = await iniciarConversa({ nome: "Mario", numero: "+559184008486" }, QUEM);

    expect(r).toEqual({ tipo: "aberta", atendimentoId: "at-9", jaExistia: true });
  });

  test("atendimento ativo de outro e não vejo todos: diz quem está com ele", async () => {
    mocks.invoke.mockResolvedValue(
      erroComCorpo({
        error: "cliente_com_atendimento_ativo",
        atendimento_id: "at-9",
        assigned_to: "outro",
        assigned_to_nome: "Ana",
        department_nome: "Fiscal",
      }),
    );

    const r = await iniciarConversa({ nome: "Mario", numero: "+559184008486" }, QUEM);

    expect(r).toEqual({ tipo: "ocupada", responsavel: "Ana", departamento: "Fiscal" });
  });

  test("atendimento ativo de outro, mas vejo todos: abre o existente", async () => {
    mocks.invoke.mockResolvedValue(
      erroComCorpo({
        error: "cliente_com_atendimento_ativo",
        atendimento_id: "at-9",
        assigned_to: "outro",
      }),
    );

    const r = await iniciarConversa(
      { nome: "Mario", numero: "+559184008486" },
      { userId: "eu", canViewAll: true },
    );

    expect(r).toEqual({ tipo: "aberta", atendimentoId: "at-9", jaExistia: true });
  });

  test("outro erro do servidor vira Error com o detalhe", async () => {
    mocks.invoke.mockResolvedValue(erroComCorpo({ erro: "forbidden", detalhe: "Sem permissão" }));

    await expect(iniciarConversa({ nome: "Mario", numero: "+559184008486" }, QUEM)).rejects.toThrow(
      "Sem permissão",
    );
  });

  test("falha no cadastro do cliente não chama iniciar-atendimento", async () => {
    mocks.cadastrarClienteSingle.mockRejectedValue(new Error("Telefone fora do padrão E.164"));

    await expect(iniciarConversa({ nome: "Mario", numero: "x" }, QUEM)).rejects.toThrow("E.164");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
