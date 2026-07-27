import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, Users } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  listGrupos,
  searchGrupoIdsByMessageContent,
  sincronizarGrupos,
} from "@/lib/grupos-queries";
import { GruposList } from "./GruposList";
import { GrupoChatPanel } from "./GrupoChatPanel";

interface Props {
  meuUserId: string;
  formatTime: (iso: string | null) => string;
  /** Alternador Chat | Grupos, renderizado no topo da coluna da lista. */
  tabs: React.ReactNode;
}

/**
 * A aba "Grupos" inteira: lista + conversa. Vive num componente próprio para
 * que a rota do Inbox (já grande) não dobre de tamanho, e porque grupo não
 * compartilha nenhum estado com o fluxo de atendimento.
 */
export function GruposPane({ meuUserId, formatTime, tabs }: Props) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [debouncedFilter, setDebouncedFilter] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedFilter(filter.trim()), 300);
    return () => clearTimeout(t);
  }, [filter]);

  const gruposQuery = useQuery({
    queryKey: ["grupos", "lista"],
    queryFn: listGrupos,
  });
  const grupos = gruposQuery.data ?? [];

  // Busca por conteúdo de mensagem (mesma regra da lista individual: 2+ chars).
  const buscaQuery = useQuery({
    queryKey: ["grupos", "busca-msg", debouncedFilter],
    queryFn: () => searchGrupoIdsByMessageContent(debouncedFilter),
    enabled: debouncedFilter.length >= 2,
    staleTime: 30_000,
  });
  const idsComTermo = buscaQuery.data ?? new Set<string>();

  const filtrados = filter
    ? grupos.filter((g) => {
        const f = filter.toLowerCase();
        return (
          g.nome.toLowerCase().includes(f) ||
          (g.topico?.toLowerCase().includes(f) ?? false) ||
          idsComTermo.has(g.id)
        );
      })
    : grupos;

  const current = grupos.find((g) => g.id === selectedId) ?? null;

  const syncMut = useMutation({
    mutationFn: sincronizarGrupos,
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ["grupos", "lista"] });
      const partes = [`${r.total} grupo${r.total === 1 ? "" : "s"}`];
      if (r.novos > 0) partes.push(`${r.novos} novo${r.novos === 1 ? "" : "s"}`);
      if (r.desativados > 0) partes.push(`${r.desativados} fora`);
      toast.success(`Sincronizado: ${partes.join(" · ")}`);
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Não foi possível sincronizar os grupos agora.");
    },
  });

  // Realtime: um canal só para as tabelas de grupo. Os callbacks do chat aberto
  // ficam num ref para o canal não ser recriado a cada render (recriar fazia
  // perder INSERTs na janela de reinscrição).
  const chatCbsRef = useRef<{
    onInsert: (messageId: string, grupoId: string) => void;
    onUpdate: (messageId: string, grupoId: string) => void;
  }>({ onInsert: () => {}, onUpdate: () => {} });

  useEffect(() => {
    const canal = supabase
      .channel("grupos-realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "grupo_mensagens" },
        (payload) => {
          const row = payload.new as { id?: string; grupo_id?: string } | null;
          queryClient.invalidateQueries({ queryKey: ["grupos", "lista"] });
          queryClient.invalidateQueries({ queryKey: ["inbox-unread-total"] });
          queryClient.invalidateQueries({ queryKey: ["inbox", "abas-unread"] });
          if (row?.id && row.grupo_id) chatCbsRef.current.onInsert(row.id, row.grupo_id);
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "grupo_mensagens" },
        (payload) => {
          const row = payload.new as { id?: string; grupo_id?: string } | null;
          queryClient.invalidateQueries({ queryKey: ["grupos", "lista"] });
          if (row?.id && row.grupo_id) chatCbsRef.current.onUpdate(row.id, row.grupo_id);
        },
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "grupos" }, () => {
        queryClient.invalidateQueries({ queryKey: ["grupos", "lista"] });
      })
      .subscribe();
    return () => {
      supabase.removeChannel(canal);
    };
  }, [queryClient]);

  return (
    <>
      {/* Lista */}
      <div className="w-[360px] shrink-0 border-r border-border bg-card overflow-y-auto">
        <div className="p-4 border-b border-border space-y-2">
          <button
            onClick={() => syncMut.mutate()}
            disabled={syncMut.isPending}
            className="flex w-full items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            {syncMut.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" strokeWidth={1.8} />
            )}
            Sincronizar grupos
          </button>
          {tabs}
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            type="text"
            placeholder="Buscar grupos..."
            className="w-full rounded-2xl border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>

        <GruposList
          grupos={filtrados}
          selectedId={selectedId}
          isLoading={gruposQuery.isLoading}
          isSyncing={syncMut.isPending}
          temFiltro={filter.trim() !== ""}
          onSelect={setSelectedId}
          onSync={() => syncMut.mutate()}
          formatTime={formatTime}
        />
      </div>

      {/* Conversa */}
      <div className="relative flex flex-1 flex-col bg-background">
        {!current ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="text-center">
              <Users className="mx-auto h-12 w-12 text-muted-foreground" strokeWidth={1.2} />
              <p className="mt-3 text-sm text-muted-foreground">Selecione um grupo</p>
            </div>
          </div>
        ) : (
          <GrupoChatPanel
            key={current.id}
            grupo={current}
            meuUserId={meuUserId}
            formatTime={formatTime}
            registrarRealtime={(cbs) => {
              chatCbsRef.current = cbs;
            }}
          />
        )}
      </div>
    </>
  );
}
