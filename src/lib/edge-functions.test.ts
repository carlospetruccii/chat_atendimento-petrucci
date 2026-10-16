import { describe, expect, test } from "vitest";
import { blobParaBase64, codigoDoErro, corpoDoErro, mensagemDoErro } from "./edge-functions";

describe("blobParaBase64", () => {
  test("converte sem o prefixo data:", async () => {
    expect(await blobParaBase64(new Blob(["oi"]))).toBe("b2k=");
  });
  test("arquivo maior que um bloco sai inteiro", async () => {
    const bytes = new Uint8Array(0x8000 + 10).fill(65);
    const b64 = await blobParaBase64(new Blob([bytes]));
    expect(atob(b64)).toHaveLength(0x8000 + 10);
  });
});

describe("codigoDoErro / corpoDoErro", () => {
  const erroCom = (corpo: string) => ({
    context: new Response(corpo, { status: 403, headers: { "Content-Type": "application/json" } }),
  });

  test("lê o campo erro do corpo", async () => {
    expect(await codigoDoErro(erroCom(JSON.stringify({ ok: false, erro: "nao_e_dono" })))).toBe(
      "nao_e_dono",
    );
  });
  test("corpo sem erro, não-JSON ou sem Response devolve undefined", async () => {
    expect(await codigoDoErro(erroCom(JSON.stringify({ ok: false })))).toBeUndefined();
    expect(await codigoDoErro(erroCom("<html>"))).toBeUndefined();
    expect(await codigoDoErro(new Error("rede"))).toBeUndefined();
    expect(await corpoDoErro(null)).toBeUndefined();
  });
  test("pode ler o mesmo erro duas vezes (usa clone)", async () => {
    const e = erroCom(JSON.stringify({ motivo: "x" }));
    expect(await corpoDoErro(e)).toEqual({ motivo: "x" });
    expect(await corpoDoErro(e)).toEqual({ motivo: "x" });
  });
});

describe("mensagemDoErro", () => {
  const erroCom = (corpo: string) =>
    Object.assign(new Error("Edge Function returned a non-2xx status code"), {
      context: new Response(corpo, {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    });

  test("usa o campo error do corpo (motivo real da função)", async () => {
    const erro = erroCom(
      JSON.stringify({ error: "A user with this email address has already been registered" }),
    );
    expect(await mensagemDoErro(erro, "Falha")).toBe(
      "A user with this email address has already been registered",
    );
  });
  test("sem corpo legível usa o fallback, não a mensagem genérica do supabase-js", async () => {
    expect(await mensagemDoErro(erroCom("<html>"), "Falha ao criar")).toBe("Falha ao criar");
    expect(await mensagemDoErro(new Error("rede"), "Falha ao criar")).toBe("Falha ao criar");
  });
});
