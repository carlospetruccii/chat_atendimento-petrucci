// Helpers PUROS de formatação/texto — sem side effects, sem I/O.
// Extraídos dos handlers (que têm Deno.serve no topo) para poderem ser
// testados isoladamente com `deno test`.

// Formata minutos de espera: 45 → "45 min"; 90 → "1h30"; 60 → "1h".
export function formatarEspera(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h${m.toString().padStart(2, "0")}`;
}

// Interpola {{chave}} num template com o mapa de variáveis.
export function interpolar(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}

// Monta o texto do aviso de repasse no WhatsApp.
export function montarMensagem(params: {
  clienteNome: string;
  departamentoNome: string | null;
  atorNome: string | null;
  observacao: string | null;
  appUrl: string | null;
}): string {
  const linhas: string[] = ["🔔 Novo atendimento pra você"];
  const porQuem = params.atorNome ? ` por ${params.atorNome}` : "";
  linhas.push("");
  linhas.push(`*${params.clienteNome}* foi repassado(a) pra você${porQuem}.`);
  if (params.departamentoNome) linhas.push(`🏷️ ${params.departamentoNome}`);
  if (params.observacao) linhas.push(`📝 ${params.observacao}`);
  linhas.push("");
  linhas.push(
    params.appUrl
      ? `Abra o painel para atender: ${params.appUrl}`
      : "Abra o painel para atender.",
  );
  return linhas.join("\n");
}
