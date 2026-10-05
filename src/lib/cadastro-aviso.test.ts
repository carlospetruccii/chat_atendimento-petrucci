import { describe, expect, test } from "vitest";
import { avisoCadastro } from "./cadastro-aviso";

describe("avisoCadastro", () => {
  test("cliente novo", () => {
    expect(avisoCadastro({ criado: true, atualizado: false }, "Cliente")).toBe(
      "Cliente cadastrado",
    );
    expect(avisoCadastro({ criado: true, atualizado: false }, "Contato")).toBe(
      "Contato adicionado",
    );
  });

  test("cliente existente renomeado", () => {
    expect(avisoCadastro({ criado: false, atualizado: true }, "Cliente")).toBe(
      "Cliente atualizado",
    );
  });

  test("cliente existente mantido (colaborador não renomeia) não diz que atualizou", () => {
    expect(avisoCadastro({ criado: false, atualizado: false }, "Contato")).toBe(
      "Contato já estava cadastrado",
    );
  });
});
