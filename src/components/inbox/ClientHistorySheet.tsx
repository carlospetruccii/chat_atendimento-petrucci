import { Clock, X, Loader2, UserRound } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import {
  listAtendentesChain,
  listClientAtendimentosVisiveis,
  type AtendenteChainItem,
  type ClientAtendimentoSummary,
  FALLBACK_DEPT_COR,
  type AtendimentoStatus,
} from "@/lib/inbox-queries";
import { shortDateSP } from "@/lib/inbox-history";

interface Props {
  open: boolean;
  onClose: () => void;
  clientId: string;
  clientNome: string;
  currentAtendimentoId: string;
  currentDepartmentId: string | null;
  onPick: (atendimentoId: string) => void;
}

const STATUS_TXT: Record<AtendimentoStatus, string> = {
  em_triagem: "Em triagem",
  reservado: "Reservado",
  em_atendimento: "Em atendimento",
  pendente: "Pendente",
  encerrado: "Encerrado",
};

function statusBadge(status: AtendimentoStatus): string {
  switch (status) {
    case "encerrado":
      return "bg-emerald-100 text-emerald-700";
    case "em_triagem":
      return "bg-amber-100 text-amber-700";
    case "em_atendimento":
      return "bg-card text-blue-700";
    case "reservado":
      return "bg-indigo-100 text-indigo-700";
    case "pendente":
      return "bg-muted text-muted-foreground";
  }
}

export function ClientHistorySheet({
  open,
  onClose,
  clientId,
  clientNome,
  currentAtendimentoId,
  currentDepartmentId,
  onPick,
}: Props) {
  const { data, isLoading } = useQuery<ClientAtendimentoSummary[]>({
    queryKey: ["inbox", "client-history", clientId],
    queryFn: () =>
      listClientAtendimentosVisiveis({
        clientId,
        currentAtendimentoId,
        currentDepartmentId,
        canViewAll: true, // sheet só abre para quem pode ver tudo
      }),
    enabled: open && !!clientId,
  });

  // Cadeia de "quem atendeu" por atendimento (nome + departamento, na ordem).
  const ids = (data ?? []).map((a) => a.id);
  const { data: chains, isLoading: chainsLoading } = useQuery<
    Record<string, AtendenteChainItem[]>
  >({
    queryKey: ["inbox", "atendentes-chain", clientId, ids.join(",")],
    queryFn: () => listAtendentesChain(ids),
    enabled: open && ids.length > 0,
  });

  if (!open) return null;

  return (
    <>
      <div
        onClick={onClose}
        className="absolute inset-0 z-20 bg-black/20"
      />
      <aside
        className="absolute top-0 right-0 z-30 h-full w-[400px] bg-card border-l border-border shadow-lg"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2 min-w-0">
            <Clock className="h-5 w-5 text-primary shrink-0" strokeWidth={1.5} />
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-foreground truncate">
                Linha do tempo
              </h3>
              <p className="text-xs text-muted-foreground truncate">{clientNome}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Fechar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 space-y-2 overflow-y-auto h-[calc(100%-64px)]">
          {isLoading ? (
            <div className="text-center text-sm text-muted-foreground py-8">
              <Loader2 className="inline h-4 w-4 animate-spin mr-2" /> Carregando...
            </div>
          ) : (data ?? []).length === 0 ? (
            <div className="text-center text-sm text-muted-foreground py-8">
              Nenhum atendimento encontrado.
            </div>
          ) : (
            (data ?? []).map((a) => {
              const isCurrent = a.id === currentAtendimentoId;
              const dataLabel =
                a.status === "encerrado" && a.closedAt
                  ? `${shortDateSP(a.createdAt)} → ${shortDateSP(a.closedAt)}`
                  : `${shortDateSP(a.createdAt)} → em andamento`;
              return (
                <button
                  key={a.id}
                  onClick={() => {
                    onPick(a.id);
                    onClose();
                  }}
                  className={`w-full text-left rounded-lg border p-3 transition-colors ${
                    isCurrent
                      ? "border-primary bg-muted"
                      : "border-border bg-background hover:bg-muted"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-foreground">
                      {dataLabel}
                    </span>
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded ${statusBadge(a.status)}`}
                    >
                      {STATUS_TXT[a.status]}
                    </span>
                  </div>
                  <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded"
                      style={{
                        backgroundColor: `${a.departmentCor ?? FALLBACK_DEPT_COR}1A`,
                        color: a.departmentCor ?? FALLBACK_DEPT_COR,
                      }}
                    >
                      {a.departmentNome ?? "Triagem"}
                    </span>
                    {isCurrent && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-primary">
                        Atual
                      </span>
                    )}
                  </div>

                  {/* Quem atendeu — cadeia na ordem (repasses inclusos) */}
                  <div className="mt-2 flex items-start gap-1.5 text-[11px]">
                    <UserRound
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground mt-0.5"
                      strokeWidth={1.75}
                    />
                    {(() => {
                      const cadeia = chains?.[a.id] ?? [];
                      if (chainsLoading && cadeia.length === 0) {
                        return <span className="text-muted-foreground">Carregando…</span>;
                      }
                      if (cadeia.length === 0) {
                        return (
                          <span className="text-muted-foreground italic">
                            Aguardando atendente
                          </span>
                        );
                      }
                      return (
                        <span className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
                          {cadeia.map((p, i) => (
                            <span key={`${p.userId}-${i}`} className="flex items-center gap-1">
                              {i > 0 && <span className="text-muted-foreground">→</span>}
                              <span className="font-medium text-foreground">{p.nome}</span>
                              {p.departmentNome && (
                                <span
                                  style={{ color: p.departmentCor ?? undefined }}
                                  className="text-muted-foreground"
                                >
                                  ({p.departmentNome})
                                </span>
                              )}
                            </span>
                          ))}
                        </span>
                      );
                    })()}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </aside>
    </>
  );
}
