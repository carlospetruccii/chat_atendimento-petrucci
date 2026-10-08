import { describe, expect, test } from "vitest";
import { mensagemErroRepasse } from "./repasse-erro";

describe("mensagemErroRepasse", () => {
  test("avisa que a conversa já está com o destino quando a RPC recusa o repasse pra mesma pessoa", () => {
    const erro = { code: "22023", message: "Atendimento já está com este colaborador" };

    expect(mensagemErroRepasse(erro, "Samira")).toBe("Este atendimento já está com Samira.");
  });

  test("mantém 'destino inválido' para o outro caso do 22023", () => {
    const erro = { code: "22023", message: "Colaborador destino inválido" };

    expect(mensagemErroRepasse(erro, "Samira")).toBe("Colaborador destino inválido.");
  });

  test("traduz falta de permissão", () => {
    expect(mensagemErroRepasse({ code: "42501" }, "Samira")).toBe(
      "Você não tem permissão para repassar este atendimento.",
    );
  });

  test("traduz atendimento inexistente", () => {
    expect(mensagemErroRepasse({ code: "P0002" }, "Samira")).toBe(
      "Atendimento não encontrado — recarregue a conversa.",
    );
  });

  test("traduz cliente com outra conversa ativa", () => {
    expect(mensagemErroRepasse({ code: "23505" }, "Samira")).toBe(
      "Este cliente já tem uma conversa ativa — repasse a conversa atual dele.",
    );
  });

  test("mostra a mensagem crua para códigos desconhecidos", () => {
    expect(mensagemErroRepasse({ code: "XX000", message: "falhou" }, "Samira")).toBe(
      "Não foi possível repassar: falhou",
    );
  });

  test("usa texto genérico quando não há mensagem", () => {
    expect(mensagemErroRepasse({}, "Samira")).toBe("Não foi possível repassar o atendimento.");
  });
});
