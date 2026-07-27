import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Users } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  listGrupos,
  searchGrupoIdsByMessageContent,
  sincronizarGrupos,
} from "@/lib/grupos-queries";
import { deveSincronizar } from "@/lib/grupos-auto-sync";
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

  // Sincronização com o WhatsApp: roda sozinha, sem botão. Silenciosa no
  // sucesso — é atualização de fundo, não ação do usuário; avisa só quando algo
  // muda de fato (grupo novo ou grupo que saiu) ou quando falha com a lista
  // vazia, caso em que a tela não tem o que mostrar e o motivo importa.
  const syncMut = useMutation({
    mutationFn: sincronizarGrupos,
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ["grupos", "lista"] });
      if (r.novos > 0) {
        toast.success(
          `${r.novos} grupo${r.novos === 1 ? "" : "s"} novo${r.novos === 1 ? "" : "s"}`,
        );
      }
      if (r.desativados > 0) {
        toast.message(
          `${r.desativados} grupo${r.desativados === 1 ? "" : "s"} saiu da lista (não somos mais membro)`,
        );
      }
    },
    onError: (e) => {
      if (grupos.length === 0) {
        toast.error(e instanceof Error ? e.message : "Não foi possível buscar os grupos agora.");
      }
    },
  });

  // Dispara a sincronização automática quando a lista termina de carregar e o
  // último carimbo já está velho (ver grupos-auto-sync.ts para a regra).
  const jaTentouSyncRef = useRef(false);
  useEffect(() => {
    if (gruposQuery.isLoading) return;
    const precisa = deveSincronizar({
      grupos,
      agoraMs: Date.now(),
      sincronizando: syncMut.isPending,
      jaTentou: jaTentouSyncRef.current,
    });
    if (!precisa) return;
    jaTentouSyncRef.current = true;
    syncMut.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gruposQuery.isLoading, gruposQuery.dataUpdatedAt]);

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
          {tabs}
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            type="text"
            placeholder="Buscar grupos..."
            className="w-full rounded-2xl border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/20"
          />
          {/* A sincronização não tem botão: roda sozinha. Só damos o sinal de
              que está acontecendo, para a lista não parecer travada. */}
          {syncMut.isPending && (
            <div className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Atualizando grupos...
            </div>
          )}
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
