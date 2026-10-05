import { describe, expect, test } from "vitest";
import {
  formatarMinutos,
  pct,
  resumoEspera,
  resumoIniciativa,
  resumoTransferencias,
} from "./relacionamento-format";

describe("formatarMinutos", () => {
  test("devolve travessão quando não há valor", () => {
    expect(formatarMinutos(null)).toBe("—");
    expect(formatarMinutos(undefined)).toBe("—");
  });

  test("trata valor negativo como ausente em vez de imprimir tempo negativo", () => {
    expect(formatarMinutos(-5)).toBe("—");
  });

  test("zero significa resposta no mesmo minuto, não ausência de dado", () => {
    // minutos_uteis_decorridos devolve FLOOR de minutos: resposta em 40s = 0.
    expect(formatarMinutos(0)).toBe("< 1min");
  });

  test("formata minutos abaixo de uma hora", () => {
    expect(formatarMinutos(1)).toBe("1min");
    expect(formatarMinutos(59)).toBe("59min");
  });

  test("omite os minutos quando a hora é exata", () => {
    expect(formatarMinutos(60)).toBe("1h");
    expect(formatarMinutos(120)).toBe("2h");
  });

  test("formata horas com minutos", () => {
    expect(formatarMinutos(98)).toBe("1h 38min");
    expect(formatarMinutos(735)).toBe("12h 15min");
  });

  test("aceita string numérica, porque numeric do Postgres chega como string no JSON", () => {
    expect(formatarMinutos("98")).toBe("1h 38min");
  });
});

describe("pct", () => {
  test("arredonda para inteiro", () => {
    expect(pct(1, 3)).toBe(33);
    expect(pct(2, 3)).toBe(67);
  });

  test("devolve zero em vez de NaN quando o total é zero", () => {
    expect(pct(0, 0)).toBe(0);
    expect(pct(5, 0)).toBe(0);
  });

  test("cobre os extremos", () => {
    expect(pct(0, 10)).toBe(0);
    expect(pct(10, 10)).toBe(100);
  });
});

describe("resumoEspera", () => {
  // Mesma ordem que o RPC devolve: até 5min … +1h30.
  const histograma = [
    { faixa: "até 5min", total: 50 },
    { faixa: "5–10min", total: 20 },
    { faixa: "10–15min", total: 10 },
    { faixa: "15–30min", total: 8 },
    { faixa: "30min–1h", total: 6 },
    { faixa: "1h–1h30", total: 4 },
    { faixa: "+1h30", total: 2 },
  ];

  test("devolve uma linha por faixa, com percentual do total", () => {
    const r = resumoEspera(histograma);

    expect(r.total).toBe(100);
    expect(r.linhas).toHaveLength(7);
    expect(r.linhas[0]).toEqual({ faixa: "até 5min", total: 50, pct: 50, tom: "rapido" });
    expect(r.linhas[6]).toEqual({ faixa: "+1h30", total: 2, pct: 2, tom: "lento" });
  });

  test("até 15min é rápido, até 1h é ok, acima de 1h é lento", () => {
    expect(resumoEspera(histograma).linhas.map((l) => l.tom)).toEqual([
      "rapido",
      "rapido",
      "rapido",
      "ok",
      "ok",
      "lento",
      "lento",
    ]);
  });

  test("percentual acumulado até 15 minutos", () => {
    expect(resumoEspera(histograma).pctAte15min).toBe(80);
  });

  test("histograma vazio não estoura nem divide por zero", () => {
    expect(resumoEspera([])).toEqual({ total: 0, linhas: [], pctAte15min: 0 });
  });
});

describe("resumoIniciativa", () => {
  test("diz quanto da operação é reativa", () => {
    const r = resumoIniciativa({
      total: 166,
      cliente: 110,
      empresa: 56,
      empresa_pelo_sistema: 4,
      empresa_fora_do_sistema: 52,
      sem_mensagem: 0,
    });
    expect(r.pctReativo).toBe(66);
    expect(r.pctProativo).toBe(34);
    // 52 de 56 contatos proativos não passaram pela plataforma
    expect(r.pctProativoForaDoSistema).toBe(93);
  });

  test("não divide por zero num período sem conversas", () => {
    const r = resumoIniciativa({
      total: 0,
      cliente: 0,
      empresa: 0,
      empresa_pelo_sistema: 0,
      empresa_fora_do_sistema: 0,
      sem_mensagem: 0,
    });
    expect(r.pctReativo).toBe(0);
    expect(r.pctProativo).toBe(0);
    expect(r.pctProativoForaDoSistema).toBe(0);
  });
});

describe("resumoTransferencias", () => {
  test("calcula média de saltos por conversa e fatia com peregrinação", () => {
    const r = resumoTransferencias({
      conversas: 166,
      com_transferencia: 8,
      duas_ou_mais: 2,
      total_saltos: 10,
    });
    expect(r.mediaPorConversa).toBe("0,06");
    expect(r.pctComTransferencia).toBe(5);
    expect(r.pctDuasOuMais).toBe(1);
  });

  test("período sem conversas não vira NaN", () => {
    const r = resumoTransferencias({
      conversas: 0,
      com_transferencia: 0,
      duas_ou_mais: 0,
      total_saltos: 0,
    });
    expect(r.mediaPorConversa).toBe("0,00");
    expect(r.pctComTransferencia).toBe(0);
    expect(r.pctDuasOuMais).toBe(0);
  });
});
