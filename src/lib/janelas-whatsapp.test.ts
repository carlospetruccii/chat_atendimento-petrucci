import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  avaliarAcao,
  expiraEm,
  JANELA_APAGAR_MS,
  JANELA_EDITAR_MS,
  MARGEM_JANELA_MS,
  type MensagemAvaliavel,
  textoMotivo,
} from "@/lib/janelas-whatsapp";

const MARCADOR = "// ═══ NUCLEO COMPARTILHADO";

function nucleoDe(caminhoRelativoAoRepo: string): string {
  const raiz = fileURLToPath(new URL("../..", import.meta.url));
  const texto = readFileSync(raiz + caminhoRelativoAoRepo, "utf-8");
  const i = texto.indexOf(MARCADOR);
  if (i < 0) throw new Error(`marcador do núcleo não achado em ${caminhoRelativoAoRepo}`);
  return texto.slice(i);
}

describe("janelas-whatsapp / gêmeo backend", () => {
  // A regra de prazo mora em dois arquivos (Deno não alcança src/ no bundle da
  // edge function). Se um lado mudar sozinho, o backend recusa uma ação que a
  // tela ofereceu — ou o contrário, e o botão desaparece sem motivo.
  test("o núcleo é idêntico nos dois arquivos", () => {
    const frontend = nucleoDe("src/lib/janelas-whatsapp.ts");
    const backend = nucleoDe("supabase/functions/_shared/janelas-whatsapp.ts");

    expect(frontend).toBe(backend);
  });
});

// Base elegível: saída nossa, entregue, texto, com id do WhatsApp.
const AGORA = Date.parse("2026-08-06T12:00:00.000Z");

function mensagem(over: Partial<MensagemAvaliavel> = {}): MensagemAvaliavel {
  return {
    criadaEm: new Date(AGORA - 60_000).toISOString(),
    direction: "outbound",
    senderType: "atendente",
    tipo: "texto",
    statusEnvio: "enviado",
    apagadaEm: null,
    temIdWhatsapp: true,
    ...over,
  };
}

describe("avaliarAcao / janela de tempo", () => {
  test("permite apagar uma mensagem recém-enviada", () => {
    const r = avaliarAcao("apagar", mensagem(), AGORA);

    expect(r).toEqual({ pode: true });
  });

  test("permite apagar no limite de 60 horas menos a margem", () => {
    const criadaEm = new Date(AGORA - JANELA_APAGAR_MS + MARGEM_JANELA_MS + 1_000).toISOString();

    const r = avaliarAcao("apagar", mensagem({ criadaEm }), AGORA);

    expect(r.pode).toBe(true);
  });

  test("bloqueia apagar quando passou de 60 horas", () => {
    const criadaEm = new Date(AGORA - JANELA_APAGAR_MS - 1_000).toISOString();

    const r = avaliarAcao("apagar", mensagem({ criadaEm }), AGORA);

    expect(r).toEqual({ pode: false, motivo: "fora_da_janela" });
  });

  test("bloqueia apagar já dentro da margem de segurança", () => {
    const criadaEm = new Date(AGORA - JANELA_APAGAR_MS + MARGEM_JANELA_MS - 1_000).toISOString();

    const r = avaliarAcao("apagar", mensagem({ criadaEm }), AGORA);

    expect(r).toEqual({ pode: false, motivo: "fora_da_janela" });
  });

  test("permite editar dentro dos 15 minutos", () => {
    const criadaEm = new Date(AGORA - 5 * 60_000).toISOString();

    const r = avaliarAcao("editar", mensagem({ criadaEm }), AGORA);

    expect(r.pode).toBe(true);
  });

  test("bloqueia editar depois dos 15 minutos, mesmo podendo apagar", () => {
    const criadaEm = new Date(AGORA - 20 * 60_000).toISOString();
    const msg = mensagem({ criadaEm });

    expect(avaliarAcao("editar", msg, AGORA)).toEqual({
      pode: false,
      motivo: "fora_da_janela",
    });
    expect(avaliarAcao("apagar", msg, AGORA).pode).toBe(true);
  });

  test("trata created_at inválido como fora da janela", () => {
    const r = avaliarAcao("apagar", mensagem({ criadaEm: "nao-e-data" }), AGORA);

    expect(r).toEqual({ pode: false, motivo: "fora_da_janela" });
  });
});

