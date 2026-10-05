import { describe, expect, test } from "vitest";
import { normalizarRelacionamento } from "./relacionamento-queries";

/**
 * A normalização é a rede de proteção da seção: o RPC devolve jsonb sem
 * garantia de forma, então qualquer drift de schema tem que degradar para
 * "sem dados" em vez de derrubar a dashboard.
 */
describe("normalizarRelacionamento", () => {
  test("payload nulo devolve estrutura completa e zerada", () => {
    const r = normalizarRelacionamento(null);

    expect(r.primeira_resposta.total).toBe(0);
    expect(r.primeira_resposta.histograma).toEqual([]);
    expect(r.primeira_resposta.pior).toBeNull();
    expect(r.transferencias.peregrinacoes).toEqual([]);
  });

  test("percentis ausentes ficam null, não zero", () => {
    // Zero significaria "responderam no mesmo minuto"; ausência é outra coisa.
    const r = normalizarRelacionamento({ primeira_resposta: { total: 0 } });

    expect(r.primeira_resposta.p95_min).toBeNull();
    expect(r.primeira_resposta.media_min).toBeNull();
    expect(r.primeira_resposta.max_min).toBeNull();
  });

  test("percentil zero é preservado como zero", () => {
    const r = normalizarRelacionamento({ primeira_resposta: { p50_min: 0 } });
    expect(r.primeira_resposta.p50_min).toBe(0);
  });

  test("numeric do Postgres chega como string e é convertido", () => {
    const r = normalizarRelacionamento({
      primeira_resposta: { p95_min: "98", media_min: "26" },
    });

    expect(r.primeira_resposta.p95_min).toBe(98);
    expect(r.primeira_resposta.media_min).toBe(26);
  });

  test("campos que deveriam ser lista mas vieram como objeto não estouram", () => {
    const r = normalizarRelacionamento({
      primeira_resposta: { histograma: { faixa: "< 1m" } },
      transferencias: { peregrinacoes: "nada disso" },
    });

    expect(r.primeira_resposta.histograma).toEqual([]);
    expect(r.transferencias.peregrinacoes).toEqual([]);
  });

  test("preserva um payload real completo", () => {
    const r = normalizarRelacionamento({
      primeira_resposta: {
        total: 101,
        sem_resposta: 65,
        p50_min: 0,
        p95_min: 98,
        max_min: 735,
        media_min: 26,
        pior: {
          atendimento_id: "a0cfb20b-7f1f-437c-b69f-ece75cd96772",
          cliente: "Larissa Comercial",
          min: 735,
          quando: "2026-07-07T11:09:54.504904+00:00",
        },
        histograma: [
          { faixa: "< 1m", total: 57 },
          { faixa: "4h+", total: 3 },
        ],
      },
      transferencias: {
        conversas: 166,
        com_transferencia: 8,
        duas_ou_mais: 0,
        total_saltos: 8,
        distribuicao: [{ faixa: "0", total: 158 }],
        peregrinacoes: [
          {
            atendimento_id: "x",
            cliente: "Padaria",
            saltos: 2,
            caminho: ["Fiscal", "Contábil", "Financeiro"],
            quando: "2026-07-10T10:00:00Z",
          },
        ],
      },
      iniciativa: {
        total: 166,
        cliente: 110,
        empresa: 56,
        empresa_pelo_sistema: 4,
        empresa_fora_do_sistema: 52,
        sem_mensagem: 0,
      },
    });

    expect(r.primeira_resposta.pior?.cliente).toBe("Larissa Comercial");
    expect(r.primeira_resposta.histograma).toHaveLength(2);
    expect(r.transferencias.peregrinacoes[0].caminho).toEqual(["Fiscal", "Contábil", "Financeiro"]);
  });
});
