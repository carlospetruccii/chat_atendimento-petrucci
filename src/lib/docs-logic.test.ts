import { describe, expect, test, vi } from "vitest";
import {
  acoesDaConversa,
  agruparItensDocs,
  autorDaMensagemDocs,
  avisoSomenteLeitura,
  candidatosRepasse,
  classeStatus,
  criarAgendador,
  deveNotificarDocs,
  emLotes,
  type DocsConversa,
  type DocsEvento,
  formatarHora,
  mensagemErroEnvioDocs,
  mensagemErroRpcDocs,
  mesclarMensagens,
  normalizarMotivoDocs,
  podeAcessarDocs,
  previewDaMensagem,
  rotuloEvento,
  rotuloExterno,
  rotuloStatus,
  zerarNaoLidas,
} from "./docs-logic";

const conversa = (over: Partial<DocsConversa>): DocsConversa => ({
  id: "c1",
  clientId: "cli1",
  clientNome: "Maria",
  clientNumero: "+5511999990000",
  status: "sem_dono",
  assignedTo: null,
  assignedNome: null,
  lastMessageAt: "2026-09-29T10:00:00.000Z",
  lastInboundAt: null,
  createdAt: "2026-09-01T10:00:00.000Z",
  lastMessagePreview: "",
  unread: 0,
  ...over,
});

const admin = { id: "adm", isSuperadmin: true };
const colab = { id: "u1", isSuperadmin: false };

describe("podeAcessarDocs", () => {
  test("admin sempre entra", () => {
    expect(podeAcessarDocs({ isSuperadmin: true, permissions: [] })).toBe(true);
  });
  test("colaborador só com a permissão docs_acesso", () => {
    expect(podeAcessarDocs({ isSuperadmin: false, permissions: ["docs_acesso"] })).toBe(true);
    expect(podeAcessarDocs({ isSuperadmin: false, permissions: ["view_all_departments"] })).toBe(
      false,
    );
  });
  test("sem perfil carregado não entra", () => {
    expect(podeAcessarDocs(null)).toBe(false);
  });
});

describe("rotuloStatus / classeStatus", () => {
  test("cada status tem rótulo e cor próprios", () => {
    const status = ["so_envio", "sem_dono", "em_andamento", "encerrada"] as const;
    expect(status.map(rotuloStatus)).toEqual(["Só envio", "Sem dono", "Em andamento", "Encerrada"]);
    expect(new Set(status.map(classeStatus)).size).toBe(4);
  });
});

describe("acoesDaConversa", () => {
  test("dono escreve, repassa e encerra; não precisa assumir", () => {
    const a = acoesDaConversa(conversa({ status: "em_andamento", assignedTo: "u1" }), colab);
    expect(a).toEqual({
      podeEscrever: true,
      podeAssumir: false,
      tomaDeOutro: false,
      podeRepassar: true,
      podeEncerrar: true,
      podeAlterarMensagens: true,
    });
  });

  test("colaborador olhando conversa de outra pessoa: só lê", () => {
    const a = acoesDaConversa(conversa({ status: "em_andamento", assignedTo: "u2" }), colab);
    expect(a.podeEscrever).toBe(false);
    expect(a.podeAssumir).toBe(false);
    expect(a.podeRepassar).toBe(false);
    expect(a.podeEncerrar).toBe(false);
    expect(a.podeAlterarMensagens).toBe(false);
  });

  test("admin pode tomar a conversa de outra pessoa, repassar e encerrar", () => {
    const a = acoesDaConversa(conversa({ status: "em_andamento", assignedTo: "u2" }), admin);
    expect(a.podeEscrever).toBe(false);
    expect(a.podeAssumir).toBe(true);
    expect(a.tomaDeOutro).toBe(true);
    expect(a.podeRepassar).toBe(true);
    expect(a.podeEncerrar).toBe(true);
    expect(a.podeAlterarMensagens).toBe(true);
  });

  test("sem dono: qualquer um assume; só admin repassa/encerra", () => {
    const c = acoesDaConversa(conversa({ status: "sem_dono" }), colab);
    expect(c.podeAssumir).toBe(true);
    expect(c.tomaDeOutro).toBe(false);
    expect(c.podeRepassar).toBe(false);
    expect(c.podeEncerrar).toBe(false);
    const a = acoesDaConversa(conversa({ status: "sem_dono" }), admin);
    expect(a.podeRepassar).toBe(true);
    expect(a.podeEncerrar).toBe(true);
  });

  test("encerrada e só envio não oferecem Encerrar, mas podem ser assumidas", () => {
    for (const status of ["encerrada", "so_envio"] as const) {
      const a = acoesDaConversa(conversa({ status }), admin);
      expect(a.podeEncerrar).toBe(false);
      expect(a.podeAssumir).toBe(true);
    }
  });
});

