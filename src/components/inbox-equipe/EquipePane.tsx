import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessagesSquare, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  abrirConversaInterna,
  listConversasInternas,
  type ColegaInterno,
} from "@/lib/internas-queries";
import { ConversasInternasList } from "./ConversasInternasList";
import { EquipeChatPanel } from "./EquipeChatPanel";
import { NovaConversaDialog } from "./NovaConversaDialog";

interface Props {
  meuUserId: string;
  formatTime: (iso: string | null) => string;
  /** Alternador Chat | Grupos | Equipe, renderizado no topo da coluna da lista. */
  tabs: React.ReactNode;
}

/**
 * A aba "Equipe" inteira: lista de conversas + a conversa aberta.
 *
 * É o chat interno do time — Silmara chama a Andreza aqui, e nada disso toca o
 * WhatsApp. Vive em componente próprio pelo mesmo motivo da aba Grupos: a rota
 * do Inbox já é grande, e conversa interna não compartilha estado nenhum com o
 * fluxo de atendimento (sem triagem, bot, departamento, atribuição, encerramento).
 */
export function EquipePane({ meuUserId, formatTime, tabs }: Props) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [novaOpen, setNovaOpen] = useState(false);

  const conversasQuery = useQuery({
    queryKey: ["internas", "conversas"],
    queryFn: listConversasInternas,
  });
  const conversas = conversasQuery.data ?? [];

  const termo = filter.trim().toLowerCase();
  const filtrados = termo
    ? conversas.filter(
        (c) =>
          c.outroNome.toLowerCase().includes(termo) ||
          (c.outroDepartmentNome?.toLowerCase().includes(termo) ?? false),
      )
    : conversas;

  const current = conversas.find((c) => c.id === selectedId) ?? null;

  // Escolher um colega abre a conversa: o RPC é idempotente, então "criar" e
  // "reabrir" são a mesma ação e não existe estado de convite pendente.
  const abrirMut = useMutation({
    mutationFn: (colega: ColegaInterno) => abrirConversaInterna(colega.userId),
    onSuccess: async (conversaId) => {
      setNovaOpen(false);
      // A lista precisa conter a conversa antes de selecioná-la, senão o painel
      // fica vazio até o próximo refetch.
      await queryClient.invalidateQueries({ queryKey: ["internas", "conversas"] });
      setSelectedId(conversaId);
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Não foi possível abrir a conversa.");
    },
  });

  // Realtime: um canal só para a aba. O callback do chat aberto fica num ref
  // para o canal não ser recriado a cada render (recriar perde INSERTs na
  // janela de reinscrição) — mesma cautela da aba Grupos.
  const chatCbsRef = useRef<{ onInsert: (messageId: string, conversaId: string) => void }>({
    onInsert: () => {},
  });

  useEffect(() => {
    const canal = supabase
      .channel("internas-realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "mensagens_internas" },
        (payload) => {
          const row = payload.new as { id?: string; conversa_id?: string } | null;
          queryClient.invalidateQueries({ queryKey: ["internas", "conversas"] });
          queryClient.invalidateQueries({ queryKey: ["inbox", "abas-unread"] });
          queryClient.invalidateQueries({ queryKey: ["inbox-unread-total"] });
          if (row?.id && row.conversa_id) chatCbsRef.current.onInsert(row.id, row.conversa_id);
        },
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "conversas_internas" }, () => {
        queryClient.invalidateQueries({ queryKey: ["internas", "conversas"] });
      })
      .subscribe();
    return () => {
      supabase.removeChannel(canal);
    };
  }, [queryClient]);

  return (
    <>
      {/* Lista */}
      <div className="w-[360px] shrink-0 overflow-y-auto border-r border-border bg-card">
        <div className="space-y-2 border-b border-border p-4">
          {tabs}
          <div className="flex items-center gap-2">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              type="text"
              placeholder="Buscar no time..."
              className="w-full rounded-2xl border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/20"
            />
            <button
              type="button"
              onClick={() => setNovaOpen(true)}
              className="shrink-0 rounded-full bg-primary p-2 text-primary-foreground transition-opacity hover:opacity-90"
              aria-label="Conversar com alguém do time"
              title="Conversar com alguém do time"
            >
              <UserPlus className="h-4 w-4" strokeWidth={1.8} />
            </button>
          </div>
        </div>

        <ConversasInternasList
          conversas={filtrados}
          selectedId={selectedId}
          isLoading={conversasQuery.isLoading}
          temFiltro={filter.trim() !== ""}
          onSelect={setSelectedId}
          onNovaConversa={() => setNovaOpen(true)}
          formatTime={formatTime}
        />
      </div>

      {/* Conversa */}
      <div className="relative flex flex-1 flex-col bg-background">
        {!current ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="text-center">
              <MessagesSquare
                className="mx-auto h-12 w-12 text-muted-foreground"
                strokeWidth={1.2}
              />
              <p className="mt-3 text-sm text-muted-foreground">
                Selecione uma conversa ou chame alguém do time.
              </p>
              <button
                onClick={() => setNovaOpen(true)}
                className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
              >
                <UserPlus className="h-3.5 w-3.5" strokeWidth={1.8} />
                Nova conversa
              </button>
            </div>
          </div>
        ) : (
          <EquipeChatPanel
            key={current.id}
            conversa={current}
            meuUserId={meuUserId}
            formatTime={formatTime}
            registrarRealtime={(cbs) => {
              chatCbsRef.current = cbs;
            }}
          />
        )}
      </div>

      <NovaConversaDialog
        open={novaOpen}
        onOpenChange={setNovaOpen}
        abrindo={abrirMut.isPending}
        onEscolher={(colega) => abrirMut.mutate(colega)}
      />
    </>
  );
}