describe("avaliarAcao / autoria e estado", () => {
  test("bloqueia mensagem do cliente", () => {
    const r = avaliarAcao(
      "apagar",
      mensagem({ direction: "inbound", senderType: "cliente" }),
      AGORA,
    );

    expect(r).toEqual({ pode: false, motivo: "nao_e_saida_nossa" });
  });

  test("permite apagar mensagem que saiu do celular da empresa", () => {
    const msg = mensagem({ senderType: "externo", origemExterna: "celular" });

    const r = avaliarAcao("apagar", msg, AGORA);

    expect(r).toEqual({ pode: true });
  });

  test("bloqueia apagar mensagem do outro sistema que usa a mesma instância", () => {
    const msg = mensagem({ senderType: "externo", origemExterna: "api_externa" });

    const r = avaliarAcao("apagar", msg, AGORA);

    expect(r).toEqual({ pode: false, motivo: "nao_e_saida_nossa" });
  });

  test("bloqueia apagar mensagem externa antiga, sem origem registrada", () => {
    // Linhas anteriores a 30/07/2026 não têm `media_metadata.origem`: não dá
    // para saber se foi o celular ou o outro sistema, então não se toca.
    expect(avaliarAcao("apagar", mensagem({ senderType: "externo" }), AGORA)).toEqual({
      pode: false,
      motivo: "nao_e_saida_nossa",
    });
    expect(
      avaliarAcao("apagar", mensagem({ senderType: "externo", origemExterna: null }), AGORA),
    ).toEqual({ pode: false, motivo: "nao_e_saida_nossa" });
  });

  test("bloqueia EDITAR mensagem do celular, mesmo podendo apagar", () => {
    const msg = mensagem({ senderType: "externo", origemExterna: "celular" });

    expect(avaliarAcao("editar", msg, AGORA)).toEqual({
      pode: false,
      motivo: "nao_e_saida_nossa",
    });
    expect(avaliarAcao("apagar", msg, AGORA).pode).toBe(true);
  });

  test("mensagem do celular respeita a janela de 60h igual às nossas", () => {
    const criadaEm = new Date(AGORA - JANELA_APAGAR_MS - 1_000).toISOString();
    const msg = mensagem({ senderType: "externo", origemExterna: "celular", criadaEm });

    expect(avaliarAcao("apagar", msg, AGORA)).toEqual({
      pode: false,
      motivo: "fora_da_janela",
    });
  });

  test("origem 'celular' não salva mensagem do cliente (inbound)", () => {
    const msg = mensagem({
      direction: "inbound",
      senderType: "cliente",
      origemExterna: "celular",
    });

    expect(avaliarAcao("apagar", msg, AGORA)).toEqual({
      pode: false,
      motivo: "nao_e_saida_nossa",
    });
  });

  test("permite apagar mensagem do bot e do sistema", () => {
    expect(avaliarAcao("apagar", mensagem({ senderType: "bot" }), AGORA).pode).toBe(true);
    expect(avaliarAcao("apagar", mensagem({ senderType: "sistema" }), AGORA).pode).toBe(true);
  });

  test("bloqueia mensagem que ainda não saiu", () => {
    const r = avaliarAcao("apagar", mensagem({ statusEnvio: "aguardando_envio" }), AGORA);

    expect(r).toEqual({ pode: false, motivo: "nao_enviada" });
  });

  test("bloqueia mensagem sem id do WhatsApp", () => {
    const r = avaliarAcao("apagar", mensagem({ temIdWhatsapp: false }), AGORA);

    expect(r).toEqual({ pode: false, motivo: "sem_id_whatsapp" });
  });

  test("bloqueia mensagem já apagada antes de qualquer outra checagem", () => {
    const msg = mensagem({ apagadaEm: new Date(AGORA).toISOString(), statusEnvio: "falha" });

    expect(avaliarAcao("apagar", msg, AGORA)).toEqual({ pode: false, motivo: "ja_apagada" });
    expect(avaliarAcao("editar", msg, AGORA)).toEqual({ pode: false, motivo: "ja_apagada" });
  });
});

describe("avaliarAcao / tipo editável", () => {
  test("bloqueia editar mídia, mas deixa apagar", () => {
    const msg = mensagem({ tipo: "imagem" });

    expect(avaliarAcao("editar", msg, AGORA)).toEqual({
      pode: false,
      motivo: "tipo_nao_editavel",
    });
    expect(avaliarAcao("apagar", msg, AGORA).pode).toBe(true);
  });

  test("bloqueia editar menu de opções, que é texto no banco mas não na tela", () => {
    const r = avaliarAcao("editar", mensagem({ ehListaOpcoes: true }), AGORA);

    expect(r).toEqual({ pode: false, motivo: "tipo_nao_editavel" });
  });
});

describe("expiraEm e textoMotivo", () => {
  test("expiraEm devolve o instante do fim da janela já com a margem", () => {
    const criadaEm = new Date(AGORA).toISOString();

    expect(expiraEm("apagar", criadaEm)).toBe(AGORA + JANELA_APAGAR_MS - MARGEM_JANELA_MS);
    expect(expiraEm("editar", criadaEm)).toBe(AGORA + JANELA_EDITAR_MS - MARGEM_JANELA_MS);
  });

  test("o texto de fora_da_janela cita o prazo certo de cada ação", () => {
    expect(textoMotivo("apagar", "fora_da_janela")).toContain("2 dias e 12 horas");
    expect(textoMotivo("editar", "fora_da_janela")).toContain("15 minutos");
  });

  test("o texto de nao_e_saida_nossa só cita o celular na ação que o aceita", () => {
    expect(textoMotivo("apagar", "nao_e_saida_nossa")).toContain("celular da empresa");
    expect(textoMotivo("editar", "nao_e_saida_nossa")).not.toContain("celular");
  });
});
