import { describe, expect, test } from "vitest";
import {
  formatarMinutos,
  formatarDelta,
  nivelRiscoQueda,
  pct,
  rotuloJanela,
  pctCauda,
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

describe("formatarDelta", () => {
  test("prefixa queda com sinal negativo", () => {
    expect(formatarDelta(-100)).toBe("-100%");
    expect(formatarDelta(-66)).toBe("-66%");
  });

  test("prefixa alta com sinal positivo", () => {
    expect(formatarDelta(5)).toBe("+5%");
  });

  test("não prefixa o zero", () => {
    expect(formatarDelta(0)).toBe("0%");
  });

  test("aceita string numérica vinda do jsonb", () => {
    expect(formatarDelta("-100")).toBe("-100%");
  });
});

describe("nivelRiscoQueda", () => {
  test("queda quase total é crítica", () => {
    expect(nivelRiscoQueda(-100)).toBe("critico");
    expect(nivelRiscoQueda(-90)).toBe("critico");
  });

  test("queda forte é alta", () => {
    expect(nivelRiscoQueda(-89)).toBe("alto");
    expect(nivelRiscoQueda(-70)).toBe("alto");
  });

  test("queda no limite do alerta é média", () => {
    expect(nivelRiscoQueda(-69)).toBe("medio");
    expect(nivelRiscoQueda(-50)).toBe("medio");
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

describe("rotuloJanela", () => {
  test("descreve as duas janelas comparadas", () => {
    expect(rotuloJanela(30)).toBe("últimos 30 dias vs os 30 anteriores");
    expect(rotuloJanela(14)).toBe("últimos 14 dias vs os 14 anteriores");
  });
});

describe("pctCauda", () => {
  const histograma = [
    { faixa: "< 1m", total: 57 },
    { faixa: "1–5m", total: 15 },
    { faixa: "5–15m", total: 9 },
    { faixa: "15–30m", total: 6 },
    { faixa: "30m–1h", total: 5 },
    { faixa: "1–2h", total: 4 },
    { faixa: "2–4h", total: 2 },
    { faixa: "4h+", total: 3 },
  ];

  test("soma a faixa informada e todas as seguintes", () => {
    // 2 + 3 = 5 de 101 = 5%
    expect(pctCauda(histograma, "2–4h")).toBe(5);
  });

  test("a partir da primeira faixa cobre a amostra inteira", () => {
    expect(pctCauda(histograma, "< 1m")).toBe(100);
  });

  test("faixa desconhecida devolve zero em vez de estourar", () => {
    expect(pctCauda(histograma, "não existe")).toBe(0);
  });

  test("histograma vazio devolve zero", () => {
    expect(pctCauda([], "4h+")).toBe(0);
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
