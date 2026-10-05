import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Loader2, MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { type DocsConversa, type DocsFiltro, formatarHora } from "@/lib/docs-logic";
import {
  contarDocsAtivas,
  fetchDocsConversaById,
  listDocsConversas,
  listMinhasDocsConversas,
} from "@/lib/docs-queries";
import { useDocsRealtime } from "@/hooks/useDocsRealtime";
import { DocsChatPanel } from "./DocsChatPanel";
import { DocsList } from "./DocsList";
import { DocsNovaConversaDialog } from "./DocsNovaConversaDialog";
import { DocsStatusFilter } from "./DocsStatusFilter";

interface Props {
  user: { id: string; isSuperadmin: boolean };
  /** Conversa aberta — mora na URL (?conversa=), que a notificação também usa. */
  conversaId: string | null;
  onSelecionar: (conversaId: string | null) => void;
}

const formatTime = (iso: string | null) => formatarHora(iso);
const ESPERA_BUSCA_MS = 300;

/**
 * A aba Docs inteira: lista + conversa, no padrão lista ↔ detalhe da Inbox.
 * Filtro e busca rodam no banco (docs_listar_conversas); o realtime mora em
 * useDocsRealtime.
 */
export function DocsPane({ user, conversaId, onSelecionar }: Props) {
  const queryClient = useQueryClient();
  const [busca, setBusca] = useState("");
  const [buscaNoBanco, setBuscaNoBanco] = useState("");
  const [filtro, setFiltro] = useState<DocsFiltro>("todas");
  const [novaOpen, setNovaOpen] = useState(false);
  const chatCbsRef = useDocsRealtime();

  useEffect(() => {
    const t = setTimeout(() => setBuscaNoBanco(busca.trim()), ESPERA_BUSCA_MS);
    return () => clearTimeout(t);
  }, [busca]);

  const conversasQ = useQuery({
    queryKey: ["docs", "conversas", user.id, filtro, buscaNoBanco],
    queryFn: () => listDocsConversas({ meuUserId: user.id, filtro, busca: buscaNoBanco }),
    // Trocar filtro/busca mantém a lista anterior na tela até a nova chegar.
    placeholderData: keepPreviousData,
  });
  const conversas = useMemo(() => conversasQ.data ?? [], [conversasQ.data]);
  const naLista = conversas.find((c) => c.id === conversaId) ?? null;

  // Conversa aberta que não está na lista (filtro, busca, "Nova conversa" sem
  // mensagem ainda): busca avulsa por id, para o chat não sumir.
  const avulsaQ = useQuery({
    queryKey: ["docs", "conversa", conversaId],
    queryFn: () => fetchDocsConversaById(conversaId as string),
    enabled: !!conversaId && !naLista && conversasQ.isSuccess && !conversasQ.isPlaceholderData,
  });
  // Última conversa vista: assumir no filtro "Sem dono" (ou buscar algo que a
  // exclua) tira a conversa do resultado; sem isto o chat desmontava e
  // recarregava do zero enquanto a busca avulsa não chegava.
  const ultimaRef = useRef<DocsConversa | null>(null);
  if (naLista) ultimaRef.current = naLista;
  const current =
    naLista ?? avulsaQ.data ?? (ultimaRef.current?.id === conversaId ? ultimaRef.current : null);
  // isPending (não isFetching): no render logo após a lista chegar, a busca
  // avulsa ainda não começou — sem isso piscava "Conversa não encontrada".
  const procurandoAvulsa =
    !!conversaId &&
    !naLista &&
    !conversasQ.isError &&
    (conversasQ.isPending ||
      conversasQ.isPlaceholderData ||
      avulsaQ.isPending ||
      avulsaQ.isFetching);

  // Só "sem dono" e "em andamento" têm número: são exatos e é o que importa.
  const contagensQ = useQuery({ queryKey: ["docs", "contagens"], queryFn: contarDocsAtivas });
  const contagens = {
    todas: 0,
    sem_dono: contagensQ.data?.semDono ?? 0,
    em_andamento: contagensQ.data?.emAndamento ?? 0,
    encerradas: 0,
  };

  // Destinos de "Encaminhar": só conversas em que eu sou o dono (a docs-acao
  // recusa o resto) e nunca a própria conversa aberta — independe do filtro.
  const minhasQ = useQuery({
    queryKey: ["docs", "minhas", user.id],
    queryFn: () => listMinhasDocsConversas(user.id),
  });
  const destinosEncaminhar = useMemo(
    () => (minhasQ.data ?? []).filter((c) => c.id !== conversaId),
    [minhasQ.data, conversaId],
  );

  const temFiltro = filtro !== "todas" || buscaNoBanco !== "";

  return (
    // No celular `data-pane` decide a coluna visível (conversa aberta → chat);
    // no desktop as duas convivem, igual à Inbox.
    <div className="flex h-full w-full" data-pane={conversaId ? "detalhe" : "lista"}>
      {/* Lista */}
      <div className="w-full shrink-0 overflow-y-auto border-r border-border bg-card scroll-contain md:w-[360px] [[data-pane=detalhe]_&]:hidden md:[[data-pane=detalhe]_&]:block">
        <div className="space-y-2 border-b border-border p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <h1 className="text-sm font-semibold text-foreground">Docs</h1>
              <p className="truncate text-xs text-muted-foreground">
                Conversas do número financeiro
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 rounded-2xl"
              onClick={() => setNovaOpen(true)}
            >
              <MessageSquarePlus className="h-4 w-4" strokeWidth={1.5} />
              Nova conversa
            </Button>
          </div>
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            type="text"
            placeholder="Buscar por nome ou número..."
            className="w-full rounded-2xl border border-border bg-card px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/20 md:py-2"
          />
          <DocsStatusFilter value={filtro} counts={contagens} onChange={setFiltro} />
        </div>

        {conversasQ.isError ? (
          <div className="px-6 py-12 text-center text-sm text-muted-foreground">
            <p>Não foi possível carregar as conversas.</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => void conversasQ.refetch()}
            >
              Tentar novamente
            </Button>
          </div>
        ) : (
          <DocsList
            conversas={conversas}
            selectedId={conversaId}
            meuUserId={user.id}
            isLoading={conversasQ.isLoading}
            temFiltro={temFiltro}
            onSelect={onSelecionar}
            formatTime={formatTime}
          />
        )}
      </div>

      {/* Conversa */}
      <div className="relative flex w-full min-w-0 flex-1 flex-col bg-background [[data-pane=lista]_&]:hidden md:[[data-pane=lista]_&]:flex">
        {current ? (
          <DocsChatPanel
            key={current.id}
            conversa={current}
            user={user}
            formatTime={formatTime}
            destinosEncaminhar={destinosEncaminhar}
            onVoltar={() => onSelecionar(null)}
            registrarRealtime={(cbs) => {
              chatCbsRef.current = cbs;
            }}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center p-6">
            <div className="text-center">
              {procurandoAvulsa ? (
                <Loader2 className="mx-auto h-6 w-6 animate-spin text-muted-foreground" />
              ) : (
                <>
                  <FileText className="mx-auto h-12 w-12 text-muted-foreground" strokeWidth={1.2} />
                  <p className="mt-3 text-sm text-muted-foreground">
                    {conversaId ? "Conversa não encontrada." : "Selecione uma conversa"}
                  </p>
                  {conversaId && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-3"
                      onClick={() => onSelecionar(null)}
                    >
                      Voltar para a lista
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>

      <DocsNovaConversaDialog
        open={novaOpen}
        onOpenChange={setNovaOpen}
        onIniciada={(id) => {
          queryClient.invalidateQueries({ queryKey: ["docs"] });
          onSelecionar(id);
        }}
      />
    </div>
  );
}
