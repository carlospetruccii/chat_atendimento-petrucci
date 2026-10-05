// Mídia "sob demanda": documento que o OUTRO sistema dispara pelo número
// financeiro não é baixado sozinho (um disparo em massa viraria centenas de
// downloads na mesma instância). A linha nasce com
// `download_falhou: true, download_erro_codigo: "sob_demanda"` e a bolha mostra
// um botão neutro "Baixar" em vez do erro vermelho.

export const CODIGO_SOB_DEMANDA = "sob_demanda";

/** A mídia está esperando alguém pedir o download (não é falha de verdade)? */
export function ehSobDemanda(meta: Record<string, unknown> | null | undefined): boolean {
  return meta?.download_falhou === true && meta.download_erro_codigo === CODIGO_SOB_DEMANDA;
}

/** Nome do arquivo, quando a uazapi mandou (as duas grafias aparecem). */
export function nomeDoArquivo(meta: Record<string, unknown> | null | undefined): string | null {
  for (const chave of ["file_name", "fileName"]) {
    const v = meta?.[chave];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

const ROTULO_TIPO: Record<string, string> = {
  imagem: "Imagem",
  video: "Vídeo",
  audio: "Áudio",
};

/** "Documento do sistema financeiro", "Imagem do sistema financeiro"… */
export function tituloSobDemanda(tipo: string): string {
  return `${ROTULO_TIPO[tipo] ?? "Documento"} do sistema financeiro`;
}
