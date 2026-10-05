import { describe, expect, test, vi } from "vitest";
import { adicionarContato } from "./adicionar-contato";

describe("adicionarContato", () => {
  test("normaliza nome e WhatsApp antes de cadastrar", async () => {
    const cadastrar = vi.fn().mockResolvedValue({
      ok: true,
      criado: true,
      atualizado: false,
      cliente: {
        id: "cliente-1",
        nome: "Maria da Silva",
        numero_whatsapp: "+5511999999999",
      },
      nome_anterior: null,
    });

    await adicionarContato({ nome: "  Maria da Silva  ", telefone: "(11) 99999-9999" }, cadastrar);

    expect(cadastrar).toHaveBeenCalledOnce();
    expect(cadastrar).toHaveBeenCalledWith("Maria da Silva", "+5511999999999");
  });

  test("aceita zero de operadora antes do DDD", async () => {
    const cadastrar = vi.fn().mockResolvedValue({ ok: true });

    await adicionarContato({ nome: "Maria", telefone: "011 99999-9999" }, cadastrar);

    expect(cadastrar).toHaveBeenCalledWith("Maria", "+5511999999999");
  });

  test.each([
    {
      input: { nome: " ", telefone: "(11) 99999-9999" },
      campo: "nome",
      mensagem: "Informe um nome com pelo menos 2 caracteres.",
    },
    {
      input: { nome: "A", telefone: "(11) 99999-9999" },
      campo: "nome",
      mensagem: "Informe um nome com pelo menos 2 caracteres.",
    },
    {
      input: { nome: "Maria", telefone: "123" },
      campo: "telefone",
      mensagem: "Informe um WhatsApp com DDD e número.",
    },
    {
      input: { nome: "Maria", telefone: "99999-9999" },
      campo: "telefone",
      mensagem: "Informe um WhatsApp com DDD e número.",
    },
  ])("rejeita $campo inválido sem tentar cadastrar", async ({ input, campo, mensagem }) => {
    const cadastrar = vi.fn();

    await expect(adicionarContato(input, cadastrar)).rejects.toMatchObject({
      errors: { [campo]: mensagem },
    });
    expect(cadastrar).not.toHaveBeenCalled();
  });

  test("preserva nomes Unicode e com apóstrofo", async () => {
    const cadastrar = vi.fn().mockResolvedValue({
      ok: true,
      criado: true,
      atualizado: false,
      cliente: {
        id: "cliente-2",
        nome: "D'Ávila 😊",
        numero_whatsapp: "+5511988887777",
      },
      nome_anterior: null,
    });

    await adicionarContato({ nome: "D'Ávila 😊", telefone: "+55 11 98888-7777" }, cadastrar);

    expect(cadastrar).toHaveBeenCalledWith("D'Ávila 😊", "+5511988887777");
  });

  test("propaga a falha do cadastro para a interface", async () => {
    const cadastrar = vi.fn().mockRejectedValue(new Error("Você não tem permissão."));

    await expect(
      adicionarContato({ nome: "Maria", telefone: "11999999999" }, cadastrar),
    ).rejects.toThrow("Você não tem permissão.");
  });
});
