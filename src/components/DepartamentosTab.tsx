import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2, X, Loader2, Lock } from "lucide-react";
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
  checkDepartmentDeletable,
  createDepartment,
  deleteDepartment,
  DepartmentRow,
  fetchDepartments,
  TRIAGEM_DEPT_ID,
  updateDepartment,
} from "@/lib/configuracoes-queries";

function TableShell({ children, columns }: { children: React.ReactNode; columns: string[] }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <table className="w-full text-sm">
        <thead className="bg-muted">
          <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
            {columns.map((c) => (
              <th key={c} className="px-4 py-3 font-medium">
                {c}
              </th>
            ))}
            <th className="px-4 py-3 font-medium text-right">Ações</th>
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function DepartamentosTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["departments"], queryFn: fetchDepartments });
  const list = q.data ?? [];

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<DepartmentRow | null>(null);
  const [form, setForm] = useState({ nome: "", cor: "#3b82f6" });
  const [error, setError] = useState<string | null>(null);

  const [confirmTarget, setConfirmTarget] = useState<DepartmentRow | null>(null);
  const [deleteBlocked, setDeleteBlocked] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  function openNew() {
    setEditing(null);
    setForm({ nome: "", cor: "#3b82f6" });
    setError(null);
    setModalOpen(true);
  }
  function openEdit(d: DepartmentRow) {
    setEditing(d);
    setForm({ nome: d.nome, cor: d.cor });
    setError(null);
    setModalOpen(true);
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!form.nome.trim()) throw new Error("Nome é obrigatório");
      if (editing) await updateDepartment(editing.id, form);
      else await createDepartment(form);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["departments"] });
      toast.success("Departamento salvo");
      setModalOpen(false);
    },
    onError: (e: Error) => setError(e.message),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteDepartment(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["departments"] });
      toast.success("Departamento excluído");
      setConfirmTarget(null);
    },
    onError: (e: Error) => {
      setDeleteBlocked(e.message);
      setConfirmTarget(null);
    },
  });

  async function handleDeleteClick(d: DepartmentRow) {
    if (d.id === TRIAGEM_DEPT_ID) return;
    setChecking(true);
    try {
      const r = await checkDepartmentDeletable(d.id);
      if (!r.ok) setDeleteBlocked(r.reason ?? "Não é possível excluir.");
      else setConfirmTarget(d);
    } finally {
      setChecking(false);
    }
  }

  return (
    <>
      <div className="mb-4 flex justify-end">
        <button
          onClick={openNew}
          className="flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" strokeWidth={1.8} /> Novo departamento
        </button>
      </div>

      {q.isLoading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <TableShell columns={["Nome", "Cor", "Colaboradores"]}>
          {list.map((d) => {
            const isSystem = d.id === TRIAGEM_DEPT_ID;
            return (
              <tr key={d.id} className="border-t border-border">
                <td className="px-4 py-3 text-foreground">
                  {d.nome}
                  {isSystem && (
                    <span className="ml-2 inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      <Lock className="h-2.5 w-2.5" /> Sistema
                    </span>
                  )}
                  {!d.ativo && !isSystem && (
                    <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      inativo
                    </span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span
                    className="inline-block h-4 w-4 rounded"
                    style={{ backgroundColor: d.cor }}
                  />
                </td>
                <td className="px-4 py-3 text-muted-foreground">{d.colaboradores}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-2">
                    <button
                      onClick={() => openEdit(d)}
                      disabled={isSystem}
                      title={isSystem ? "Departamento de sistema" : "Editar"}
                      className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
                    >
                      <Pencil className="h-4 w-4" strokeWidth={1.5} />
                    </button>
                    <button
                      onClick={() => handleDeleteClick(d)}
                      disabled={isSystem || checking}
                      title={isSystem ? "Departamento de sistema" : "Excluir"}
                      className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive disabled:opacity-40 disabled:hover:bg-transparent"
                    >
                      <Trash2 className="h-4 w-4" strokeWidth={1.5} />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
          {list.length === 0 && (
            <tr>
              <td colSpan={4} className="px-4 py-10 text-center text-sm text-muted-foreground">
                Nenhum departamento cadastrado.
              </td>
            </tr>
          )}
        </TableShell>
      )}

      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !saveMut.isPending && setModalOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-lg bg-card p-6 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <h4 className="text-base font-semibold text-foreground">
                {editing ? "Editar departamento" : "Novo departamento"}
              </h4>
              <button onClick={() => setModalOpen(false)} className="text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-5 space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-foreground">Nome</label>
                <input
                  value={form.nome}
                  onChange={(e) => setForm({ ...form, nome: e.target.value })}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-foreground">Cor</label>
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    value={form.cor}
                    onChange={(e) => setForm({ ...form, cor: e.target.value })}
                    className="h-10 w-16 cursor-pointer rounded border border-border bg-background"
                  />
                  <span className="text-sm text-muted-foreground">{form.cor}</span>
                </div>
              </div>
              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => setModalOpen(false)}
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

      <AlertDialog
        open={!!confirmTarget}
        onOpenChange={(o) => !o && setConfirmTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir departamento?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmTarget?.nome} será removido permanentemente. Esta ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmTarget && deleteMut.mutate(confirmTarget.id)}
              style={{ backgroundColor: "#DC2626", color: "#fff" }}
              className="hover:opacity-90"
            >
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deleteBlocked} onOpenChange={(o) => !o && setDeleteBlocked(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Não é possível excluir</AlertDialogTitle>
            <AlertDialogDescription>{deleteBlocked}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setDeleteBlocked(null)}>Entendi</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
