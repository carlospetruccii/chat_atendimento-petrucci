import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import {
  enviarMensagemInterna,
  marcarConversaInternaLida,
  type ConversaInterna,
} from "@/lib/internas-queries";
import { agruparMensagensInternas, iniciaisDoNome } from "@/lib/internas-history";
import { useConversaInternaHistory } from "@/hooks/useConversaInternaHistory";
import { formatWhatsAppText } from "@/lib/whatsapp-format";
import {
  RichMessageComposer,
  type RichMessageComposerHandle,
} from "@/components/inbox/RichMessageComposer";

interface Props {
  conversa: ConversaInterna;
  meuUserId: string;
  formatTime: (iso: string | null) => string;
  /** Entrega ao pai o callback de INSERT do canal Realtime (que vive lá). */
  registrarRealtime: (cbs: { onInsert: (messageId: string, conversaId: string) => void }) => void;
}

/**
 * A conversa interna aberta. Texto puro: não há anexo, áudio, citação nem
 * status de entrega — nada disso existe em conversa que não passa pelo
 * WhatsApp. O que existe é o mesmo composer do resto do Inbox (negrito/itálico
 * por atalho de markdown), para não haver dois jeitos de escrever no produto.
 */
export function EquipeChatPanel({ conversa, meuUserId, formatTime, registrarRealtime }: Props) {
  const queryClient = useQueryClient();
  const composerRef = useRef<RichMessageComposerHandle>(null);
  const [hasDraft, setHasDraft] = useState(false);

  const chat = useConversaInternaHistory({ conversaId: conversa.id, enabled: true });

  // O canal Realtime é do pai (um canal por aba, não um por conversa aberta).
  useEffect(() => {
    registrarRealtime({ onInsert: chat.onRealtimeInsert });
  }, [registrarRealtime, chat.onRealtimeInsert]);

  // Zera o badge ao abrir e a cada mensagem nova enquanto a conversa está aberta.
  useEffect(() => {
    void marcarConversaInternaLida(conversa.id).then(() => {
      queryClient.invalidateQueries({ queryKey: ["internas", "conversas"] });
      queryClient.invalidateQueries({ queryKey: ["inbox", "abas-unread"] });
      queryClient.invalidateQueries({ queryKey: ["inbox-unread-total"] });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversa.id, chat.messages.length]);

  const enviarMut = useMutation({
    mutationFn: (content: string) => enviarMensagemInterna({ conversaId: conversa.id, content }),
    onSuccess: () => {
      composerRef.current?.clear();
      setHasDraft(false);
      composerRef.current?.focus();
      queryClient.invalidateQueries({ queryKey: ["internas", "conversas"] });
    },
    onError: (e) => {
      // O rascunho fica no composer de propósito: perder o texto digitado por
      // causa de uma falha de rede é pior do que ter que reenviar.
      toast.error(e instanceof Error ? e.message : "Não foi possível enviar a mensagem.");
    },
  });

  function handleSend() {
    const texto = composerRef.current?.getMarkdownText().trim() ?? "";
    if (!texto || enviarMut.isPending) return;
    enviarMut.mutate(texto);
  }

  const itens = agruparMensagensInternas(chat.messages, meuUserId);

  return (
    <>
      {/* Cabeçalho */}
      <div className="flex items-center gap-3 border-b border-border bg-card px-6 py-3">
        <span className="relative shrink-0">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-sm font-medium text-primary">
            {iniciaisDoNome(conversa.outroNome)}
          </span>
          <span
            className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-card ${
              conversa.outroDisponivel ? "bg-primary" : "bg-muted-foreground/40"
            }`}
            aria-hidden
          />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{conversa.outroNome}</p>
          <p className="truncate text-xs text-muted-foreground">
            {conversa.outroDepartmentNome ?? "Sem setor"}
            {" · "}
            {conversa.outroDisponivel ? "disponível" : "indisponível"}
          </p>
        </div>
        <span className="ml-auto shrink-0 rounded-full bg-muted px-2 py-1 text-[10px] text-muted-foreground">
          conversa interna
        </span>
      </div>

      {/* Mensagens */}
      <div ref={chat.scrollContainerRef} className="flex-1 overflow-y-auto px-6 py-4">
        <div ref={chat.topSentinelRef} />
        {chat.isLoadingMore && (
          <div className="flex justify-center py-2">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        )}

        {chat.isLoadingInitial ? (
          <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Carregando conversa...
          </div>
        ) : chat.error ? (
          <div className="py-12 text-center text-sm text-destructive">
            Não foi possível carregar as mensagens.
          </div>
        ) : itens.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            Nenhuma mensagem ainda. Diga oi para {conversa.outroNome.split(" ")[0]}.
          </div>
        ) : (
          itens.map((item) => {
            if (item.kind === "date-separator") {
              return (
                <div key={item.key} className="my-3 flex justify-center">
                  <span className="rounded-full bg-muted px-3 py-1 text-[11px] text-muted-foreground">
                    {item.label}
                  </span>
                </div>
              );
            }

            const m = item.message;
            return (
              <div
                key={item.key}
                data-message-id={m.id}
                className={`flex flex-col ${item.minha ? "items-end" : "items-start"} ${
                  item.colada ? "mt-1" : "mt-3"
                }`}
              >
                <div
                  className={`min-w-fit max-w-[75ch] rounded-lg px-3 py-2 text-sm shadow-sm ${
                    item.minha
                      ? "bg-[var(--chat-sent)] text-[var(--chat-sent-foreground)]"
                      : "bg-[var(--chat-received)] text-[var(--chat-received-foreground)]"
                  }`}
                >
                  <p className="whitespace-pre-wrap break-words">{formatWhatsAppText(m.content)}</p>
                  <span
                    className={`mt-1 block text-right text-[10px] ${
                      item.minha ? "text-[var(--chat-sent-foreground)]/70" : "text-muted-foreground"
                    }`}
                  >
                    {formatTime(m.createdAt)}
                  </span>
                </div>
              </div>
            );
          })
        )}
        <div ref={chat.bottomRef} />

        {chat.newBelow > 0 && (
          <button
            onClick={() => {
              chat.scrollToBottom(true);
              chat.clearNewBelow();
            }}
            className="badge-counter absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full px-3 py-1.5 text-xs font-medium shadow-md"
          >
            ↓ {chat.newBelow} nova{chat.newBelow > 1 ? "s" : ""} mensage
            {chat.newBelow > 1 ? "ns" : "m"}
          </button>
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-border bg-card p-4">
        <div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2">
          <RichMessageComposer
            ref={composerRef}
            placeholder={`Mensagem para ${conversa.outroNome.split(" ")[0]}...`}
            disabled={enviarMut.isPending}
            onHasContentChange={setHasDraft}
            // Conversa interna não aceita mídia: colar imagem não faz nada em
            // vez de falhar no meio do envio.
            onPasteImage={() => {}}
            onEnterSend={handleSend}
          />
          <button
            onClick={handleSend}
            disabled={enviarMut.isPending || !hasDraft}
            className="rounded-md bg-primary p-2 text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            aria-label="Enviar mensagem"
          >
            {enviarMut.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" strokeWidth={1.8} />
            )}
          </button>
        </div>
      </div>
    </>
  );
}
