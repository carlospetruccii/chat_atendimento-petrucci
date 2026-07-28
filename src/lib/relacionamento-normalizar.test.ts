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
    expect(r.iniciativa.contas_reativas).toEqual([]);
    expect(r.engajamento.quedas).toEqual([]);
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
      engajamento: { limite_queda_pct: "-50", quedas: [{ delta_pct: "-100" }] },
    });

    expect(r.primeira_resposta.p95_min).toBe(98);
    expect(r.primeira_resposta.media_min).toBe(26);
    expect(r.engajamento.limite_queda_pct).toBe(-50);
    expect(r.engajamento.quedas[0].delta_pct).toBe(-100);
  });

  test("engajamento sem baseline mantém defaults sensatos", () => {
    const r = normalizarRelacionamento({ engajamento: {} });

    expect(r.engajamento.janela_dias).toBe(30);
    expect(r.engajamento.baseline_min).toBe(5);
    expect(r.engajamento.janela_reduzida).toBe(false);
    expect(r.engajamento.clientes_avaliados).toBe(0);
  });

  test("janela_reduzida só é true quando vem exatamente true", () => {
    expect(
      normalizarRelacionamento({ engajamento: { janela_reduzida: true } }).engajamento
        .janela_reduzida,
    ).toBe(true);
    expect(
      normalizarRelacionamento({ engajamento: { janela_reduzida: "true" } }).engajamento
        .janela_reduzida,
    ).toBe(false);
    expect(
      normalizarRelacionamento({ engajamento: { janela_reduzida: 1 } }).engajamento.janela_reduzida,
    ).toBe(false);
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
        contas_reativas: [
          { client_id: "c1", cliente: "João Rafael", conversas: 26, pct_cliente: 100 },
        ],
      },
      engajamento: {
        janela_dias: 14,
        janela_reduzida: true,
        baseline_min: 5,
        limite_queda_pct: -50,
        clientes_avaliados: 8,
        em_queda: 4,
        msgs_agora: 169,
        msgs_antes: 208,
        quedas: [
          {
            client_id: "c2",
            cliente: "MK Segurança e Saúde LTDA",
            agora: 0,
            antes: 19,
            delta_pct: -100,
            dias_sem_contato: 14,
          },
        ],
      },
    });

    expect(r.primeira_resposta.pior?.cliente).toBe("Larissa Comercial");
    expect(r.primeira_resposta.histograma).toHaveLength(2);
    expect(r.transferencias.peregrinacoes[0].caminho).toEqual(["Fiscal", "Contábil", "Financeiro"]);
    expect(r.iniciativa.contas_reativas[0].conversas).toBe(26);
    expect(r.engajamento.janela_dias).toBe(14);
    expect(r.engajamento.quedas[0].cliente).toBe("MK Segurança e Saúde LTDA");
  });
});
