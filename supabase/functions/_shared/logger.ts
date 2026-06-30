// Logger estruturado para Edge Functions.
// Toda linha é um JSON em uma única linha (compatível com agregadores de logs).
// REGRA: nunca logar dados sensíveis (telefone completo, conteúdo de mensagem,
// tokens, payloads de mídia). Apenas IDs internos e metadados.

export type LogStatus = "ok" | "erro";

export interface LogContext {
  funcao: string;
  evento: string;
  status: LogStatus;
  duracao_ms?: number;
  atendimento_id?: string | null;
  mensagem_id?: string | null;
  client_id?: string | null;
  // Campos extras seguros (códigos de erro, contadores, etc).
  // NUNCA usar para dados sensíveis.
  extra?: Record<string, string | number | boolean | null>;
  // Mensagem de erro curta (sem stack, sem payloads).
  erro_msg?: string;
}

export function log(ctx: LogContext): void {
  const linha = {
    timestamp: new Date().toISOString(),
    funcao: ctx.funcao,
    evento: ctx.evento,
    status: ctx.status,
    ...(ctx.duracao_ms !== undefined ? { duracao_ms: ctx.duracao_ms } : {}),
    ...(ctx.atendimento_id ? { atendimento_id: ctx.atendimento_id } : {}),
    ...(ctx.mensagem_id ? { mensagem_id: ctx.mensagem_id } : {}),
    ...(ctx.client_id ? { client_id: ctx.client_id } : {}),
    ...(ctx.erro_msg ? { erro_msg: ctx.erro_msg } : {}),
    ...(ctx.extra ?? {}),
  };
  // console.log no Deno aparece em supabase functions logs.
  // stderr para erros para facilitar filtragem.
  if (ctx.status === "erro") {
    console.error(JSON.stringify(linha));
  } else {
    console.log(JSON.stringify(linha));
  }
}

// Helper para medir duração: retorna função que, ao ser chamada, devolve ms decorridos.
export function iniciarCronometro(): () => number {
  const inicio = performance.now();
  return () => Math.round(performance.now() - inicio);
}