describe("avisoSomenteLeitura", () => {
  test("dono não vê aviso", () => {
    expect(avisoSomenteLeitura(conversa({ status: "em_andamento", assignedTo: "u1" }), "u1")).toBe(
      null,
    );
  });
  test("conversa com outra pessoa diz com quem está", () => {
    expect(
      avisoSomenteLeitura(
        conversa({ status: "em_andamento", assignedTo: "u2", assignedNome: "Fulano" }),
        "u1",
      ),
    ).toBe("Conversa com Fulano — só quem é dono responde.");
  });
  test("sem dono pede para assumir", () => {
    expect(avisoSomenteLeitura(conversa({ status: "sem_dono" }), "u1")).toBe(
      "Assuma a conversa para responder.",
    );
    expect(avisoSomenteLeitura(conversa({ status: "encerrada" }), "u1")).toBe(
      "Assuma a conversa para responder.",
    );
  });
  test("dono sem nome conhecido cai para 'outra pessoa'", () => {
    expect(avisoSomenteLeitura(conversa({ status: "em_andamento", assignedTo: "u2" }), "u1")).toBe(
      "Conversa com outra pessoa — só quem é dono responde.",
    );
  });
});

describe("previewDaMensagem", () => {
  const base = {
    tipo: "texto",
    content: "Oi",
    direction: "inbound",
    senderType: "cliente",
    apagadaEm: null,
  };

  test("mensagem do cliente sai sem prefixo", () => {
    expect(previewDaMensagem(base, "u1")).toBe("Oi");
  });
  test("resposta minha ganha 'Você:'; de colega ou de autor desconhecido, 'Equipe:'", () => {
    const minha = { ...base, direction: "outbound", senderType: "atendente", sentByUserId: "u1" };
    expect(previewDaMensagem(minha, "u1")).toBe("Você: Oi");
    expect(previewDaMensagem({ ...minha, sentByUserId: "u2" }, "u1")).toBe("Equipe: Oi");
    expect(previewDaMensagem({ ...minha, sentByUserId: undefined }, "u1")).toBe("Equipe: Oi");
  });
  test("externo: sistema, celular ou só 'Financeiro' quando a origem não veio", () => {
    const doc = {
      ...base,
      tipo: "documento",
      content: null,
      direction: "outbound",
      senderType: "externo",
      fileName: "boleto.pdf",
    };
    expect(previewDaMensagem({ ...doc, origem: "api_externa" }, "u1")).toBe(
      "Sistema: 📎 boleto.pdf",
    );
    expect(previewDaMensagem({ ...doc, origem: "celular", fileName: null }, "u1")).toBe(
      "Celular: 📎 Documento",
    );
    expect(previewDaMensagem(doc, "u1")).toBe("Financeiro: 📎 boleto.pdf");
  });
  test("mídia sem legenda vira rótulo; apagada vira marcador", () => {
    expect(previewDaMensagem({ ...base, tipo: "audio", content: null }, "u1")).toBe("🎤 Áudio");
    expect(previewDaMensagem({ ...base, tipo: "imagem", content: null }, "u1")).toBe("📷 Imagem");
    expect(previewDaMensagem({ ...base, tipo: "video", content: null }, "u1")).toBe("🎥 Vídeo");
    expect(previewDaMensagem({ ...base, tipo: "sticker", content: null }, "u1")).toBe("Figurinha");
    expect(previewDaMensagem({ ...base, tipo: "localizacao", content: null }, "u1")).toBe(
      "(localizacao)",
    );
    expect(previewDaMensagem({ ...base, apagadaEm: "2026-09-29T00:00:00Z" }, "u1")).toBe(
      "🚫 Mensagem apagada",
    );
  });
  test("aviso do sistema e sem mensagem nenhuma", () => {
    expect(previewDaMensagem({ ...base, direction: "outbound", senderType: "sistema" }, "u1")).toBe(
      "Sistema: Oi",
    );
    expect(previewDaMensagem(null, "u1")).toBe("");
  });
});

describe("rotuloExterno", () => {
  test("distingue o outro sistema do celular do financeiro", () => {
    expect(rotuloExterno({ origem: "api_externa" })).toBe("Enviado pelo sistema financeiro");
    expect(rotuloExterno({ origem: "celular" })).toBe("Enviado pelo celular do financeiro");
    expect(rotuloExterno(null)).toBe("Enviado fora do sistema");
  });
});

