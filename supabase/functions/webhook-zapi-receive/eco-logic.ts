// Casamento do ECO da uazapi com a mensagem que NÓS mesmos enviamos.
//
// Contexto: a mesma instância da uazapi é usada por mais de um sistema. Para o
// nosso chat enxergar o que o outro sistema mandou, o webhook precisa receber
// os eventos `wasSentByApi` (antes filtrados na origem). O efeito colateral é
// que o eco dos NOSSOS envios também passa a chegar.
//
// O dedup forte é o `zapi_message_id` (UNIQUE), mas ele só é gravado DEPOIS que
// a uazapi responde ao POST de envio. Se o eco chegar antes dessa gravação, a
// linha ainda está sem id e o dedup não pega — daí este módulo: escolhe, entre
// as mensagens nossas recém-enviadas e ainda sem id, qual delas o eco representa
// ("adoção"). Sem isso teríamos linha duplicada na conversa E o UPDATE do envio
// estouraria o UNIQUE, deixando a mensagem presa em "enviando".
//
// Aqui só mora a decisão pura (sem banco), para poder ser testada.

/** Linha nossa candidata a ser "adotada" pelo eco. */
export interface CandidataEco {
  id: string;
  tipo: string;
  content: string | null;
  media_metadata: Record<string, unknown> | null;
  /** ISO. Usado só para ordenar (FIFO: o envio mais antigo ecoa primeiro). */
  created_at: string;
}

/** O que veio no eco (já parseado pelo webhook). */
export interface EcoRecebido {
  tipo: string;
  content: string | null;
  media_metadata: Record<string, unknown> | null;
}

const TIPOS_TEXTO = new Set(["texto", "localizacao", "contato"]);

function normalizarTexto(v: string | null | undefined): string {
  return (v ?? "").replace(/\s+/g, " ").trim();
}

/** Nome do arquivo, olhando as chaves usadas nos dois lados (envio x eco). */
function nomeArquivo(meta: Record<string, unknown> | null | undefined): string {
  if (!meta) return "";
  for (const chave of ["file_name", "nome_original", "fileName"]) {
    const v = meta[chave];
    if (typeof v === "string" && v.trim()) return v.trim().toLowerCase();
  }
  return "";
}

/**
 * O eco pode ser esta candidata?
 *
 * Regra conservadora — só casa quando os sinais BATEM; sinal ausente de um dos
 * lados não desqualifica (a uazapi nem sempre devolve caption/fileName).
 */
export function ecoCasaComCandidata(cand: CandidataEco, eco: EcoRecebido): boolean {
  if (cand.tipo !== eco.tipo) return false;

  // Texto (e afins): o conteúdo é a identidade da mensagem.
  if (TIPOS_TEXTO.has(eco.tipo)) {
    return normalizarTexto(cand.content) === normalizarTexto(eco.content);
  }

  // Mídia: nome do arquivo e legenda desempatam quando existem nos dois lados.
  const nomeCand = nomeArquivo(cand.media_metadata);
  const nomeEco = nomeArquivo(eco.media_metadata);
  if (nomeCand && nomeEco && nomeCand !== nomeEco) return false;

  const capCand = normalizarTexto(cand.content);
  const capEco = normalizarTexto(eco.content);
  if (capCand && capEco && capCand !== capEco) return false;

  return true;
}

/**
 * Candidatas plausíveis, na ordem em que devem ser tentadas (mais antiga
 * primeiro — os envios ecoam na ordem em que saíram).
 */
export function candidatasParaAdocao(
  candidatas: readonly CandidataEco[],
  eco: EcoRecebido,
): CandidataEco[] {
  return candidatas
    .filter((c) => ecoCasaComCandidata(c, eco))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}
