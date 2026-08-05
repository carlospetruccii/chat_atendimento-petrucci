// Edge Function: ai-texto
// Assistente de escrita do composer (IA do Lovable — ai.gateway.lovable.dev).
//
// Contrato com o frontend (sempre responde 200 com { ok, texto?, erro? }
// para o cliente não precisar tratar FunctionsHttpError):
//
//   POST multipart/form-data { file: Blob, cliente? }  → transcreve FIELMENTE o
//     áudio ditado: só pontuação, maiúsculas e acentos. NÃO reescreve, não
//     formata, não melhora. Quem polir é o atendente, no endpoint abaixo.
//
//   POST application/json { texto: string }        → devolve uma sugestão da
//     mensagem otimizada (ortografia, clareza, profissionalismo, formatação).
//
// Os dois passos são separados de propósito: juntar transcrição com reescrita
// fazia a IA "melhorar" o texto e mudar o que o atendente quis dizer.
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
// um assunto por bloco, na ordem em que o cliente vai executar. Vale APENAS para
// a otimização de texto digitado — a transcrição de áudio NÃO formata nada (ver
// PROMPT_TRANSCRICAO_FIEL).
const REGRA_FORMATO = `FORMATO DA MENSAGEM (obrigatório):
Quebre o texto em blocos curtos separados por LINHA EM BRANCO, um assunto por bloco, no máximo 2 frases cada.
Quando há passos a seguir, cada passo é um bloco, na ordem em que a pessoa deve executar.
Se a mensagem toda tem 2 frases ou menos, deixe em um único bloco — não invente separação.
Não use marcadores de lista (-, *, 1.), títulos, nem linhas de assunto. É conversa de WhatsApp, não documento.
Use *negrito* só em nomes de sistema/aplicativo, prazos e valores QUE JÁ ESTEJAM no texto — nunca para criar destaque novo.`;

// TRANSCRIÇÃO ≠ REDAÇÃO. Antes este prompt pedia transcrição E reescrita
// editorial (tirar vício de fala, quebrar em blocos, aplicar negrito) sob ~25
// linhas de regra. Cada uma dessas liberdades era uma chance de divergir do que
// a pessoa quis dizer — e foi essa a queixa dos atendentes ("escreve errado e
// não o que quero passar"). O polimento agora é do botão "Sugestão da IA", que
// já existe e o atendente aciona quando quer. Aqui só se pontua.
const PROMPT_TRANSCRICAO_FIEL = `Você é um transcritor profissional de português do Brasil. Recebe o áudio de um atendente ditando uma mensagem e a transcrição bruta desse mesmo áudio.
Sua ÚNICA tarefa é devolver por escrito o que a pessoa falou. Você NÃO é redator, NÃO é revisor e NÃO melhora nada.

O ÁUDIO é a fonte da verdade. A transcrição bruta serve só de referência para a grafia de números, valores, siglas e nomes próprios. Se as duas divergirem, vale o que você ouviu no áudio.

VOCÊ PODE, e apenas isto:
- pontuar (ponto, vírgula, interrogação) e usar maiúsculas e acentos corretos
- separar em parágrafos onde a pessoa claramente fez uma pausa longa
- remover só vício de fala puro, sem conteúdo: "é...", "hã", "ahn", "tipo assim", gaguejo e palavra repetida por engano
- quando a pessoa se corrigiu no meio da fala ("manda o DAS, não, o DCTF"), manter só a versão que ela corrigiu

VOCÊ NÃO PODE, em nenhuma hipótese:
- reescrever, reordenar, resumir ou expandir qualquer frase
- trocar uma palavra por sinônimo, mesmo que a sua pareça melhor
- deixar o texto mais formal, mais educado ou mais profissional
- quebrar a mensagem em blocos por assunto, criar lista, título ou marcador
- usar *negrito*, _itálico_ ou qualquer marcação
- acrescentar saudação, despedida, emoji ou qualquer informação que não foi falada
- mudar a pessoa do verbo: "mando" não vira "enviaremos", "vou ver" não vira "verificaremos"
- corrigir a gramática da pessoa se isso mudar as palavras que ela escolheu

Se a fala saiu desorganizada, ela sai desorganizada no texto. Isso é correto: quem revisa é o atendente, e ele tem um botão separado para otimizar depois.

${REGRA_FIDELIDADE}

Responda APENAS com a transcrição, sem comentário nenhum.`;

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

// Carrega status + corpo do gateway junto da mensagem amigável. Sem isso não há
// como saber se a revisão caiu por recusa do bloco de áudio (400/415) ou por
// rate limit/crédito (429/402) — e os logs desta função não estão acessíveis.
class ErroGateway extends Error {
  constructor(
    readonly status: number,
    readonly detalhe: string,
  ) {
    super(erroGateway(status));
    this.name = "ErroGateway";
  }
}

interface AudioInline {
  base64: string;
  formato: string;
}