describe("autorDaMensagemDocs", () => {
  const params = { meuUserId: "u1", clienteNome: "Maria" };
  const msg = {
    direction: "outbound",
    senderType: "atendente",
    sentByUserId: "u1",
    sentByNome: "Ana",
    mediaMetadata: null,
  };
  test("rótulos de cada remetente", () => {
    expect(autorDaMensagemDocs(msg, params)).toBe("Você");
    expect(autorDaMensagemDocs({ ...msg, sentByUserId: "u2" }, params)).toBe("Ana");
    expect(autorDaMensagemDocs({ ...msg, sentByUserId: "u2", sentByNome: null }, params)).toBe(
      "Atendente",
    );
    expect(autorDaMensagemDocs({ ...msg, senderType: "sistema" }, params)).toBe("Sistema");
    expect(
      autorDaMensagemDocs(
        { ...msg, senderType: "externo", mediaMetadata: { origem: "api_externa" } },
        params,
      ),
    ).toBe("Sistema financeiro");
    expect(autorDaMensagemDocs({ ...msg, senderType: "externo" }, params)).toBe(
      "Celular do financeiro",
    );
    expect(
      autorDaMensagemDocs({ ...msg, direction: "inbound", senderType: "cliente" }, params),
    ).toBe("Maria");
  });
});

describe("deveNotificarDocs", () => {
  test("mensagem do cliente em conversa sem dono avisa todo mundo com acesso", () => {
    expect(
      deveNotificarDocs({
        direction: "inbound",
        status: "sem_dono",
        assignedTo: null,
        meuUserId: "u1",
      }),
    ).toBe(true);
  });
  test("em andamento: só o dono é avisado", () => {
    const base = { direction: "inbound", status: "em_andamento" as const, assignedTo: "u2" };
    expect(deveNotificarDocs({ ...base, meuUserId: "u2" })).toBe(true);
    expect(deveNotificarDocs({ ...base, meuUserId: "u1" })).toBe(false);
  });
  test("nossas mensagens e conversas sem status não avisam", () => {
    expect(
      deveNotificarDocs({
        direction: "outbound",
        status: "sem_dono",
        assignedTo: null,
        meuUserId: "u1",
      }),
    ).toBe(false);
    expect(
      deveNotificarDocs({ direction: "inbound", status: null, assignedTo: null, meuUserId: "u1" }),
    ).toBe(false);
    expect(
      deveNotificarDocs({
        direction: "inbound",
        status: "encerrada",
        assignedTo: null,
        meuUserId: "u1",
      }),
    ).toBe(false);
  });
});

describe("candidatosRepasse", () => {
  const pessoas = [
    {
      userId: "u1",
      nome: "Zé",
      departamentoNome: "Financeiro",
      isSuperadmin: false,
      temAcesso: true,
    },
    {
      userId: "u2",
      nome: "Ana",
      departamentoNome: "Financeiro",
      isSuperadmin: false,
      temAcesso: true,
    },
    { userId: "u3", nome: "Bia", departamentoNome: null, isSuperadmin: true, temAcesso: true },
    {
      userId: "u4",
      nome: "Caio",
      departamentoNome: "Fiscal",
      isSuperadmin: false,
      temAcesso: false,
    },
  ];

  test("só quem tem acesso, sem o dono atual, agrupado por departamento em ordem alfabética", () => {
    const r = candidatosRepasse(pessoas, { donoAtual: "u1", busca: "" });
    expect(r).toEqual([
      { departamento: "Financeiro", pessoas: [pessoas[1]] },
      { departamento: "Sem departamento", pessoas: [pessoas[2]] },
    ]);
  });

  test("busca por nome ignora acento", () => {
    const r = candidatosRepasse(pessoas, { donoAtual: null, busca: "ze" });
    expect(r.flatMap((g) => g.pessoas.map((p) => p.userId))).toEqual(["u1"]);
  });
});

