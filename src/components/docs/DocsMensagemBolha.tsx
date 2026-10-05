import { AlertCircle, Ban, Check } from "lucide-react";
import { formatWhatsAppText } from "@/lib/whatsapp-format";
import { MessageMedia } from "@/components/inbox-media/MessageMedia";
import { QuotedMessagePreview } from "@/components/inbox/QuotedMessagePreview";
import { MensagemAcoesMenu } from "@/components/inbox/MensagemAcoesMenu";
import { MensagemLinha } from "@/components/inbox/MensagemLinha";
import type { Elegibilidade } from "@/lib/janelas-whatsapp";
import type { DocsMessage } from "@/lib/docs-queries";
import { rotuloExterno } from "@/lib/docs-logic";

interface Props {
  m: DocsMessage;
  /** Sequência do mesmo remetente: espaçamento menor e sem repetir o nome. */
  colada: boolean;
  primeira: boolean;
  meuUserId: string;
  quoted: DocsMessage | null;
  autorDe: (m: DocsMessage) => string;
  formatTime: (iso: string | null) => string;
  agora: number;
  selecao: {
    ativo: boolean;
    selecionada: boolean;
    podeApagar: Elegibilidade;
    onSegurar: () => void;
    onToque: () => void;
  };
  permissoes: { podeResponder: boolean; podeEncaminhar: boolean; podeAlterar: boolean };
  onResponder: () => void;
  onEditar: () => void;
  onApagar: () => void;
  onEncaminhar: () => void;
}

function corDaBolha(m: DocsMessage): string {
  if (m.direction !== "outbound") {
    return "bg-[var(--chat-received)] text-[var(--chat-received-foreground)]";
  }
  if (m.senderType === "externo")
    return "bg-primary/15 text-foreground border border-dashed border-primary";
  if (m.senderType === "sistema") return "bg-secondary text-secondary-foreground";
  return "bg-[var(--chat-sent)] text-[var(--chat-sent-foreground)]";
}

function irParaMensagem(id: string) {
  document
    .querySelector(`[data-message-id="${id}"]`)
    ?.scrollIntoView({ behavior: "smooth", block: "center" });
}

/**
 * Uma mensagem do chat do Docs. Mesmo visual das bolhas da Inbox: documento do
 * sistema financeiro sai como bolha "externa" (tracejada) com a legenda de
 * origem; apagada vira marcador; editada ganha a marca "· editada".
 */
export function DocsMensagemBolha({
  m,
  colada,
  primeira,
  meuUserId,
  quoted,
  autorDe,
  formatTime,
  agora,
  selecao,
  permissoes,
  onResponder,
  onEditar,
  onApagar,
  onEncaminhar,
}: Props) {
  const isMe = m.direction === "outbound";
  const isExterno = m.senderType === "externo";
  const apagada = !!m.apagadaEm;
  const onPrimary = isMe && !isExterno && m.senderType !== "sistema";
  const metaColor = onPrimary ? "text-[var(--chat-sent-foreground)]/70" : "text-muted-foreground";
  const bubbleClass =
    m.tipo === "sticker"
      ? "max-w-[70%]"
      : `min-w-0 max-w-[75ch] rounded-lg px-3 py-2 text-sm shadow-sm ${corDaBolha(m)}`;
  // Todo mundo com acesso vê tudo: o nome de quem respondeu importa quando
  // não fui eu (a conversa pode ter passado por várias pessoas).
  const mostraNome =
    !colada && isMe && m.senderType === "atendente" && m.sentByUserId !== meuUserId;
  const gap = primeira ? "" : colada ? "mt-1" : "mt-3";

  return (
    <MensagemLinha
      mensagemId={m.id}
      className={`group flex flex-col ${isMe ? "items-end" : "items-start"} ${gap}`}
      modoSelecao={selecao.ativo}
      selecionada={selecao.selecionada}
      onSegurar={selecao.onSegurar}
      onToqueSelecao={selecao.onToque}
    >
      {mostraNome && (
        <span className="mb-0.5 min-w-0 max-w-[85%] truncate px-1 text-[11px] text-muted-foreground">
          {m.sentByNome ?? "Atendente"}
        </span>
      )}
      <div
        className={`flex items-center gap-1 ${isMe ? "flex-row-reverse" : "flex-row"} max-w-[85%] sm:max-w-[75%] md:max-w-[65%]`}
      >
        <div className={apagada ? `${bubbleClass} opacity-80` : bubbleClass}>
          {apagada ? (
            <p className="flex items-center gap-1.5 text-sm italic">
              <Ban className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} />
              {isMe ? "Esta mensagem foi apagada para todos" : "Esta mensagem foi apagada"}
            </p>
          ) : (
            <>
              {m.replyToMessageId && (
                <QuotedMessagePreview
                  variant="inBubble"
                  quoted={quoted}
                  authorLabel={quoted ? autorDe(quoted) : "Mensagem"}
                  onPrimary={onPrimary}
                  onClick={() => quoted && irParaMensagem(quoted.id)}
                />
              )}
              {m.tipo === "texto" ? (
                <p className="whitespace-pre-wrap break-anywhere">
                  {formatWhatsAppText(m.content)}
                </p>
              ) : (
                <MessageMedia message={m} escopo="docs" />
              )}
              {isExterno && (
                <p className={`mt-1 text-[10px] italic ${metaColor}`}>
                  {rotuloExterno(m.mediaMetadata)}
                </p>
              )}
            </>
          )}
          <span className={`mt-1 block text-right text-[10px] ${metaColor}`}>
            {formatTime(m.createdAt)}
            {m.senderType === "sistema" &&
              ((m.mediaMetadata as { kind?: unknown } | null)?.kind === "aviso_automatico_docs"
                ? " · resposta automática"
                : " · sistema")}
            {m.statusEnvio === "enviando" && " · enviando"}
            {!apagada && m.editadaEm && (
              <span className="ml-1 italic" title={`Editada em ${formatTime(m.editadaEm)}`}>
                · editada
              </span>
            )}
          </span>
          {m.statusEnvio === "falha" && (
            <p className="mt-1 flex items-center gap-1 text-[10px] text-destructive">
              <AlertCircle className="h-3 w-3" strokeWidth={2} />
              Não enviada
            </p>
          )}
        </div>
        {selecao.ativo
          ? // No modo de seleção o menu sai de cena; mensagem inelegível fica sem
            // marcador (tocar nela avisa o motivo — ver useSelecaoMensagens).
            selecao.podeApagar.pode && (
              <span
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
                  selecao.selecionada
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-muted-foreground/40"
                }`}
                aria-hidden
              >
                {selecao.selecionada && <Check className="h-3 w-3" strokeWidth={3} />}
              </span>
            )
          : !apagada && (
              <MensagemAcoesMenu
                mensagem={m}
                agora={agora}
                onResponder={onResponder}
                onEditar={onEditar}
                onApagar={onApagar}
                onEncaminhar={onEncaminhar}
                podeResponder={permissoes.podeResponder}
                podeEncaminhar={permissoes.podeEncaminhar}
                podeAlterar={permissoes.podeAlterar}
              />
            )}
      </div>
    </MensagemLinha>
  );
}
