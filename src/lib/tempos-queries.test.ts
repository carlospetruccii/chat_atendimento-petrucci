import { describe, expect, test, vi } from "vitest";

const mock = vi.hoisted(() => ({ supabase: {} as Record<string, unknown> }));
vi.mock("@/integrations/supabase/client", () => mock);

import {
  montarTempos,
  TEMPOS,
  textoAfetados,
  updateTempo,
  type StatusTempo,
} from "./tempos-queries";

const linha = (chave: string, valor: string | null, descricao = "desc") => ({
  chave,
  valor,
  descricao,
});

const todosEmUso = (): StatusTempo[] =>
  TEMPOS.map((t) => ({ chave: t.chave, motivo: null, afetados: null }));

describe("montarTempos", () => {
  test("tempo com status sem motivo aparece em uso", () => {
    // Arrange
    const linhas = [linha("delay_anti_flood_triagem", "8")];

    // Act
    const rows = montarTempos(linhas, todosEmUso());
    const delay = rows.find((r) => r.chave === "delay_anti_flood_triagem")!;

    // Assert
    expect(delay.valor).toBe(8);
    expect(delay.emUso).toBe(true);
    expect(delay.inativo).toBeUndefined();
  });

  test("motivo vindo do banco vira o aviso de sem efeito", () => {
    const status = todosEmUso().map((s) =>
      s.chave === "tempo_encerramento_automatico"
        ? { ...s, motivo: "Sem efeito: o bot está desligado em Operação." }
        : s,
    );

    const rows = montarTempos([linha("tempo_encerramento_automatico", "1440")], status);
    const enc = rows.find((r) => r.chave === "tempo_encerramento_automatico")!;

    expect(enc.emUso).toBe(false);
    expect(enc.inativo).toBe("Sem efeito: o bot está desligado em Operação.");
  });

  test("sem status do banco não afirma que está em uso", () => {
    const rows = montarTempos([linha("tempo_alerta_atendimento_parado", "10")], null);
    const alerta = rows.find((r) => r.chave === "tempo_alerta_atendimento_parado")!;

    expect(alerta.emUso).toBe(false);
    expect(alerta.inativo).toMatch(/Não foi possível confirmar/);
  });

  test("tempo que o banco não conhece também não aparece como em uso", () => {
    const status = todosEmUso().filter((s) => s.chave !== "triagem_max_tentativas");

    const rows = montarTempos([linha("triagem_max_tentativas", "2")], status);
    const tent = rows.find((r) => r.chave === "triagem_max_tentativas")!;

    expect(tent.emUso).toBe(false);
    expect(tent.inativo).toMatch(/Não foi possível confirmar/);
  });

  test("chave ausente em system_config fica com valor null, nunca 0", () => {
    const rows = montarTempos([], todosEmUso());

    expect(rows.every((r) => r.valor === null)).toBe(true);
    expect(rows.every((r) => r.descricao === null)).toBe(true);
  });

  test("leva a contagem de clientes afetados quando o banco manda", () => {
    const status = todosEmUso().map((s) =>
      s.chave === "tempo_alerta_atendimento_parado" ? { ...s, afetados: 184 } : s,
    );

    const rows = montarTempos([linha("tempo_alerta_atendimento_parado", "10")], status);

    expect(rows.find((r) => r.chave === "tempo_alerta_atendimento_parado")!.afetados).toBe(184);
    expect(rows.find((r) => r.chave === "delay_anti_flood_triagem")!.afetados).toBeNull();
  });

  test("mantém a ordem e todos os tempos da tela", () => {
    const rows = montarTempos([], todosEmUso());

    expect(rows.map((r) => r.chave)).toEqual(TEMPOS.map((t) => t.chave));
  });
});

/** Cliente falso: o UPDATE devolve `atualizadas` linhas; a leitura acha a linha se `existe`. */
function clienteFalso(atualizadas: number, existe: boolean) {
  const select = () => ({
    eq: () => ({
      maybeSingle: async () => ({ data: existe ? { chave: "x" } : null, error: null }),
    }),
  });
  return {
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    from: () => ({
      update: () => ({
        eq: () => ({
          select: async () => ({
            data: Array.from({ length: atualizadas }, () => ({ chave: "x" })),
            error: null,
          }),
        }),
      }),
      select,
    }),
  };
}

describe("updateTempo", () => {
  test("salva sem erro quando o UPDATE grava a linha", async () => {
    mock.supabase = clienteFalso(1, true);

    await expect(updateTempo("tempo_alerta_atendimento_parado", 15)).resolves.toBeUndefined();
  });

  test("avisa falta de permissão quando a linha existe mas nada foi gravado", async () => {
    mock.supabase = clienteFalso(0, true);

    await expect(updateTempo("tempo_alerta_atendimento_parado", 15)).rejects.toThrow(
      "Só dono ou administrador pode alterar os tempos.",
    );
  });

  test("avisa chave inexistente quando a linha não existe", async () => {
    mock.supabase = clienteFalso(0, false);

    await expect(updateTempo("chave_fantasma", 15)).rejects.toThrow(/não existe em system_config/);
  });
});

describe("textoAfetados", () => {
  test("sem ninguém afetado não mostra nada", () => {
    expect(textoAfetados(0, false)).toBeNull();
    expect(textoAfetados(null, true)).toBeNull();
  });

  test("tempo parado avisa que todos geram aviso ao ligar", () => {
    expect(textoAfetados(184, false)).toBe(
      "Hoje 184 clientes já passaram desse tempo. Se ligar, todos geram aviso.",
    );
  });

  test("singular para um cliente", () => {
    expect(textoAfetados(1, false)).toBe(
      "Hoje 1 cliente já passou desse tempo. Se ligar, ele gera aviso.",
    );
  });

  test("tempo em uso só informa a fila", () => {
    expect(textoAfetados(3, true)).toBe("Hoje 3 clientes já passaram desse tempo.");
  });

  test("no teto do banco mostra 500 ou mais", () => {
    expect(textoAfetados(500, true)).toBe("Hoje 500 ou mais clientes já passaram desse tempo.");
  });
});
