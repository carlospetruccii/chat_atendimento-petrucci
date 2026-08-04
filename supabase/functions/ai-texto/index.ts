// Edge Function: ai-texto
// Assistente de escrita do composer (IA do Lovable — ai.gateway.lovable.dev).
//
// Contrato com o frontend (sempre responde 200 com { ok, texto?, erro? }
// para o cliente não precisar tratar FunctionsHttpError):
//
//   POST multipart/form-data { file: Blob }        → transcreve o áudio ditado
//     pelo atendente e devolve o texto já corrigido/pontuado em pt-BR.
//
//   POST application/json { texto: string }        → devolve uma sugestão da
//     mensagem otimizada (ortografia, clareza, profissionalismo).
//
// Requer o secret LOVABLE_API_KEY (gerado pelo Lovable para o projeto).
// JWT é validado pelo gateway do Supabase (verify_jwt padrão).

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GATEWAY = "https://ai.gateway.lovable.dev/v1";
const MODELO_CHAT = "google/gemini-3.6-flash";
const MODELO_TRANSCRICAO = "openai/gpt-4o-transcribe";
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
const MAX_TEXTO_CHARS = 4000;

// Anexar o áudio no 2º passo custa ~4/3 do tamanho em base64. A gravação do
// atendente tem segundos; um arquivo grande viraria um pedido de dezenas de MB
// que o gateway recusa. Acima deste corte a revisão é feita só com o texto.
const MAX_AUDIO_INLINE_BYTES = 6 * 1024 * 1024;

// Vocabulário do dia a dia da contabilidade: vai no campo `prompt` da
// transcrição para o modelo não trocar sigla por palavra parecida.
const TERMOS_CONTABEIS =
  "DAS, DCTF, DCTFWeb, PGDAS, PGDAS-D, Simples Nacional, MEI, e-Social, FGTS, GFIP, SEFIP, INSS, IRPJ, CSLL, PIS, COFINS, ICMS, ISS, IRRF, DIRF, RAIS, CAGED, CNPJ, CPF, NF-e, NFS-e, SPED, ECD, ECF, CCT, eCAC, Sefaz, Receita Federal, Junta Comercial, Domicílio Tributário, Conectividade Social, certidão negativa, parcelamento, pró-labore, holerite, décimo terceiro, rescisão, alvará, guia, boleto, competência, retenção";

// Fidelidade ao que a pessoa escreveu. Sem isso o modelo "melhora" o texto
// trocando termo técnico por sinônimo — num teste real ele transformou
// "o DAS de junho" em "sua fatura de junho" (DAS é guia de imposto, não
// fatura) e "mando o boleto" em "enviaremos o boleto".
const REGRA_FIDELIDADE = `FIDELIDADE (obrigatório):
Não troque termos técnicos, siglas nem nomes próprios por sinônimos. DAS, DCTF, PGDAS, CCT, e-Social, FGTS, Simples Nacional, nomes de sistemas, de bancos e de empresas ficam EXATAMENTE como estão — corrija apenas maiúsculas e acentos.
Quem escreveu "DAS" não quis dizer "fatura" nem "guia"; quem escreveu "extrato" não quis dizer "relatório".
Mantenha a pessoa do verbo: se a pessoa escreveu em primeira pessoa do singular ("mando", "verifiquei", "te retorno"), não passe para plural ("enviaremos", "verificamos").
Não invente prazo, valor, nome, banco nem passo que não esteja no texto.`;

// Formato das mensagens da equipe: blocos curtos separados por linha em branco,
// um assunto por bloco, na ordem em que o cliente vai executar. Vale para os
// dois prompts — texto revisado e áudio transcrito saem no mesmo padrão.
const REGRA_FORMATO = `FORMATO DA MENSAGEM (obrigatório):
Quebre o texto em blocos curtos separados por LINHA EM BRANCO, um assunto por bloco, no máximo 2 frases cada.
Quando há passos a seguir, cada passo é um bloco, na ordem em que a pessoa deve executar.
Se a mensagem toda tem 2 frases ou menos, deixe em um único bloco — não invente separação.
Não use marcadores de lista (-, *, 1.), títulos, nem linhas de assunto. É conversa de WhatsApp, não documento.
Use *negrito* só em nomes de sistema/aplicativo, prazos e valores QUE JÁ ESTEJAM no texto — nunca para criar destaque novo.`;

const PROMPT_CORRECAO_AUDIO = `Você recebe a transcrição bruta de um áudio ditado por um atendente de suporte que será enviado como MENSAGEM DE TEXTO no WhatsApp para um cliente.
Sua tarefa: corrigir o português (pt-BR), pontuar e organizar o texto, removendo vícios de fala ("é...", "hã", repetições), mantendo FIELMENTE o sentido e todas as informações ditas.
Não adicione saudações, despedidas nem informações novas. Não comente nada.

Quando o ÁUDIO ORIGINAL vier junto neste pedido, OUÇA o áudio antes de escrever: ele é a fonte da verdade do sentido. Se a pessoa se corrigiu no meio da fala, mantenha só a versão corrigida; se ela afirmou, não transforme em dúvida (nem o contrário). A transcrição bruta serve de referência para a grafia de números, siglas e nomes próprios — nunca para adivinhar o sentido.

${REGRA_FIDELIDADE}

${REGRA_FORMATO}

Responda APENAS com o texto final da mensagem.`;

