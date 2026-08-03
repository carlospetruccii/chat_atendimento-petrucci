/**
 * Marca de autoria do texto que sai para o cliente: a pessoa escreveu, ou a
 * sugestão da IA (edge function `ai-texto`) foi aceita?
 *
 * O diálogo de sugestão abre em TODO envio de texto, então "a IA foi chamada"
 * não informa nada — o que interessa é se o texto enviado veio da sugestão.
 * Quando vem, guardamos também o que a pessoa havia digitado; sem isso não há
 * como comparar depois o antes e o depois.
 */

/** Qual botão do diálogo de sugestão originou o envio. */
export type OrigemTextoEnviado = "sugestao" | "original";

export interface MarcaOtimizacaoIa {
  otimizadoIa: boolean;
  /** O que a pessoa digitou, guardado só quando a IA mudou o texto. */
  contentOriginal: string | null;
}

/**
 * Decide se a mensagem enviada conta como otimizada pela IA.
 * `digitado` é o rascunho do composer; `enviado` é o texto que vai ao cliente.
 */
export function marcarOtimizacaoIa(
  digitado: string,
  enviado: string,
  origem: OrigemTextoEnviado,
): MarcaOtimizacaoIa {
  // Texto idêntico ao rascunho não é otimização, mesmo vindo pelo botão da
  // sugestão: ou a IA não achou o que melhorar (o diálogo auto-envia nesse
  // caso), ou a edição desfez a sugestão. O crédito é de quem escreveu.
  if (origem === "original" || enviado.trim() === digitado.trim()) {
    return { otimizadoIa: false, contentOriginal: null };
  }
  return { otimizadoIa: true, contentOriginal: digitado };
}
