import { describe, expect, test } from "vitest";
import { MENSAGEM_ACESSO_DESATIVADO, mensagemErroLogin, perfilDesativado } from "./acesso";

describe("mensagemErroLogin", () => {
  test("login bloqueado no Auth avisa que o acesso foi desativado", () => {
    expect(mensagemErroLogin({ code: "user_banned", message: "User is banned" })).toBe(
      MENSAGEM_ACESSO_DESATIVADO,
    );
  });

  test("reconhece o bloqueio só pela mensagem, sem código", () => {
    expect(mensagemErroLogin({ message: "User is banned" })).toBe(MENSAGEM_ACESSO_DESATIVADO);
  });

  test("senha errada continua com a mensagem de sempre", () => {
    expect(
      mensagemErroLogin({ code: "invalid_credentials", message: "Invalid login credentials" }),
    ).toBe("E-mail ou senha incorretos");
  });

  test("sem erro mas sem sessão também cai na mensagem de sempre", () => {
    expect(mensagemErroLogin(null)).toBe("E-mail ou senha incorretos");
  });
});

describe("perfilDesativado", () => {
  test("perfil carregado e inativo é desativado", () => {
    expect(perfilDesativado({ ativo: false })).toBe(true);
  });

  test("perfil ativo não é desativado", () => {
    expect(perfilDesativado({ ativo: true })).toBe(false);
  });

  test("perfil ainda não carregado não expulsa ninguém", () => {
    expect(perfilDesativado(null)).toBe(false);
  });
});
