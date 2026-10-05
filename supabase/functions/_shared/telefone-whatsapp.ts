const E164 = /^\+[1-9][0-9]{7,14}$/;

/**
 * Retorna formas equivalentes de um telefone móvel brasileiro no WhatsApp.
 *
 * O WhatsApp pode entregar o mesmo número brasileiro com ou sem o nono dígito
 * depois do DDD. A forma recebida sempre vem primeiro para que registros
 * legados duplicados mantenham precedência determinística pelo valor exato.
 */
export function variantesNumeroWhatsappBR(numero: string): string[] {
  if (!E164.test(numero)) return [];

  const match = /^\+55(\d{2})(\d{8,9})$/.exec(numero);
  if (!match) return [numero];

  const [, ddd, assinante] = match;
  if (assinante.length === 9 && assinante.startsWith("9")) {
    return [numero, `+55${ddd}${assinante.slice(1)}`];
  }
  if (assinante.length === 8 && /^[6-9]/.test(assinante)) {
    return [numero, `+55${ddd}9${assinante}`];
  }
  return [numero];
}

/** Forma estável usada apenas ao criar números novos. */
export function numeroCanonicoWhatsapp(numero: string): string | null {
  const variantes = variantesNumeroWhatsappBR(numero);
  if (variantes.length === 0) return null;
  return variantes.reduce((maior, atual) => (atual.length > maior.length ? atual : maior));
}

export function numerosWhatsappEquivalentes(a: string, b: string): boolean {
  const variantes = variantesNumeroWhatsappBR(a);
  return variantes.length > 0 && variantes.includes(b);
}

/** Escolhe primeiro o registro exato e, na falta dele, sua variante brasileira. */
export function selecionarRegistroPorNumeroWhatsapp<T extends { numero_whatsapp: string }>(
  registros: readonly T[],
  numero: string,
): T | null {
  const variantes = variantesNumeroWhatsappBR(numero);
  const canonico = numeroCanonicoWhatsapp(numero);
  const ordem = canonico
    ? [canonico, ...variantes.filter((variante) => variante !== canonico)]
    : variantes;

  for (const variante of ordem) {
    const encontrado = registros.find((registro) => registro.numero_whatsapp === variante);
    if (encontrado) return encontrado;
  }
  return null;
}

/**
 * Decide se a linha achada pelo LID conflita de verdade com a achada pelo número.
 *
 * Duplicado legado — o mesmo celular gravado nas duas formas brasileiras, só uma
 * das linhas carregando o LID — NÃO é conflito: o LID é a identidade mais forte
 * do chat e vence. Tratar isso como conflito derrubava toda mensagem recebida
 * do número duplicado, em silêncio.
 *
 * Conflito de verdade é a outra linha ter um LID próprio e diferente: aí são
 * duas contas de WhatsApp distintas e juntar as conversas seria pior do que
 * manter os registros separados.
 *
 * Os dois registros precisam vir JÁ filtrados por `company_id`: esta função não
 * conhece empresa e não faz esse corte por você.
 */
export function conflitoDeIdentidadeCliente(
  clientePorLid: { id: string; numero_whatsapp: string },
  clientePorNumero: { id: string; chat_lid?: string | null } | null,
  numero: string,
  chatLid: string,
): boolean {
  if (!numerosWhatsappEquivalentes(clientePorLid.numero_whatsapp, numero)) return true;
  if (!clientePorNumero || clientePorNumero.id === clientePorLid.id) return false;
  return Boolean(clientePorNumero.chat_lid && clientePorNumero.chat_lid !== chatLid);
}
