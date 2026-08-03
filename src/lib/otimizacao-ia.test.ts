import { describe, expect, test } from "vitest";
import { marcarOtimizacaoIa } from "./otimizacao-ia";

describe("marcarOtimizacaoIa", () => {
  test("não marca quando a pessoa escolhe enviar o próprio texto", () => {
    // Arrange
    const digitado = "bom dia, ja verifiquei aqui";

    // Act
    const marca = marcarOtimizacaoIa(digitado, digitado, "original");

    // Assert
    expect(marca).toEqual({ otimizadoIa: false, contentOriginal: null });
  });

  test("marca e guarda o original quando a sugestão da IA é aceita", () => {
    // Arrange
    const digitado = "bom dia, ja verifiquei aqui";
    const enviado = "Bom dia! Já verifiquei aqui.";

    // Act
    const marca = marcarOtimizacaoIa(digitado, enviado, "sugestao");

    // Assert
    expect(marca).toEqual({ otimizadoIa: true, contentOriginal: digitado });
  });

  test("marca também quando a pessoa edita a sugestão antes de enviar", () => {
    // Arrange
    const digitado = "vou ver com o fiscal";
    const enviado = "Vou verificar com o setor fiscal e já te retorno.";

    // Act
    const marca = marcarOtimizacaoIa(digitado, enviado, "sugestao");

    // Assert
    expect(marca).toEqual({ otimizadoIa: true, contentOriginal: digitado });
  });

  test("não marca quando a sugestão é igual ao que a pessoa digitou", () => {
    // A IA não achou o que melhorar — o auto-envio do diálogo cai aqui.
    // Arrange
    const digitado = "Bom dia! Já verifiquei aqui.";

    // Act
    const marca = marcarOtimizacaoIa(digitado, digitado, "sugestao");

    // Assert
    expect(marca).toEqual({ otimizadoIa: false, contentOriginal: null });
  });

  test("não marca quando a edição desfaz a sugestão (só sobra espaço em branco)", () => {
    // Arrange
    const digitado = "Bom dia! Já verifiquei aqui.";
    const enviado = "  Bom dia! Já verifiquei aqui.  ";

    // Act
    const marca = marcarOtimizacaoIa(digitado, enviado, "sugestao");

    // Assert
    expect(marca).toEqual({ otimizadoIa: false, contentOriginal: null });
  });
});
