import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import {
  Search,
  Clock,
  AlertTriangle,
  LayoutGrid,
  Table as TableIcon,
  Lock,
  ArrowRightCircle,
  Eye,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser, useHasPermission } from "@/hooks/useCurrentUser";
import {
  fetchPendentes,
  fetchDepartments,
  fetchSubjects,
  fetchCollaborators,
  fetchUltimasMensagens,
  claimAtendimento,
  formatWait,
  type PendenteRow,
  type CollaboratorOption,
  type PreviewMessage,
} from "@/lib/pendentes-queries";
import { MessageMedia } from "@/components/inbox-media/MessageMedia";
import type { InboxMessage } from "@/lib/inbox-queries";

export const Route = createFileRoute("/_app/pendentes")({
  component: PendentesPage,
});

type ViewMode = "grid" | "table";
type WaitFilter = "all" | "lt30" | "30to120" | "gt120";
type SortBy = "newest" | "longest" | "department";

function deptBadgeStyle(cor: string): React.CSSProperties {
  return { backgroundColor: `${cor}20`, color: cor };
}

function subjectBadgeStyle(cor: string): React.CSSProperties {
  return { backgroundColor: `${cor}14`, color: cor };
}

function PendentesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, loading: userLoading } = useCurrentUser();
  const canAssign = useHasPermission("assign_pending");
  const isSuperadmin = user?.isSuperadmin ?? false;

  const [view, setView] = useState<ViewMode>("grid");
  const [dept, setDept] = useState<string>("all");
  const [subject, setSubject] = useState<string>("all");
  const [wait, setWait] = useState<WaitFilter>("all");
  const [sortBy, setSortBy] = useState<SortBy>("longest");
  const [search, setSearch] = useState("");
  const [assignTarget, setAssignTarget] = useState<PendenteRow | null>(null);
  const [previewTarget, setPreviewTarget] = useState<PendenteRow | null>(null);

  const pendentesQuery = useQuery({
    queryKey: ["pendentes"],
    queryFn: fetchPendentes,
    enabled: !!user,
    refetchInterval: 60_000,
  });

  const deptsQuery = useQuery({
    queryKey: ["departments-active"],
    queryFn: fetchDepartments,
    enabled: !!user,
  });

  const subjectsQuery = useQuery({
    queryKey: ["subjects-active"],
    queryFn: fetchSubjects,
    enabled: !!user,
  });

  const collaboratorsQuery = useQuery({
    queryKey: ["collaborators-active"],
    queryFn: fetchCollaborators,
    enabled: !!user && canAssign,
  });

  // Realtime: invalida a lista quando atendimentos, mensagens ou a flag global mudam
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel("pendentes-watch")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "atendimentos" },
        () => {
          queryClient.invalidateQueries({ queryKey: ["pendentes"] });
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "mensagens" },
        () => {
          queryClient.invalidateQueries({ queryKey: ["pendentes"] });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "system_config",
          filter: "chave=eq.pendentes_abertos_a_todos",
        },
        () => {
          queryClient.invalidateQueries({ queryKey: ["pendentes"] });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, queryClient]);

  const claimMutation = useMutation({
    mutationFn: async (vars: { atendimentoId: string; assignTo: string }) => {
      const won = await claimAtendimento(vars.atendimentoId, vars.assignTo, user.id);
      return { won, ...vars };
    },
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["pendentes"] });
      if (!res.won) {
        toast.info("Esse atendimento já foi atribuído");
        return;
      }
      if (res.assignTo === user?.id) {
        toast.success("Atendimento atribuído a você");
        navigate({ to: "/inbox" });
      } else {
        toast.success("Atendimento atribuído");
      }
    },
    onError: (err: Error) => {
      toast.error(err.message ?? "Falha ao atribuir atendimento");
    },
  });

  const items = pendentesQuery.data ?? [];
  const departments = deptsQuery.data ?? [];
  const subjects = subjectsQuery.data ?? [];

  const subjectsForFilter = useMemo(() => {
    if (dept === "all") return subjects;
    return subjects.filter((s) => s.departmentId === dept);
  }, [subjects, dept]);

  const filtered = useMemo(() => {
    let list = items.slice();
    if (dept !== "all") list = list.filter((i) => i.departmentId === dept);
    if (subject !== "all") list = list.filter((i) => i.subjectId === subject);
    if (wait !== "all") {
      list = list.filter((i) => {
        if (wait === "lt30") return i.waitingMin < 30;
        if (wait === "30to120") return i.waitingMin >= 30 && i.waitingMin <= 120;
        return i.waitingMin > 120;
      });
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (i) =>
          i.clientNome.toLowerCase().includes(q) ||
          i.clientNumero.includes(q) ||
          i.preview.toLowerCase().includes(q),
      );
    }
    list.sort((a, b) => {
      switch (sortBy) {
        case "newest":
          return a.waitingMin - b.waitingMin;
        case "longest":
          return b.waitingMin - a.waitingMin;
        case "department":
          return (a.departmentNome ?? "zz").localeCompare(b.departmentNome ?? "zz");
      }
    });
    return list;
  }, [items, dept, subject, wait, sortBy, search]);

  if (userLoading) {
    return (
      <div className="flex items-center justify-center py-24 text-sm text-muted-foreground">
        Carregando...
      </div>
    );
  }

  const handleAttend = (item: PendenteRow) => {
    claimMutation.mutate({ atendimentoId: item.id, assignTo: user.id });
  };

  const handleAssign = (item: PendenteRow, agent: CollaboratorOption) => {
    setAssignTarget(null);
    claimMutation.mutate({ atendimentoId: item.id, assignTo: agent.id });
  };

  const isLoading = pendentesQuery.isLoading;

  return (
    <>
      {/* Cabeçalho */}
      <div className="mb-6 flex items-center justify-between gap-4">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl font-semibold text-foreground">Pendentes</h1>
          <span className="text-sm text-muted-foreground">
            {filtered.length} {filtered.length === 1 ? "conversa" : "conversas"}
          </span>
        </div>
        <div className="flex items-center rounded-md bg-[#F3F4F6] p-1">
          <button
            type="button"
            onClick={() => setView("grid")}
            className={`flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition-colors ${
              view === "grid" ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
            aria-label="Visualização em grade"
          >
            <LayoutGrid className="h-4 w-4" strokeWidth={1.5} />
            Grade
          </button>
          <button
            type="button"
            onClick={() => setView("table")}
            className={`flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition-colors ${
              view === "table" ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
            aria-label="Visualização em tabela"
          >
            <TableIcon className="h-4 w-4" strokeWidth={1.5} />
            Tabela
          </button>
        </div>
      </div>

      {/* Filtros */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="relative">
          <Select value={dept} onValueChange={setDept} disabled={!isSuperadmin}>
            <SelectTrigger className="w-[200px] bg-card">
              <SelectValue />
              {!isSuperadmin && (
                <Lock className="ml-2 h-3 w-3 text-muted-foreground" strokeWidth={1.5} />
              )}
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os departamentos</SelectItem>
              {departments.map((d) => (
                <SelectItem key={d.id} value={d.id}>{d.nome}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Select value={subject} onValueChange={setSubject}>
          <SelectTrigger className="w-[200px] bg-card">
            <SelectValue placeholder="Assunto" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os assuntos</SelectItem>
            {subjectsForFilter.map((s) => (
              <SelectItem key={s.id} value={s.id}>{s.nome}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={wait} onValueChange={(v) => setWait(v as WaitFilter)}>
          <SelectTrigger className="w-[180px] bg-card">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Qualquer tempo</SelectItem>
            <SelectItem value="lt30">Até 30min</SelectItem>
            <SelectItem value="30to120">30min – 2h</SelectItem>
            <SelectItem value="gt120">Mais de 2h</SelectItem>
          </SelectContent>
        </Select>

        <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortBy)}>
          <SelectTrigger className="w-[220px] bg-card">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="newest">Menor tempo aguardando</SelectItem>
            <SelectItem value="longest">Maior tempo aguardando</SelectItem>
            <SelectItem value="department">Por departamento</SelectItem>
          </SelectContent>
        </Select>

        <div className="ml-auto relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" strokeWidth={1.5} />
          <input
            placeholder="Buscar..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="rounded-2xl border border-border bg-card py-2 pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-primary/20 w-64"
          />
        </div>
      </div>

      {/* Conteúdo */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-44 rounded-2xl border border-border bg-muted animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="rounded-full bg-accent p-4">
            <Clock className="h-8 w-8 text-primary" strokeWidth={1.2} />
          </div>
          <h3 className="mt-4 text-base font-medium text-foreground">Nenhum atendimento pendente</h3>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            Você está em dia. Novas conversas pendentes aparecerão aqui automaticamente.
          </p>
        </div>
      ) : view === "grid" ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 animate-in fade-in duration-200">
          {filtered.map((c) => (
            <div key={c.id} className="relative rounded-2xl border border-border bg-card p-5 shadow-sm">
              {c.releasedByTimeout && (
                <span className="absolute top-3 right-3 inline-flex items-center gap-1 rounded bg-[#FEF3C7] px-2 py-0.5 text-[11px] font-medium text-[#92400E]">
                  <AlertTriangle className="h-3 w-3" strokeWidth={1.8} />
                  Liberado por timeout
                </span>
              )}
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-medium text-primary">
                  {c.initials}
                </div>
                <div className="min-w-0 pr-24">
                  <div className="text-sm font-semibold text-foreground truncate">{c.clientNome}</div>
                  <div className="text-xs text-muted-foreground truncate">{c.clientNumero}</div>
                </div>
              </div>

              <p className="mt-3 text-sm text-muted-foreground line-clamp-2 min-h-[2.5rem]">
                {c.preview || <span className="italic opacity-60">Sem mensagens</span>}
              </p>

              <div className="mt-3 flex flex-wrap gap-1.5">
                <span className="text-[11px] px-2 py-0.5 rounded" style={deptBadgeStyle(c.departmentCor)}>
                  {c.departmentNome ?? "Sem departamento"}
                </span>
                <span className="text-[11px] px-2 py-0.5 rounded" style={subjectBadgeStyle(c.departmentCor)}>
                  {c.subjectNome}
                </span>
              </div>

              <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock className="h-3.5 w-3.5" strokeWidth={1.5} />
                aguardando há {formatWait(c.waitingMin)}
              </div>

              <div className="mt-5 flex flex-col gap-2">
                <Button
                  onClick={() => handleAttend(c)}
                  disabled={claimMutation.isPending}
                  className="w-full"
                >
                  Atender
                </Button>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => setPreviewTarget(c)}
                  >
                    <Eye className="h-4 w-4 mr-1" strokeWidth={1.5} />
                    Pré-visualizar
                  </Button>
                  {canAssign && (
                    <Button variant="outline" className="flex-1" onClick={() => setAssignTarget(c)}>
                      Atribuir
                    </Button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card shadow-sm overflow-hidden animate-in fade-in duration-200">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cliente</TableHead>
                <TableHead>Departamento</TableHead>
                <TableHead>Assunto</TableHead>
                <TableHead>Aguardando há</TableHead>
                <TableHead>Origem</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-medium text-primary">
                        {c.initials}
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-foreground">{c.clientNome}</div>
                        <div className="text-xs text-muted-foreground">{c.clientNumero}</div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="text-[11px] px-2 py-0.5 rounded" style={deptBadgeStyle(c.departmentCor)}>
                      {c.departmentNome ?? "—"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="text-[11px] px-2 py-0.5 rounded" style={subjectBadgeStyle(c.departmentCor)}>
                      {c.subjectNome}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Clock className="h-3.5 w-3.5" strokeWidth={1.5} />
                      {formatWait(c.waitingMin)}
                    </div>
                  </TableCell>
                  <TableCell>
                    {c.releasedByTimeout ? (
                      <span className="inline-flex items-center gap-1 text-xs text-[#92400E]">
                        <AlertTriangle className="h-3 w-3" strokeWidth={1.8} />
                        Liberado por timeout
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">Triagem direta</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        onClick={() => handleAttend(c)}
                        disabled={claimMutation.isPending}
                      >
                        Atender
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setPreviewTarget(c)}
                        aria-label="Pré-visualizar mensagens"
                      >
                        <Eye className="h-4 w-4" strokeWidth={1.5} />
                      </Button>
                      {canAssign && (
                        <Button size="sm" variant="ghost" onClick={() => setAssignTarget(c)}>
                          Atribuir
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <AssignModal
        target={assignTarget}
        collaborators={collaboratorsQuery.data ?? []}
        onOpenChange={(o) => !o && setAssignTarget(null)}
        onConfirm={(agent) => assignTarget && handleAssign(assignTarget, agent)}
      />

      <PreviewModal
        target={previewTarget}
        items={items}
        onOpenChange={(o) => !o && setPreviewTarget(null)}
      />
    </>
  );
}

function PreviewModal({
  target,
  items,
  onOpenChange,
}: {
  target: PendenteRow | null;
  items: PendenteRow[];
  onOpenChange: (v: boolean) => void;
}) {
  const open = !!target;
  const previewQuery = useQuery({
    queryKey: ["pendente-preview", target?.id],
    queryFn: () => fetchUltimasMensagens(target!.id, 5),
    enabled: open,
    staleTime: 0,
  });

  // Auto-fechar se o pendente sumir da lista (atribuído por outra pessoa).
  useEffect(() => {
    if (!target) return;
    const stillThere = items.some((i) => i.id === target.id);
    if (!stillThere) {
      toast.info("Esse pendente foi atribuído a outra pessoa");
      onOpenChange(false);
    }
  }, [items, target, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Pré-visualizar mensagens</DialogTitle>
          <DialogDescription>
            Últimas 5 mensagens com {target?.clientNome ?? ""}.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto space-y-2 px-1">
          {previewQuery.isLoading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              Carregando…
            </div>
          ) : previewQuery.data && previewQuery.data.length > 0 ? (
            previewQuery.data.map((m) => <PreviewBubble key={m.id} m={m} />)
          ) : (
            <div className="py-8 text-center text-sm text-muted-foreground">
              Sem mensagens nesta conversa.
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Fechar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewBubble({ m }: { m: PreviewMessage }) {
  const isInbound = m.direction === "inbound";
  const isText = m.tipo === "texto";
  const time = new Date(m.createdAt).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });

  // Monta um InboxMessage mínimo para reusar o renderer de mídia do inbox.
  const asInbox = {
    id: m.id,
    atendimentoId: "",
    direction: m.direction,
    senderType: m.senderType,
    sentByUserId: null,
    sentByNome: null,
    tipo: m.tipo,
    content: m.content,
    mediaUrl: m.mediaUrl,
    mediaMetadata: m.mediaMetadata,
    createdAt: m.createdAt,
    replyToMessageId: null,
  } as unknown as InboxMessage;

  return (
    <div className={`flex ${isInbound ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${
          isInbound
            ? "bg-muted text-foreground"
            : "bg-muted text-foreground"
        }`}
      >
        {isText ? (
          m.content ? (
            <p className="whitespace-pre-wrap break-words">{m.content}</p>
          ) : (
            <p className="italic text-muted-foreground">(sem conteúdo)</p>
          )
        ) : (
          <MessageMedia message={asInbox} />
        )}
        <div className="mt-1 text-[10px] text-muted-foreground text-right">{time}</div>
      </div>
    </div>
  );
}

function AssignModal({
  target,
  collaborators,
  onOpenChange,
  onConfirm,
}: {
  target: PendenteRow | null;
  collaborators: CollaboratorOption[];
  onOpenChange: (v: boolean) => void;
  onConfirm: (agent: CollaboratorOption) => void;
}) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const filtered = collaborators.filter((c) =>
    c.nome.toLowerCase().includes(search.toLowerCase()),
  );

  const grouped = filtered.reduce<Record<string, CollaboratorOption[]>>((acc, c) => {
    (acc[c.departmentNome] ??= []).push(c);
    return acc;
  }, {});

  const selectedUser = collaborators.find((c) => c.id === selected) ?? null;

  return (
    <Dialog
      open={!!target}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) {
          setSearch("");
          setSelected(null);
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Atribuir atendimento</DialogTitle>
          <DialogDescription>
            Selecione o colaborador que vai atender este cliente.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar colaborador..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        <div className="max-h-64 overflow-y-auto -mx-1 px-1 space-y-3">
          {Object.entries(grouped).map(([dept, users]) => (
            <div key={dept}>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground px-1 mb-1">
                {dept}
              </div>
              <div className="space-y-1">
                {users.map((u) => (
                  <button
                    key={u.id}
                    onClick={() => setSelected(u.id)}
                    className={`w-full flex items-center gap-3 rounded-md px-2 py-2 text-left transition-colors ${
                      selected === u.id ? "bg-accent" : "hover:bg-muted"
                    }`}
                  >
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-xs font-medium text-primary">
                      {u.initials}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-foreground">{u.nome}</div>
                      <div className="text-xs text-muted-foreground">{u.departmentNome}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="py-6 text-center text-sm text-muted-foreground">
              Nenhum colaborador encontrado
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            disabled={!selectedUser}
            onClick={() => selectedUser && onConfirm(selectedUser)}
          >
            <ArrowRightCircle className="h-4 w-4" strokeWidth={1.5} />
            Atribuir
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
