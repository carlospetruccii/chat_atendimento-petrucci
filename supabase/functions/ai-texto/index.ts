// Edge Function: ai-texto
// Assistente de escrita do composer (IA direto na OpenAI).
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
// Requer o secret API_KEY_OPENAI_TRANSCRIBE, usado nas duas chamadas à OpenAI
// (transcrição em audio/transcriptions e correção/otimização em chat/completions).
// JWT é validado pelo gateway do Supabase (verify_jwt padrão).

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_TRANSCRICAO_URL = "https://api.openai.com/v1/audio/transcriptions";
const MODELO_CHAT = "gpt-5-nano";
const MODELO_TRANSCRICAO = "gpt-transcribe";
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
const MAX_TEXTO_CHARS = 4000;

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
//
// Só recebe o texto bruto da transcrição (não o áudio): o gpt-transcribe já
// grava com o glossário contábil no `prompt`, então revisar de novo ouvindo o
// áudio deixou de valer o custo/latência extra do 2º passo.
const PROMPT_TRANSCRICAO_FIEL = `Você é um revisor de transcrição de português do Brasil. Recebe a transcrição bruta de um áudio em que um atendente ditou uma mensagem.
Sua ÚNICA tarefa é pontuar essa transcrição. Você NÃO é redator, NÃO é revisor de conteúdo e NÃO melhora nada.

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
- acrescentar saudação, despedida, emoji ou qualquer informação que não estava na transcrição
- mudar a pessoa do verbo: "mando" não vira "enviaremos", "vou ver" não vira "verificaremos"
- corrigir a gramática da pessoa se isso mudar as palavras que ela escolheu

Se a fala saiu desorganizada, ela sai desorganizada no texto. Isso é correto: quem revisa é o atendente, e ele tem um botão separado para otimizar depois.

${REGRA_FIDELIDADE}

Responda APENAS com a transcrição pontuada, sem comentário nenhum.`;

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

function erroOpenAi(status: number): string {
  if (status === 429) return "Muitas solicitações de IA. Aguarde alguns segundos e tente de novo.";
  if (status === 402) return "Créditos de IA esgotados na OpenAI.";
  return `Falha na IA (${status}).`;
}

// Carrega status + corpo da OpenAI junto da mensagem amigável, para o
// diagnóstico voltar no próprio corpo da resposta quando os logs da função
// não estiverem acessíveis.
class ErroOpenAi extends Error {
  constructor(
    readonly status: number,
    readonly detalhe: string,
  ) {
    super(erroOpenAi(status));
    this.name = "ErroOpenAi";
  }
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

async function chatCompletion(apiKey: string, system: string, user: string): Promise<string> {
  const resp = await fetch(OPENAI_CHAT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODELO_CHAT,
      // Correção de ortografia/pontuação não precisa de raciocínio — "minimal"
      // evita gastar tokens (e latência) de reasoning à toa num modelo da
      // família gpt-5.
      reasoning_effort: "minimal",
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
    throw new ErroOpenAi(resp.status, detalhe.slice(0, 300));
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

  const resp = await fetch(OPENAI_TRANSCRICAO_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) {
    const detalhe = await resp.text().catch(() => "");
    console.error(`[ai-texto] transcricao ${resp.status}: ${detalhe.slice(0, 300)}`);
    throw new ErroOpenAi(resp.status, detalhe.slice(0, 300));
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

  const apiKey = Deno.env.get("API_KEY_OPENAI_TRANSCRIBE");
  if (!apiKey) {
    console.error("[ai-texto] API_KEY_OPENAI_TRANSCRIBE não configurada");
    return resposta({ ok: false, erro: "IA não configurada (API_KEY_OPENAI_TRANSCRIBE ausente)." });
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

      // Se a pontuação falhar, devolve a transcrição bruta — nunca pior que
      // não ter respondido nada. O detalhe do erro fica só no log (query_logs
      // via MCP), nunca no corpo pro cliente — é payload cru da OpenAI.
      let texto = bruto;
      let via = "pontuado";
      try {
        texto = await chatCompletion(apiKey, PROMPT_TRANSCRICAO_FIEL, bruto);
      } catch (e) {
        via = "bruto";
        const diag = e instanceof ErroOpenAi ? `chat ${e.status}: ${e.detalhe}` : String(e);
        console.error(`[ai-texto] pontuacao falhou, usando bruto: ${diag}`);
      }
      return resposta({
        ok: true,
        texto,
        textoBruto: bruto,
        via,
        bytesAudio: file.size,
        modeloChat: MODELO_CHAT,
        modeloTranscricao: MODELO_TRANSCRICAO,
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
    // `codigo` deixa o frontend distinguir "sem crédito" (não deve enviar nada
    // automaticamente) dos demais erros (rate limit, timeout etc.) sem
    // depender de comparar a string da mensagem.
    const codigo = e instanceof ErroOpenAi && e.status === 402 ? "sem_credito" : undefined;
    return resposta({ ok: false, erro: msg, ...(codigo ? { codigo } : {}) });
  }
});