describe("rotuloEvento", () => {
  const ev = (over: Partial<DocsEvento>): DocsEvento => ({
    id: "e1",
    tipo: "assumida",
    actorUserId: "u2",
    actorNome: "Ana",
    targetUserId: null,
    targetNome: null,
    observacao: null,
    createdAt: "2026-09-29T10:00:00.000Z",
    ...over,
  });

  test("cada tipo vira uma frase curta", () => {
    expect(rotuloEvento(ev({ tipo: "iniciada" }), "u1")).toBe("Ana iniciou a conversa");
    expect(rotuloEvento(ev({ tipo: "assumida", actorUserId: "u1" }), "u1")).toBe(
      "Você assumiu a conversa",
    );
    expect(rotuloEvento(ev({ tipo: "assumida", observacao: "Tomada de Zé" }), "u1")).toBe(
      "Ana assumiu a conversa · Tomada de Zé",
    );
    expect(
      rotuloEvento(ev({ tipo: "repassada", targetUserId: "u1", observacao: "cliente VIP" }), "u1"),
    ).toBe("Ana repassou para você · “cliente VIP”");
    expect(
      rotuloEvento(ev({ tipo: "repassada", targetNome: "Zé", targetUserId: "u3" }), "u1"),
    ).toBe("Ana repassou para Zé");
    expect(rotuloEvento(ev({ tipo: "encerrada", actorNome: null }), "u1")).toBe(
      "Alguém encerrou a conversa",
    );
    expect(rotuloEvento(ev({ tipo: "reaberta", actorUserId: null }), "u1")).toBe(
      "Cliente respondeu — conversa voltou para Sem dono",
    );
    expect(
      rotuloEvento(ev({ tipo: "reaberta", observacao: "O dono perdeu o acesso ao Docs" }), "u1"),
    ).toBe("O dono perdeu o acesso ao Docs");
  });
});

describe("agruparItensDocs", () => {
  const msg = (id: string, createdAt: string, over: Record<string, unknown> = {}) => ({
    id,
    createdAt,
    direction: "inbound" as const,
    senderType: "cliente",
    sentByUserId: null as string | null,
    ...over,
  });
  const evento: DocsEvento = {
    id: "e1",
    tipo: "assumida",
    actorUserId: "u1",
    actorNome: "Ana",
    targetUserId: "u1",
    targetNome: "Ana",
    observacao: null,
    createdAt: "2026-09-29T12:30:00.000Z",
  };

  test("intercala dia, eventos e mensagens em ordem e cola bolhas do mesmo autor", () => {
    const itens = agruparItensDocs(
      [
        msg("m1", "2026-09-29T12:00:00.000Z"),
        msg("m2", "2026-09-29T12:10:00.000Z"),
        msg("m3", "2026-09-29T13:00:00.000Z"),
      ],
      [evento],
      { desde: null, meuUserId: "u1" },
    );
    expect(itens.map((i) => i.kind)).toEqual([
      "date-separator",
      "message",
      "message",
      "evento",
      "message",
    ]);
    const mensagens = itens.filter((i) => i.kind === "message");
    expect(mensagens.map((m) => (m.kind === "message" ? m.colada : null))).toEqual([
      false,
      true,
      false,
    ]);
    const ev = itens.find((i) => i.kind === "evento");
    expect(ev && ev.kind === "evento" ? ev.label : "").toBe("Você assumiu a conversa");
  });

  test("evento de antes da página carregada fica de fora", () => {
    const itens = agruparItensDocs([msg("m1", "2026-09-29T13:00:00.000Z")], [evento], {
      desde: "2026-09-29T13:00:00.000Z",
      meuUserId: "u1",
    });
    expect(itens.some((i) => i.kind === "evento")).toBe(false);
  });

  test("dia novo abre separador e quebra a colagem", () => {
    const itens = agruparItensDocs(
      [msg("m1", "2026-09-28T15:00:00.000Z"), msg("m2", "2026-09-29T15:00:00.000Z")],
      [],
      { desde: null, meuUserId: "u1" },
    );
    expect(itens.filter((i) => i.kind === "date-separator")).toHaveLength(2);
    const ultima = itens[itens.length - 1];
    expect(ultima.kind === "message" && ultima.colada).toBe(false);
  });
});

describe("mesclarMensagens", () => {
  test("deduplica pelo id (a versão nova vence) e ordena por data", () => {
    const a = { id: "a", createdAt: "2026-09-29T10:00:00Z", content: "velho" };
    const b = { id: "b", createdAt: "2026-09-29T09:00:00Z", content: "b" };
    const a2 = { ...a, content: "novo" };
    expect(mesclarMensagens([a], [b, a2])).toEqual([b, a2]);
  });
  test("nada a mesclar devolve a mesma lista", () => {
    const prev = [{ id: "a", createdAt: "x" }];
    expect(mesclarMensagens(prev, [])).toBe(prev);
  });
});

