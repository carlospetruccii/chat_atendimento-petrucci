import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Trash2, UserPlus, X } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  changeMemberRole,
  CompanyRole,
  fetchMembers,
  fetchWorkspaceInfo,
  inviteMember,
  MemberRow,
  removeMember,
  ROLE_LABEL,
} from "@/lib/workspaces-queries";

export const Route = createFileRoute("/almore-membros/$companyId")({
  staticData: { title: "Membros do espaço" },
  component: MembrosPage,
});

const ROLE_BADGE: Record<CompanyRole, { bg: string; fg: string }> = {
  dono: { bg: "#EDE9FE", fg: "#6D28D9" },
  administrador: { bg: "#DBEAFE", fg: "#1D4ED8" },
  colaborador: { bg: "#F3F4F6", fg: "#374151" },
};

function initials(n: string) {
  return n.split(" ").map((p) => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
}

type InviteRole = Exclude<CompanyRole, "dono">;

interface InviteForm {
  nome: string;
  email: string;
  role: InviteRole;
  departmentId: string;
}

const EMPTY_INVITE: InviteForm = { nome: "", email: "", role: "colaborador", departmentId: "" };

function MembrosPage() {
  const { companyId } = Route.useParams();
  const qc = useQueryClient();

  const infoQ = useQuery({
    queryKey: ["workspace-info", companyId],
    queryFn: () => fetchWorkspaceInfo(companyId),
  });
  const membersQ = useQuery({
    queryKey: ["members", companyId],
    queryFn: () => fetchMembers(companyId),
  });

  const departments = infoQ.data?.departments ?? [];
  const members = membersQ.data ?? [];

  const [inviteOpen, setInviteOpen] = useState(false);
  const [form, setForm] = useState<InviteForm>(EMPTY_INVITE);
  const [errors, setErrors] = useState<Partial<Record<keyof InviteForm, string>>>({});
  const [removeTarget, setRemoveTarget] = useState<MemberRow | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["members", companyId] });

  const inviteMut = useMutation({
    mutationFn: inviteMember,
    onSuccess: () => {
      invalidate();
      toast.success("Convite criado (pendente)");
      setInviteOpen(false);
      setForm(EMPTY_INVITE);
      setErrors({});
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const roleMut = useMutation({
    mutationFn: (vars: { row: MemberRow; role: CompanyRole; departmentId: string | null }) =>
      changeMemberRole(vars.row, vars.role, vars.departmentId),
    onSuccess: () => {
      invalidate();
      toast.success("Papel atualizado");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeMut = useMutation({
    mutationFn: removeMember,
    onSuccess: () => {
      invalidate();
      toast.success("Removido do espaço");
      setRemoveTarget(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function openInvite() {
    setForm({ ...EMPTY_INVITE, departmentId: departments[0]?.id ?? "" });
    setErrors({});
    setInviteOpen(true);
  }

  function validateInvite(): boolean {
    const e: Partial<Record<keyof InviteForm, string>> = {};
    if (!form.nome.trim()) e.nome = "Nome é obrigatório";
    if (!form.email.trim()) e.email = "E-mail é obrigatório";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) e.email = "E-mail inválido";
    if (form.role === "colaborador" && !form.departmentId) e.departmentId = "Escolha um departamento";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function submitInvite() {
    if (!validateInvite()) return;
    inviteMut.mutate({
      companyId,
      nome: form.nome,
      email: form.email,
      role: form.role,
      departmentId: form.role === "colaborador" ? form.departmentId : null,
    });
  }

  // Troca de papel inline. Dono nunca aparece aqui como opção.
  function onRoleChange(row: MemberRow, newRole: CompanyRole) {
    if (newRole === row.role) return;
    const departmentId =
      newRole === "colaborador" ? row.departmentId ?? departments[0]?.id ?? null : null;
    if (newRole === "colaborador" && !departmentId) {
      toast.error("O espaço não tem departamento para vincular o colaborador.");
      return;
    }
    roleMut.mutate({ row, role: newRole, departmentId });
  }

  function onDeptChange(row: MemberRow, departmentId: string) {
    roleMut.mutate({ row, role: "colaborador", departmentId });
  }

  const loading = infoQ.isLoading || membersQ.isLoading;
  const busy = roleMut.isPending || removeMut.isPending;

  const ordered = useMemo(() => members, [members]);

  return (
    <div className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto max-w-3xl space-y-6">
        <div>
          <a
            href="/almore"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" strokeWidth={1.7} /> Voltar aos espaços
          </a>
          <div className="mt-3 flex items-start justify-between gap-4">
            <div>
              <h1 className="text-xl font-semibold text-foreground">
                Membros — {infoQ.data?.nome ?? "..."}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Pessoas deste espaço e o papel de cada uma. Convites ficam pendentes até o login
                existir.
              </p>
            </div>
            <button
              onClick={openInvite}
              className="flex shrink-0 items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              <UserPlus className="h-4 w-4" strokeWidth={1.8} /> Convidar pessoa
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <ul className="divide-y divide-border rounded-2xl border border-border bg-card shadow-sm">
            {ordered.map((m) => {
              const badge = ROLE_BADGE[m.role];
              const isDono = m.role === "dono";
              return (
                <li key={`${m.origem}-${m.id}`} className="flex items-center gap-3 px-4 py-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-foreground">
                    {initials(m.nome)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{m.nome}</span>
                      {m.pendente && (
                        <span className="inline-flex items-center rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                          convite pendente
                        </span>
                      )}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">{m.email ?? "—"}</p>
                  </div>

                  {/* Papel: dono é fixo; os demais podem ser trocados */}
                  {isDono ? (
                    <span
                      className="shrink-0 rounded px-2 py-1 text-xs font-medium"
                      style={{ backgroundColor: badge.bg, color: badge.fg }}
                    >
                      {ROLE_LABEL.dono}
                    </span>
                  ) : (
                    <div className="flex shrink-0 items-center gap-2">
                      {m.role === "colaborador" && (
                        <select
                          value={m.departmentId ?? ""}
                          disabled={busy}
                          onChange={(e) => onDeptChange(m, e.target.value)}
                          className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                        >
                          {departments.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.nome}
                            </option>
                          ))}
                        </select>
                      )}
                      <select
                        value={m.role}
                        disabled={busy}
                        onChange={(e) => onRoleChange(m, e.target.value as CompanyRole)}
                        className="rounded-md border border-border bg-background px-2 py-1 text-xs font-medium"
                        style={{ color: badge.fg }}
                      >
                        <option value="administrador">{ROLE_LABEL.administrador}</option>
                        <option value="colaborador">{ROLE_LABEL.colaborador}</option>
                      </select>
                      <button
                        onClick={() => setRemoveTarget(m)}
                        disabled={busy}
                        title="Remover do espaço"
                        className="rounded-md border border-border bg-background p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" strokeWidth={1.7} />
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
            {ordered.length === 0 && (
              <li className="px-4 py-10 text-center text-sm text-muted-foreground">
                Nenhuma pessoa neste espaço ainda.
              </li>
            )}
          </ul>
        )}
      </div>

      {inviteOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !inviteMut.isPending && setInviteOpen(false)}
        >
          <div
            className="w-full max-w-[460px] rounded-lg bg-card p-6 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <h4 className="text-base font-semibold text-foreground">Convidar pessoa</h4>
              <button
                onClick={() => setInviteOpen(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-5 space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-foreground">Nome</label>
                <input
                  value={form.nome}
                  onChange={(e) => setForm({ ...form, nome: e.target.value })}
                  className={`w-full rounded-md border bg-background px-3 py-2 text-sm ${
                    errors.nome ? "border-destructive" : "border-border"
                  }`}
                />
                {errors.nome && <p className="mt-1 text-xs text-destructive">{errors.nome}</p>}
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-foreground">E-mail</label>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  className={`w-full rounded-md border bg-background px-3 py-2 text-sm ${
                    errors.email ? "border-destructive" : "border-border"
                  }`}
                />
                {errors.email && <p className="mt-1 text-xs text-destructive">{errors.email}</p>}
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-foreground">Papel</label>
                <select
                  value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value as InviteRole })}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="administrador">Admin</option>
                  <option value="colaborador">Colaborador</option>
                </select>
                <p className="mt-1 text-xs text-muted-foreground">
                  O papel de dono é definido só na criação do espaço.
                </p>
              </div>
              {form.role === "colaborador" && (
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-foreground">
                    Departamento
                  </label>
                  <select
                    value={form.departmentId}
                    onChange={(e) => setForm({ ...form, departmentId: e.target.value })}
                    className={`w-full rounded-md border bg-background px-3 py-2 text-sm ${
                      errors.departmentId ? "border-destructive" : "border-border"
                    }`}
                  >
                    <option value="">Selecione...</option>
                    {departments.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.nome}
                      </option>
                    ))}
                  </select>
                  {errors.departmentId && (
                    <p className="mt-1 text-xs text-destructive">{errors.departmentId}</p>
                  )}
                  {departments.length === 0 && (
                    <p className="mt-1 text-xs text-amber-700">
                      Este espaço ainda não tem departamentos cadastrados.
                    </p>
                  )}
                </div>
              )}
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => setInviteOpen(false)}
                disabled={inviteMut.isPending}
                className="rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted"
              >
                Cancelar
              </button>
              <button
                onClick={submitInvite}
                disabled={inviteMut.isPending}
                className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {inviteMut.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Enviar convite
              </button>
            </div>
          </div>
        </div>
      )}

      <AlertDialog open={!!removeTarget} onOpenChange={(o) => !o && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover do espaço?</AlertDialogTitle>
            <AlertDialogDescription>
              {removeTarget?.nome} deixará de fazer parte deste espaço de trabalho.
              {removeTarget?.pendente
                ? " O convite pendente será cancelado."
                : " Esta ação pode ser refeita convidando a pessoa novamente."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => removeTarget && removeMut.mutate(removeTarget)}
              style={{ backgroundColor: "#DC2626", color: "#fff" }}
              className="hover:opacity-90"
            >
              Remover
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
