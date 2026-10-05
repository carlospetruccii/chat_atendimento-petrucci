/**
 * O mínimo que um componente precisa saber de uma mensagem para RENDERIZAR o
 * conteúdo dela (mídia, prévia de citação).
 *
 * Existe para que os componentes de renderização sirvam tanto para o chat
 * individual (`InboxMessage`, ligada a atendimento/cliente) quanto para o de
 * grupo (`GrupoMessage`, ligada a grupo/participante), que são modelos
 * diferentes no banco mas idênticos na hora de desenhar a bolha. Sem isso, ou
 * duplicaríamos os componentes de mídia, ou o modelo de grupo carregaria campos
 * de atendimento que não existem.
 */
export interface MensagemRenderizavel {
  /** Id da linha no banco. Opcional só por retrocompatibilidade com objetos
   *  montados à mão; é o que permite pedir o reprocessamento de uma mídia. */
  id?: string;
  tipo:
    | "texto"
    | "imagem"
    | "audio"
    | "video"
    | "documento"
    | "sticker"
    | "localizacao"
    | "contato";
  content: string | null;
  mediaUrl: string | null;
  mediaMetadata: Record<string, unknown> | null;
  /**
   * Apagada para todos no WhatsApp. Opcional porque o modelo de grupo ainda não
   * oferece a ação — quem não passa é tratado como "não apagada".
   */
  apagadaEm?: string | null;
}
