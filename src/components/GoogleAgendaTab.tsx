import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  BookUser,
  CheckCircle2,
  Loader2,
  Link2,
  RefreshCw,
  Unplug,
  AlertTriangle,
} from "lucide-react";
import {
  googleAuthUrl,
  googleDisconnect,
  googleStatus,
  googleSync,
} from "@/lib/agenda-queries";

function formatarData(iso: string | null): string {
  if (!iso) return "nunca";
  try {
    return new Date(iso).toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function GoogleAgendaTab() {
  const qc = useQueryClient();

  const statusQ = useQuery({
    queryKey: ["google-status"],
    queryFn: googleStatus,
    // Enquanto o 1º sync roda em background, atualiza mais rápido.
    refetchInterval: (q) => {
      const d = q.state.data;
      if (d?.connected && (d.contacts_count ?? 0) === 0 && d.last_sync_status !== "erro") {
        return 5_000;
      }
      return 30_000;
    },
  });

  // Detecta o retorno do consentimento do Google (?google=connected|error).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const g = params.get("google");
    if (g === "connected") {
      toast.success("Conta Google conectada! Sincronizando a agenda…");
      qc.invalidateQueries({ queryKey: ["google-status"] });
    } else if (g === "error") {
      toast.error("Não foi possível conectar a conta Google. Tente novamente.");
    }
    if (g) {
      params.delete("google");
      const q = params.toString();
      window.history.replaceState(
        {},
        "",
        window.location.pathname + (q ? `?${q}` : ""),
      );
    }
  }, [qc]);

  const connectM = useMutation({
    mutationFn: async () => {
      const back = `${window.location.origin}/configuracoes`;
      const url = await googleAuthUrl(back);
      window.location.href = url;
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Falha ao iniciar a conexão."),
  });

  const syncM = useMutation({
    mutationFn: googleSync,
    onSuccess: (r) => {
      if (r.ok) {
        toast.success(`Agenda atualizada · ${r.total ?? 0} contato(s).`);
        qc.invalidateQueries({ queryKey: ["google-status"] });
        qc.invalidateQueries({ queryKey: ["agenda-contatos"] });
      } else {
        toast.error(r.detalhe ?? "Falha ao atualizar a agenda.");
      }
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Falha ao atualizar."),
  });

  const disconnectM = useMutation({
    mutationFn: googleDisconnect,
    onSuccess: () => {
      toast.success("Conta Google desconectada.");
      qc.invalidateQueries({ queryKey: ["google-status"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Falha ao desconectar."),
  });

  const st = statusQ.data;
  const naoConfig = st && !st.configured;
  const conectado = Boolean(st?.connected);

  return (
    <div className="max-w-2xl">
      <div className="mb-6 flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent">
          <BookUser className="h-5 w-5 text-primary" strokeWidth={1.75} />
        </div>
        <div>
          <h2 className="text-base font-semibold text-foreground">Agenda do Google</h2>
          <p className="text-sm text-muted-foreground">
            Conecte a conta Google da Almore para trazer os contatos salvos. O nome
            salvo na agenda aparece no Inbox no lugar do número.
          </p>
        </div>
      </div>

      {statusQ.isLoading && (
        <div className="flex items-center justify-center rounded-2xl border border-border bg-card py-12 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Verificando conexão…
        </div>
      )}

      {/* Secrets do Google ainda não configurados no servidor */}
      {!statusQ.isLoading && naoConfig && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-6 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <h3 className="text-base font-semibold">Integração ainda não configurada</h3>
              <p className="mt-1 text-sm">
                As credenciais do Google (Client ID e Client Secret) ainda não foram
                cadastradas no servidor. Assim que forem, o botão “Conectar Google”
                ficará disponível aqui.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Conectado */}
      {!statusQ.isLoading && !naoConfig && conectado && (
        <div className="rounded-2xl border border-border bg-card p-6">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="h-6 w-6 text-emerald-500" />
            <div>
              <h3 className="text-base font-semibold text-foreground">Conectado</h3>
              <p className="text-sm text-muted-foreground">
                {st?.email ? `${st.email} · ` : ""}
                {st?.contacts_count ?? 0} contato(s) na agenda
              </p>
            </div>
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Última sincronização</dt>
              <dd className="text-foreground">{formatarData(st?.last_sync_at ?? null)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Situação</dt>
              <dd className="text-foreground">
                {st?.last_sync_status === "erro" ? (
                  <span className="text-red-600">Erro na última sincronização</span>
                ) : (st?.contacts_count ?? 0) === 0 ? (
                  "Sincronizando / sem contatos ainda"
                ) : (
                  "Em dia"
                )}
              </dd>
            </div>
          </dl>

          {st?.last_sync_status === "erro" && st?.last_sync_error && (
            <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">
              {st.last_sync_error}
            </p>
          )}

          {(st?.contacts_count ?? 0) === 0 && st?.last_sync_status !== "erro" && (
            <p className="mt-3 text-sm text-muted-foreground">
              Nenhum contato ainda — se a agenda do Google estiver vazia, isto é normal.
              Assim que você adicionar contatos no Google, eles aparecem aqui sozinhos.
            </p>
          )}

          <div className="mt-6 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => syncM.mutate()}
              disabled={syncM.isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {syncM.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              Atualizar agora
            </button>
            <button
              type="button"
              onClick={() => disconnectM.mutate()}
              disabled={disconnectM.isPending}
              className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
            >
              {disconnectM.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Unplug className="h-4 w-4" />
              )}
              Desconectar
            </button>
          </div>
        </div>
      )}

      {/* Desconectado (mas configurado) */}
      {!statusQ.isLoading && !naoConfig && !conectado && (
        <div className="rounded-2xl border border-border bg-card p-6">
          <h3 className="text-base font-semibold text-foreground">
            Conecte a agenda do Google
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Você entra com a conta Google da Almore e autoriza a leitura dos contatos.
            A partir daí, a agenda sincroniza sozinha.
          </p>
          <button
            type="button"
            onClick={() => connectM.mutate()}
            disabled={connectM.isPending}
            className="mt-6 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {connectM.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Link2 className="h-4 w-4" />
            )}
            Conectar Google
          </button>
        </div>
      )}
    </div>
  );
}
