import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
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
  createRouting,
  deleteRouting,
  fetchRoutings,
  fetchSubjectsAtivos,
  fetchUsersAtivos,
  RoutingRow,
  updateRouting,
} from "@/lib/configuracoes-queries";

function DeptBadge({ nome, cor }: { nome: string; cor: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium"
      style={{ backgroundColor: `${cor}22`, color: cor }}
    >
      <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: cor }} />
      {nome}
    </span>
  );
}

export function RoteamentoTab() {
  const qc = useQueryClient();
  const routingsQ = useQuery({ queryKey: ["routings"], queryFn: fetchRoutings });
  const subjectsQ = useQuery({ queryKey: ["subjects-ativos"], queryFn: fetchSubjectsAtivos });
  const usersQ = useQuery({ queryKey: ["users-ativos"], queryFn: fetchUsersAtivos });

  const routings = routingsQ.data ?? [];
  const subjects = subjectsQ.data ?? [];
  const users = usersQ.data ?? [];

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<RoutingRow | null>(null);
  const [form, setForm] = useState({ subject_id: "", user_id: "" });
  const [error, setError] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<RoutingRow | null>(null);

  function openNew() {
    setEditing(null);
    setForm({ subject_id: "", user_id: "" });
    setError(null);
    setOpen(true);
  }
  function openEdit(r: RoutingRow) {
    setEditing(r);
    setForm({ subject_id: r.subject_id, user_id: r.user_id });
    setError(null);
    setOpen(true);
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!form.subject_id || !form.user_id) throw new Error("Preencha assunto e colaborador.");
      if (editing) await updateRouting(editing.id, { user_id: form.user_id });
      else await createRouting(form);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["routings"] });
      toast.success("Roteamento salvo");
      setOpen(false);
    },
    onError: (e: Error) => setError(e.message),
  });

  const toggleMut = useMutation({
    mutationFn: ({ id, ativo }: { id: string; ativo: boolean }) =>
      updateRouting(id, { ativo }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["routings"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteRouting(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["routings"] });
      toast.success("Roteamento removido");
      setConfirmTarget(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <>
      <div className="mb-4 flex justify-end">
        <button
          onClick={openNew}
          className="flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" strokeWidth={1.8} /> Novo roteamento
        </button>
      </div>

      {routingsQ.isLoading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-muted">
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium">Assunto</th>
                <th className="px-4 py-3 font-medium">Colaborador</th>
                <th className="px-4 py-3 font-medium">Ativo</th>
                <th className="px-4 py-3 font-medium text-right">Ações</th>
              </tr>
            </thead>
            <tbody>
              {routings.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1">
                      <span className="text-foreground">{r.subject_nome}</span>
                      <DeptBadge nome={r.subject_dept_nome} cor={r.subject_dept_cor} />
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1">
                      <span className="text-foreground">{r.user_nome}</span>
                      <DeptBadge nome={r.user_dept_nome} cor={r.user_dept_cor} />
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Switch
                      checked={r.ativo}
                      onCheckedChange={(v) => toggleMut.mutate({ id: r.id, ativo: v })}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => openEdit(r)}
                        className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <Pencil className="h-4 w-4" strokeWidth={1.5} />
                      </button>
                      <button
                        onClick={() => setConfirmTarget(r)}
                        className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" strokeWidth={1.5} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {routings.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    Nenhum roteamento configurado.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !saveMut.isPending && setOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-lg bg-card p-6 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <h4 className="text-base font-semibold text-foreground">
                {editing ? "Editar roteamento" : "Novo roteamento"}
              </h4>
              <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-5 space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-foreground">Assunto</label>
                <select
                  value={form.subject_id}
                  onChange={(e) => setForm({ ...form, subject_id: e.target.value })}
                  disabled={!!editing}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm disabled:opacity-60"
                >
                  <option value="">Selecione...</option>
                  {subjects.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.nome} — {s.department_nome}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-foreground">
                  Colaborador
                </label>
                <select
                  value={form.user_id}
                  onChange={(e) => setForm({ ...form, user_id: e.target.value })}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="">Selecione...</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.nome} — {u.department_nome}
                    </option>
                  ))}
                </select>
              </div>
              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => setOpen(false)}
                className="rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted"
              >
                Cancelar
              </button>
              <button
                onClick={() => saveMut.mutate()}
                disabled={saveMut.isPending}
                className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {saveMut.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Salvar
              </button>
            </div>
          </div>
        </div>
      )}

      <AlertDialog open={!!confirmTarget} onOpenChange={(o) => !o && setConfirmTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover roteamento?</AlertDialogTitle>
            <AlertDialogDescription>
              O vínculo entre <strong>{confirmTarget?.subject_nome}</strong> e{" "}
              <strong>{confirmTarget?.user_nome}</strong> será removido. Atendimentos em andamento
              não são afetados.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmTarget && deleteMut.mutate(confirmTarget.id)}
              style={{ backgroundColor: "#DC2626", color: "#fff" }}
              className="hover:opacity-90"
            >
              Remover
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