describe("mensagens de erro", () => {
  test("RPCs traduzem os códigos do banco", () => {
    expect(mensagemErroRpcDocs("assumir", "23505")).toMatch(/outra pessoa/);
    expect(mensagemErroRpcDocs("assumir", "42501")).toMatch(/acesso/);
    expect(mensagemErroRpcDocs("repassar", "42501")).toMatch(/dono/);
    expect(mensagemErroRpcDocs("repassar", "22023")).toMatch(/não tem acesso/);
    expect(mensagemErroRpcDocs("repassar", "23505")).toMatch(/já está com essa pessoa/);
    expect(mensagemErroRpcDocs("encerrar", "42501")).toMatch(/dono/);
    expect(mensagemErroRpcDocs("iniciar", "P0002")).toMatch(/Contato não encontrado/);
    expect(mensagemErroRpcDocs("iniciar", "23505")).toMatch(/outra pessoa/);
    expect(mensagemErroRpcDocs("encerrar", "P0002")).toMatch(/não encontrada/);
    expect(mensagemErroRpcDocs("encerrar", "XX000")).toBe("Não foi possível encerrar a conversa.");
  });

  test("envio traduz os códigos da docs-enviar", () => {
    expect(mensagemErroEnvioDocs("nao_e_dono")).toMatch(/dono/);
    expect(mensagemErroEnvioDocs("arquivo_muito_grande")).toMatch(/16 MB/);
    expect(mensagemErroEnvioDocs("erro_interno")).toMatch(/servidor/);
    expect(mensagemErroEnvioDocs(undefined)).toBe("Não foi possível enviar a mensagem.");
  });

  test("motivo 'nao_encontrada' da docs-acao vira o vocabulário da Inbox", () => {
    expect(normalizarMotivoDocs("nao_encontrada")).toEqual({ motivo: "mensagem_nao_encontrada" });
    expect(normalizarMotivoDocs("sem_permissao").detalhe).toMatch(/dono/);
    expect(normalizarMotivoDocs("nao_e_dono").detalhe).toMatch(/dono/);
    expect(normalizarMotivoDocs("fora_da_janela")).toEqual({ motivo: "fora_da_janela" });
    expect(normalizarMotivoDocs(undefined)).toEqual({ motivo: undefined });
  });
});

describe("formatarHora", () => {
  const agora = new Date("2026-09-29T15:00:00-03:00");
  test("hoje mostra a hora, ontem diz 'Ontem', antes mostra a data", () => {
    expect(formatarHora("2026-09-29T09:05:00-03:00", agora)).toBe("09:05");
    expect(formatarHora("2026-09-28T09:05:00-03:00", agora)).toBe("Ontem");
    expect(formatarHora("2026-09-20T09:05:00-03:00", agora)).toBe("20/09");
    expect(formatarHora(null, agora)).toBe("");
  });
});

describe("emLotes", () => {
  test("corta em pedaços do tamanho pedido, o último menor", () => {
    expect(emLotes([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(emLotes([], 2)).toEqual([]);
  });
  test("tamanho inválido devolve um lote só", () => {
    expect(emLotes([1, 2], 0)).toEqual([[1, 2]]);
  });
});

describe("zerarNaoLidas", () => {
  test("zera só a conversa pedida, sem mudar a lista recebida", () => {
    const lista = [conversa({ id: "a", unread: 2 }), conversa({ id: "b", unread: 1 })];
    const r = zerarNaoLidas(lista, "a");
    expect(r.map((c) => c.unread)).toEqual([0, 1]);
    expect(lista[0].unread).toBe(2);
  });
  test("nada a zerar devolve a mesma lista (o cache não re-renderiza à toa)", () => {
    const lista = [conversa({ id: "a", unread: 0 })];
    expect(zerarNaoLidas(lista, "a")).toBe(lista);
    expect(zerarNaoLidas(lista, "x")).toBe(lista);
  });
});

describe("criarAgendador", () => {
  test("vários pedidos na janela viram uma execução só, no fim", () => {
    vi.useFakeTimers();
    const acao = vi.fn();
    const ag = criarAgendador(acao, 1500);
    ag.agendar();
    vi.advanceTimersByTime(1000);
    ag.agendar();
    ag.agendar();
    expect(acao).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(acao).toHaveBeenCalledTimes(1);
    ag.agendar();
    vi.advanceTimersByTime(1500);
    expect(acao).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
  test("cancelar descarta o pendente", () => {
    vi.useFakeTimers();
    const acao = vi.fn();
    const ag = criarAgendador(acao, 1500);
    ag.agendar();
    ag.cancelar();
    vi.advanceTimersByTime(2000);
    expect(acao).not.toHaveBeenCalled();
    ag.cancelar();
    vi.useRealTimers();
  });
});