/** Extensão/formato do arquivo de áudio a partir do mime informado. */
function formatoDeAudio(mime: string): string {
  const extMap: Record<string, string> = {
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mp4": "m4a",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/aac": "aac",
    "audio/flac": "flac",
  };
  return extMap[(mime || "").split(";")[0]] ?? "webm";
}

function paraBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function chatCompletion(
  apiKey: string,
  system: string,
  user: string,
  audio?: AudioInline,
): Promise<string> {
  // Com áudio anexado o modelo confere o sentido pela fala; sem ele o pedido
  // é o mesmo de sempre (texto puro).
  const content = audio
    ? [
        { type: "text", text: user },
        { type: "input_audio", input_audio: { data: audio.base64, format: audio.formato } },
      ]
    : user;

  const resp = await fetch(`${GATEWAY}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODELO_CHAT,
      messages: [
        { role: "system", content: system },
        { role: "user", content },
      ],
    }),
    signal: AbortSignal.timeout(audio ? 60_000 : 20_000),
  });
  if (!resp.ok) {
    const detalhe = await resp.text().catch(() => "");
    console.error(`[ai-texto] chat ${resp.status}: ${detalhe.slice(0, 300)}`);
    throw new ErroGateway(resp.status, detalhe.slice(0, 300));
  }
  const data = await resp.json();
  const texto = data?.choices?.[0]?.message?.content?.trim();
  if (!texto) throw new Error("A IA não retornou texto.");
  return texto;
}

async function transcrever(apiKey: string, file: File, cliente: string | null): Promise<string> {
  const ext = formatoDeAudio(file.type);

  // Lista de palavras difíceis: siglas fixas do escritório + o nome do cliente
  // da conversa (quando existe), que é o termo que mais sai errado.
  const vocabulario = cliente
    ? `${TERMOS_CONTABEIS}, ${cliente}`
    : TERMOS_CONTABEIS;

  const form = new FormData();
  form.append("model", MODELO_TRANSCRICAO);
  form.append("file", file, `gravacao.${ext}`);
  form.append("language", "pt");
  form.append("prompt", vocabulario);

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
      const clienteRaw = form.get("cliente");
      const cliente = typeof clienteRaw === "string" && clienteRaw.trim() !== ""
        ? clienteRaw.trim().slice(0, 120)
        : null;

      const bruto = await transcrever(apiKey, file, cliente);
      if (!bruto) {
        return resposta({ ok: false, erro: "Não foi possível entender o áudio. Tente gravar de novo." });
      }

      // Escada de degradação: (1) revisão ouvindo o áudio, (2) revisão só com o
      // texto, (3) transcrição bruta. Nenhum degrau é pior que o anterior.
      //
      // `via` e `diag` vão na resposta porque a escada degrada em SILÊNCIO: se o
      // gateway recusar o bloco de áudio, o atendente recebe texto normalmente e
      // parece que funcionou, mas o conserto principal não aconteceu. Os logs
      // desta função não estão acessíveis (o MCP falha e o CLI 2.107 não tem
      // `functions logs`), então o diagnóstico volta pelo próprio corpo.
      let audio: AudioInline | null = null;
      let via = "audio";
      let diag: string | undefined;

      if (file.size <= MAX_AUDIO_INLINE_BYTES) {
        try {
          audio = {
            base64: paraBase64(new Uint8Array(await file.arrayBuffer())),
            formato: formatoDeAudio(file.type),
          };
        } catch (e) {
          via = "texto";
          diag = `falha ao preparar audio inline: ${e}`;
          console.error(`[ai-texto] ${diag}`);
        }
      } else {
        via = "texto";
        diag = `audio de ${file.size} bytes acima do corte de ${MAX_AUDIO_INLINE_BYTES}`;
        console.warn(`[ai-texto] ${diag}`);
      }

      let texto = bruto;
      try {
        texto = await chatCompletion(apiKey, PROMPT_TRANSCRICAO_FIEL, bruto, audio ?? undefined);
      } catch (e) {
        const detalhe = e instanceof ErroGateway
          ? `chat ${e.status}: ${e.detalhe}`
          : String(e);
        console.error(`[ai-texto] revisao com audio falhou: ${detalhe}`);
        diag = detalhe;
        if (audio) {
          via = "texto-apos-recusa";
          try {
            texto = await chatCompletion(apiKey, PROMPT_TRANSCRICAO_FIEL, bruto);
          } catch (e2) {
            via = "bruto";
            diag = `${detalhe} | so-texto tambem falhou: ${e2}`;
            console.error(`[ai-texto] revisao so com texto falhou, usando bruto: ${e2}`);
          }
        } else {
          via = "bruto";
        }
      }
      return resposta({
        ok: true,
        texto,
        textoBruto: bruto,
        via,
        formatoAudio: audio?.formato ?? formatoDeAudio(file.type),
        bytesAudio: file.size,
        modeloChat: MODELO_CHAT,
        modeloTranscricao: MODELO_TRANSCRICAO,
        ...(diag ? { diag } : {}),
      });
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