const PROMPT_OTIMIZACAO = `Você revisa mensagens que um atendente de suporte envia a clientes pelo WhatsApp, em português do Brasil.
Reescreva a mensagem corrigindo ortografia e gramática e melhorando clareza e profissionalismo, mantendo o tom cordial e TODO o conteúdo e sentido original.
Não adicione informações, saudações ou despedidas que não existam na mensagem. Preserve a formatação do WhatsApp (*negrito*, _itálico_) e os emojis usados.

${REGRA_FIDELIDADE}

${REGRA_FORMATO}

Responda APENAS com a mensagem reescrita, sem comentários.`;

function resposta(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function erroGateway(status: number): string {
  if (status === 429) return "Muitas solicitações de IA. Aguarde alguns segundos e tente de novo.";
  if (status === 402) return "Créditos de IA esgotados no Lovable.";
  return `Falha na IA (${status}).`;
}

async function chatCompletion(apiKey: string, system: string, user: string): Promise<string> {
  const resp = await fetch(`${GATEWAY}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODELO_CHAT,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) {
    const detalhe = await resp.text().catch(() => "");
    console.error(`[ai-texto] chat ${resp.status}: ${detalhe.slice(0, 300)}`);
    throw new Error(erroGateway(resp.status));
  }
  const data = await resp.json();
  const texto = data?.choices?.[0]?.message?.content?.trim();
  if (!texto) throw new Error("A IA não retornou texto.");
  return texto;
}

async function transcrever(apiKey: string, file: File): Promise<string> {
  const mime = (file.type || "").split(";")[0];
  const extMap: Record<string, string> = {
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mp4": "mp4",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
  };
  const ext = extMap[mime] ?? "webm";

  const form = new FormData();
  form.append("model", MODELO_TRANSCRICAO);
  form.append("file", file, `gravacao.${ext}`);
  form.append("language", "pt");

  const resp = await fetch(`${GATEWAY}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) {
    const detalhe = await resp.text().catch(() => "");
    console.error(`[ai-texto] transcricao ${resp.status}: ${detalhe.slice(0, 300)}`);
    throw new Error(erroGateway(resp.status));
  }
  const data = await resp.json();
  return (data?.text ?? "").trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return resposta({ ok: false, erro: "Método não suportado." });
  }

  const apiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!apiKey) {
    console.error("[ai-texto] LOVABLE_API_KEY não configurada");
    return resposta({ ok: false, erro: "IA não configurada (LOVABLE_API_KEY ausente)." });
  }

  try {
    const contentType = req.headers.get("Content-Type") ?? "";

    // Rejeita corpos gigantes ANTES de materializar o multipart em memória.
    const contentLength = Number(req.headers.get("Content-Length") ?? "0");
    if (contentLength > MAX_AUDIO_BYTES + 64 * 1024) {
      return resposta({ ok: false, erro: "Áudio acima do limite (24 MB)." });
    }

    // Áudio ditado → transcrição + correção pt-BR.
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File) || file.size < 200) {
        return resposta({ ok: false, erro: "Áudio vazio ou inválido." });
      }
      if (file.size > MAX_AUDIO_BYTES) {
        return resposta({ ok: false, erro: "Áudio acima do limite (24 MB)." });
      }

      const bruto = await transcrever(apiKey, file);
      if (!bruto) {
        return resposta({ ok: false, erro: "Não foi possível entender o áudio. Tente gravar de novo." });
      }
      // Correção é melhoria: se o chat falhar, a transcrição bruta ainda serve.
      let texto = bruto;
      try {
        texto = await chatCompletion(apiKey, PROMPT_CORRECAO_AUDIO, bruto);
      } catch (e) {
        console.error(`[ai-texto] correcao falhou, usando transcricao bruta: ${e}`);
      }
      return resposta({ ok: true, texto });
    }

    // Texto digitado → sugestão otimizada.
    const payload = await req.json().catch(() => null);
    const texto = typeof payload?.texto === "string" ? payload.texto.trim() : "";
    if (!texto) {
      return resposta({ ok: false, erro: "Texto vazio." });
    }
    if (texto.length > MAX_TEXTO_CHARS) {
      return resposta({ ok: false, erro: "Mensagem longa demais para otimizar." });
    }

    const sugestao = await chatCompletion(apiKey, PROMPT_OTIMIZACAO, texto);
    return resposta({ ok: true, texto: sugestao });
  } catch (e) {
    // AbortSignal.timeout lança DOMException "TimeoutError" (mensagem em
    // inglês); traduz antes de chegar no toast do atendente.
    if (e instanceof DOMException && e.name === "TimeoutError") {
      return resposta({ ok: false, erro: "A IA demorou demais para responder. Tente de novo." });
    }
    const msg = e instanceof Error ? e.message : "Erro inesperado na IA.";
    console.error(`[ai-texto] erro: ${msg}`);
    return resposta({ ok: false, erro: msg });
  }
});
