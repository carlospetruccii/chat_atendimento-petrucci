import { describe, expect, test } from "vitest";
import { ehSobDemanda, nomeDoArquivo, tituloSobDemanda } from "./midia-sob-demanda";

describe("ehSobDemanda", () => {
  test("só o código sob_demanda conta; falha de verdade não", () => {
    expect(ehSobDemanda({ download_falhou: true, download_erro_codigo: "sob_demanda" })).toBe(true);
    expect(ehSobDemanda({ download_falhou: true, download_erro_codigo: "falha" })).toBe(false);
    expect(ehSobDemanda({ download_falhou: true, download_erro_codigo: "grande_demais" })).toBe(
      false,
    );
    expect(ehSobDemanda({ download_erro_codigo: "sob_demanda" })).toBe(false);
    expect(ehSobDemanda(null)).toBe(false);
  });
});

describe("nomeDoArquivo", () => {
  test("aceita file_name e fileName; ignora vazio", () => {
    expect(nomeDoArquivo({ file_name: " boleto.pdf " })).toBe("boleto.pdf");
    expect(nomeDoArquivo({ fileName: "nf.xml" })).toBe("nf.xml");
    expect(nomeDoArquivo({ file_name: "  " })).toBeNull();
    expect(nomeDoArquivo(undefined)).toBeNull();
  });
});

describe("tituloSobDemanda", () => {
  test("nomeia pelo tipo, documento por padrão", () => {
    expect(tituloSobDemanda("documento")).toBe("Documento do sistema financeiro");
    expect(tituloSobDemanda("imagem")).toBe("Imagem do sistema financeiro");
    expect(tituloSobDemanda("xyz")).toBe("Documento do sistema financeiro");
  });
});
