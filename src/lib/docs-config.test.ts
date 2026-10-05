import { describe, expect, test } from "vitest";
import {
  mensagemErroAcessoDocs,
  organizarAcessos,
  resumoConexaoDocs,
  type AcessoDocsRow,
  validarTextoAvisoDocs,
} from "./docs-config";

const row = (over: Partial<AcessoDocsRow>): AcessoDocsRow => ({
  user_id: "u",
  nome: "Fulano",
  department_id: null,
  department_nome: null,
  is_superadmin: false,
  tem_acesso: false,
  ...over,
});

describe("organizarAcessos", () => {
  test("separa admins (sempre com acesso) dos colaboradores, em ordem alfabética", () => {
    const r = organizarAcessos([
      row({ user_id: "3", nome: "Zé", tem_acesso: true }),
      row({ user_id: "1", nome: "Ana", is_superadmin: true, tem_acesso: true }),
      row({ user_id: "2", nome: "Érica" }),
      row({ user_id: "4", nome: "bruno" }),
    ]);
    expect(r.admins.map((a) => a.nome)).toEqual(["Ana"]);
    expect(r.colaboradores.map((c) => c.nome)).toEqual(["bruno", "Érica", "Zé"]);
    expect(r.totalComAcesso).toBe(2);
  });

  test("lista vazia não quebra", () => {
    expect(organizarAcessos([])).toEqual({ admins: [], colaboradores: [], totalComAcesso: 0 });
  });

  test("não muda o array recebido", () => {
    const entrada = [row({ user_id: "2", nome: "B" }), row({ user_id: "1", nome: "A" })];
    const copia = entrada.map((e) => ({ ...e }));
    organizarAcessos(entrada);
    expect(entrada).toEqual(copia);
  });

  test("nome vazio vai para o fim sem quebrar a ordenação", () => {
    const r = organizarAcessos([
      row({ user_id: "1", nome: null }),
      row({ user_id: "2", nome: "Ana" }),
    ]);
    expect(r.colaboradores.map((c) => c.user_id)).toEqual(["2", "1"]);
  });
});

describe("mensagemErroAcessoDocs", () => {
  test("traduz os códigos da RPC para frase de gente", () => {
    expect(mensagemErroAcessoDocs({ code: "42501" })).toMatch(/admin/i);
    expect(mensagemErroAcessoDocs({ code: "P0002" })).toMatch(/não encontrado/i);
    expect(mensagemErroAcessoDocs({ code: "22023" })).toMatch(/inválid/i);
  });

  test("erro desconhecido cai numa mensagem genérica", () => {
    expect(mensagemErroAcessoDocs(new Error("boom"))).toMatch(/não foi possível/i);
    expect(mensagemErroAcessoDocs(null)).toMatch(/não foi possível/i);
  });
});

describe("resumoConexaoDocs", () => {
  test("conectado e com webhook: tudo certo", () => {
    const r = resumoConexaoDocs({
      ok: true,
      connected: true,
      loggedIn: true,
      numero: "5519999990000",
      profileName: "Almore Financeiro",
      webhook_configurado: true,
    });
    expect(r.tom).toBe("ok");
    expect(r.numero).toBe("+5519999990000");
    expect(r.precisaWebhook).toBe(false);
  });

  test("conectado mas sem o nosso webhook: pede para configurar", () => {
    const r = resumoConexaoDocs({
      ok: true,
      connected: true,
      loggedIn: true,
      webhook_configurado: false,
    });
    expect(r.tom).toBe("alerta");
    expect(r.precisaWebhook).toBe(true);
  });

  test("número desconectado: erro, e o conserto é no outro sistema", () => {
    const r = resumoConexaoDocs({
      ok: true,
      connected: false,
      loggedIn: false,
      webhook_configurado: true,
    });
    expect(r.tom).toBe("erro");
    expect(r.detalhe).toMatch(/outro sistema/i);
  });

  test("secret ausente e falha da uazapi viram mensagens próprias", () => {
    expect(resumoConexaoDocs({ ok: false, erro: "credenciais_ausentes" }).detalhe).toMatch(
      /UAZAPI_TOKEN_FINANCEIRO/,
    );
    expect(resumoConexaoDocs({ ok: false, erro: "falha_uazapi" }).tom).toBe("erro");
  });
});

describe("validarTextoAvisoDocs", () => {
  test("texto vazio não pode ser salvo", () => {
    expect(validarTextoAvisoDocs("   ").ok).toBe(false);
  });

  test("texto longo demais é recusado", () => {
    expect(validarTextoAvisoDocs("x".repeat(1001)).ok).toBe(false);
  });

  test("sem link do atendimento: pode salvar, mas avisa", () => {
    const r = validarTextoAvisoDocs("Este número é só para documentos.");
    expect(r.ok).toBe(true);
    expect(r.alerta).toMatch(/wa\.me/);
  });

  test("com link wa.me: ok e sem alerta", () => {
    const r = validarTextoAvisoDocs("Fale com a gente: wa.me/5519991351061");
    expect(r).toEqual({ ok: true, alerta: null });
  });
});
