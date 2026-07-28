import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  BookUser,
  Loader2,
  MessageCirclePlus,
  RefreshCw,
  Search,
} from "lucide-react";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  googleStatus,
  googleSync,
  listContatos,
  type Contato,
} from "@/lib/contatos-queries";
import { cadastrarClienteSingle, formatTelefoneBR } from "@/lib/clientes-queries";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_app/contatos")({
  staticData: { title: "Contatos" },
  component: ContatosPage,
});

const PAGE_SIZE = 50;

function initials(nome: string): string {
  return nome
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0])
    .join("")
    .toUpperCase();
}

function ContatosPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { user } = useCurrentUser();
  const canViewAll = !!user && (user.isSuperadmin || user.permissions.includes("view_all_departments"));

  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);
  const [preparandoId, setPreparandoId] = useState<string | null>(null);

  // Debounce da busca
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const statusQ = useQuery({ queryKey: ["google-status"], queryFn: googleStatus });

  const listaQ = useQuery({
    queryKey: ["contatos", debounced, page],
    queryFn: () => listContatos({ search: debounced, page, pageSize: PAGE_SIZE }),
  });

  const syncM = useMutation({
    mutationFn: googleSync,
    onSuccess: (r) => {
      if (r.ok) {
        toast.success(`Contatos atualizados · ${r.total ?? 0} contato(s).`);
        qc.invalidateQueries({ queryKey: ["contatos"] });
        qc.invalidateQueries({ queryKey: ["google-status"] });
      } else {
        toast.error(r.detalhe ?? "Não foi possível atualizar. Conecte a conta em Configurações.");
      }
    },
    onError: () => toast.error("Falha ao atualizar os contatos."),
  });

  function abrirNoInbox(atendimentoId: string) {
    void navigate({ to: "/inbox", search: { conversation: atendimentoId } });
  }

  /**
   * "Conversar" abre o atendimento na hora, atribuído a quem clicou — sem
   * diálogo de departamento/atendente. Antes isto só abria o diálogo "Iniciar
   * atendimento", que exigia escolher um atendente do departamento; quem não
   * tem departamento (dono/administrador) não conseguia se atribuir e o chat
   * nunca abria.
   *
   * Se o cliente já está em atendimento, não cria outro: abre o existente
   * quando dá para enxergá-lo, senão avisa quem está responsável.
   */
  async function iniciarConversa(contato: Contato) {
    if (!contato.numero_whatsapp) {
      toast.error("Este contato não tem um número de WhatsApp válido.");
      return;
    }
    setPreparandoId(contato.id);
    try {
      // Garante que existe um cliente com esse número (cria/atualiza) usando o
      // nome do contato do Google.
      const nome = contato.nome?.trim() || contato.numero_raw || contato.numero_whatsapp;
      const cliente = await cadastrarClienteSingle(nome, contato.numero_whatsapp);

      const { data, error } = await supabase.functions.invoke("iniciar-atendimento", {
        body: { client_id: cliente.cliente.id, assign_to_me: true },
      });

      if (error) {
        const ctx = (error as { context?: Response }).context;
        const corpo = ctx ? await ctx.json().catch(() => null) : null;
        if (corpo?.error === "cliente_com_atendimento_ativo") {
          const meu = corpo.assigned_to && corpo.assigned_to === user?.id;
          if (meu || canViewAll) {
            toast.info("Este cliente já tem um atendimento aberto. Abrindo a conversa.");
            abrirNoInbox(corpo.atendimento_id as string);
            return;
          }
          toast.error(
            `Já está em atendimento com ${corpo.assigned_to_nome} (${corpo.department_nome}).`,
          );
          return;
        }
        toast.error(corpo?.detalhe || corpo?.erro || error.message);
        return;
      }

      const resp = data as { ok: boolean; atendimento_id: string };
      if (resp?.ok) {
        toast.success("Atendimento iniciado");
        qc.invalidateQueries({ queryKey: ["inbox", "conversations"] });
        abrirNoInbox(resp.atendimento_id);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao iniciar a conversa.");
    } finally {
      setPreparandoId(null);
    }
  }

  const rows = listaQ.data?.rows ?? [];
  const total = listaQ.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const conectado = Boolean(statusQ.data?.connected);
  const contatosSincronizados = statusQ.data?.contacts_count ?? 0;

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent">
            <BookUser className="h-5 w-5 text-primary" strokeWidth={1.75} />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-foreground">Contatos</h1>
            <p className="text-sm text-muted-foreground">
              Contatos da conta Google da Almore. Escolha um para iniciar uma conversa.
            </p>
          </div>
        </div>
        {conectado && (
          <button
            type="button"
            onClick={() => syncM.mutate()}
            disabled={syncM.isPending}
            className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
          >
            {syncM.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Atualizar agora
          </button>
        )}
      </div>

      {/* Busca */}
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por nome ou número…"
          className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-primary/20"
        />
      </div>

      {/* Não conectado */}
      {!statusQ.isLoading && !conectado && contatosSincronizados === 0 && total === 0 && (
        <div className="rounded-2xl border border-border bg-card p-8 text-center">
          <p className="text-sm text-muted-foreground">
            A conta Google ainda não foi conectada. Vá em{" "}
            <strong className="text-foreground">Configurações › Contatos Google</strong> e
            clique em “Conectar Google”.
          </p>
        </div>
      )}

      {/* Conectado, sem contatos ainda */}
      {!listaQ.isLoading && conectado && total === 0 && !debounced && (
        <div className="rounded-2xl border border-border bg-card p-8 text-center">
          <p className="text-sm text-muted-foreground">
            Nenhum contato ainda. Se a lista de contatos do Google está vazia, isto é
            normal — assim que você adicionar contatos lá, eles aparecem aqui sozinhos.
          </p>
        </div>
      )}

      {/* Busca sem resultado */}
      {!listaQ.isLoading && total === 0 && debounced && (
        <div className="rounded-2xl border border-border bg-card p-8 text-center">
          <p className="text-sm text-muted-foreground">
            Nenhum contato encontrado para “{debounced}”.
          </p>
        </div>
      )}

      {listaQ.isLoading && (
        <div className="flex items-center justify-center rounded-2xl border border-border bg-card py-12 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Carregando contatos…
        </div>
      )}

      {/* Lista */}
      {!listaQ.isLoading && rows.length > 0 && (
        <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
          {rows.map((c) => {
            const nomeExib = c.nome?.trim() || c.numero_raw || c.numero_whatsapp || "Sem nome";
            return (
              <div key={c.id} className="flex items-center gap-3 px-4 py-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                  {initials(nomeExib)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground">{nomeExib}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {c.numero_whatsapp
                      ? formatTelefoneBR(c.numero_whatsapp)
                      : c.numero_raw
                        ? `${c.numero_raw} (sem WhatsApp)`
                        : "sem telefone"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => iniciarConversa(c)}
                  disabled={!c.numero_whatsapp || preparandoId === c.id}
                  title={c.numero_whatsapp ? "Iniciar conversa" : "Contato sem número de WhatsApp"}
                  className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
                >
                  {preparandoId === c.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <MessageCirclePlus className="h-3.5 w-3.5" />
                  )}
                  Conversar
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Paginação */}
      {total > PAGE_SIZE && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            {total} contato(s) · página {page} de {totalPages}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="rounded-lg border border-border px-3 py-1.5 font-medium text-foreground hover:bg-accent disabled:opacity-40"
            >
              Anterior
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="rounded-lg border border-border px-3 py-1.5 font-medium text-foreground hover:bg-accent disabled:opacity-40"
            >
              Próxima
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
