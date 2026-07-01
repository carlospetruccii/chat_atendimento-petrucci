import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, UserX, UserCheck, UsersRound, Search, X, Loader2 } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import {
  ColaboradorRow,
  criarColaborador,
  fetchColaboradores,
  fetchDepartments,
  setColaboradorAtivo,
  TRIAGEM_DEPT_ID,
  updateColaborador,
} from "@/lib/configuracoes-queries";
import { useCurrentUser } from "@/hooks/useCurrentUser";

function initials(n: string) {
  return n
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("pt-BR");
}

const STATUS_STYLE: Record<ColaboradorRow["status"], { label: string; bg: string; fg: string }> = {
  ativo: { label: "Ativo", bg: "#D1FAE5", fg: "#065F46" },
  indisponivel: { label: "Indisponível", bg: "#FEF3C7", fg: "#92400E" },
  inativo: { label: "Inativo", bg: "#F3F4F6", fg: "#6B7280" },
};

type PapelForm = "administrador" | "colaborador";

interface FormState {
  nome: string;
  email: string;
  password: string;
  role: PapelForm;
  department_id: string;
  ativo: boolean;
  disponivel: boolean;
}

const PAPEL_LABEL: Record<"dono" | "administrador" | "colaborador", string> = {
  dono: "Dono",
  administrador: "Administrador",
  colaborador: "Colaborador",
};

export function ColaboradoresTab() {
  const qc = useQueryClient();
  const { user: me } = useCurrentUser();

  const colaboradoresQ = useQuery({ queryKey: ["colaboradores"], queryFn: fetchColaboradores });
  const deptsQ = useQuery({ queryKey: ["departments"], queryFn: fetchDepartments });

  const colaboradores = colaboradoresQ.data ?? [];
  const depts = (deptsQ.data ?? []).filter((d) => d.id !== TRIAGEM_DEPT_ID && d.ativo);

  const [search, setSearch] = useState("");
  const [filterDept, setFilterDept] = useState("Todos");
  const [filterStatus, setFilterStatus] = useState("Todos");

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ColaboradorRow | null>(null);
  const [form, setForm] = useState<FormState>({
    nome: "",
    email: "",
    password: "",
    role: "colaborador",
    department_id: "",
    ativo: true,
    disponivel: true,
  });
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [confirmTarget, setConfirmTarget] = useState<ColaboradorRow | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return colaboradores.filter((c) => {
      if (q && !c.nome.toLowerCase().includes(q) && !(c.email ?? "").toLowerCase().includes(q))
        return false;
      if (filterDept !== "Todos" && c.department_id !== filterDept) return false;
      if (filterStatus !== "Todos" && c.status !== filterStatus) return false;
      return true;
    });
  }, [colaboradores, search, filterDept, filterStatus]);

  function openNew() {
    setEditing(null);
    setForm({
      nome: "",
      email: "",
      password: "",
      role: "colaborador",
      department_id: depts[0]?.id ?? "",
      ativo: true,
      disponivel: true,
    });
    setErrors({});
    setModalOpen(true);
  }

  function openEdit(c: ColaboradorRow) {
    setEditing(c);
    setForm({
      nome: c.nome,
      email: c.email ?? "",
      password: "",
      role: c.role === "colaborador" ? "colaborador" : "administrador",
      department_id: c.department_id ?? "",
      ativo: c.ativo,
      disponivel: c.disponivel,
    });
    setErrors({});
    setModalOpen(true);
  }

  const createMut = useMutation({
    mutationFn: criarColaborador,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["colaboradores"] });
      qc.invalidateQueries({ queryKey: ["departments"] });
      toast.success("Colaborador criado");
      setModalOpen(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const updateMut = useMutation({
    mutationFn: (vars: { id: string; input: Parameters<typeof updateColaborador>[1] }) =>
      updateColaborador(vars.id, vars.input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["colaboradores"] });
      qc.invalidateQueries({ queryKey: ["departments"] });
      toast.success("Colaborador atualizado");
      setModalOpen(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deactivateMut = useMutation({
    mutationFn: (vars: { id: string; ativo: boolean }) => setColaboradorAtivo(vars.id, vars.ativo),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ["colaboradores"] });
      toast.success(v.ativo ? "Colaborador reativado" : "Colaborador desativado");
      setConfirmTarget(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function validate(): boolean {
    const e: Partial<Record<keyof FormState, string>> = {};
    if (!form.nome.trim()) e.nome = "Nome é obrigatório";
    if (!editing) {
      if (!form.email.trim()) e.email = "E-mail é obrigatório";
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) e.email = "E-mail inválido";
      if (!form.password || form.password.length < 8) e.password = "Mínimo 8 caracteres";
    }
    // Departamento é obrigatório só para colaborador (admin não tem departamento).
    if (form.role === "colaborador" && !form.department_id)
      e.department_id = "Departamento é obrigatório";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function save() {
    if (!validate()) return;
    const isColab = form.role === "colaborador";
    if (editing) {
      updateMut.mutate({
        id: editing.id,
        input: {
          nome: form.nome,
          department_id: isColab ? form.department_id : null,
          ativo: form.ativo,
          disponivel: form.disponivel,
        },
      });
    } else {
      createMut.mutate({
        nome: form.nome.trim(),
        email: form.email.trim(),
        password: form.password,
        role: form.role,
        department_id: isColab ? form.department_id : null,
      });
    }
  }

  function toggleAtivo(c: ColaboradorRow) {
    if (c.is_superadmin && me?.id === c.id) {
      toast.error("Superadmin não pode se desativar.");
      return;
    }
    if (c.ativo) setConfirmTarget(c);
    else deactivateMut.mutate({ id: c.id, ativo: true });
  }

  const isSelfSuper = editing?.is_superadmin && me?.id === editing?.id;
  const saving = createMut.isPending || updateMut.isPending;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-foreground">Colaboradores</h3>
            <span className="text-xs text-muted-foreground">
              {colaboradores.length} cadastrados
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Cadastre e gerencie os colaboradores que atendem clientes da Almore.
          </p>
        </div>
        <button
          onClick={openNew}
          className="flex shrink-0 items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          + Novo colaborador
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-[320px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nome ou e-mail"
            className="w-full rounded-2xl border border-border bg-card py-2 pl-9 pr-3 text-sm"
          />
        </div>
        <select
          value={filterDept}
          onChange={(e) => setFilterDept(e.target.value)}
          className="rounded-2xl border border-border bg-card px-3 py-2 text-sm"
        >
          <option value="Todos">Todos os departamentos</option>
          {depts.map((d) => (
            <option key={d.id} value={d.id}>
              {d.nome}
            </option>
          ))}
        </select>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="rounded-2xl border border-border bg-card px-3 py-2 text-sm"
        >
          <option value="Todos">Todos os status</option>
          <option value="ativo">Ativos</option>
          <option value="indisponivel">Indisponíveis</option>
          <option value="inativo">Inativos</option>
        </select>
      </div>

      {colaboradoresQ.isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-border bg-card py-16 text-center shadow-sm">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
            <UsersRound className="h-6 w-6 text-muted-foreground" strokeWidth={1.5} />
          </div>
          <h4 className="mt-4 text-base font-medium text-foreground">
            Nenhum colaborador encontrado
          </h4>
          <p className="mt-1 text-sm text-muted-foreground">Tente ajustar os filtros.</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((c) => {
            const stStyle = STATUS_STYLE[c.status];
            const isMeSuper = c.is_superadmin && me?.id === c.id;
            return (
              <div
                key={c.id}
                className={`rounded-2xl border border-border bg-card p-5 shadow-sm transition ${
                  c.ativo ? "" : "opacity-70"
                }`}
              >
                <div className="flex items-start gap-3">
                  <div
                    className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-base font-semibold text-white"
                    style={{ backgroundColor: c.department_cor }}
                  >
                    {initials(c.nome)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold text-foreground">
                      {c.nome}
                      <span className="ml-1 text-[10px] font-medium text-primary">
                        ({PAPEL_LABEL[c.role ?? "colaborador"]})
                      </span>
                    </p>
                    <p className="truncate text-xs text-muted-foreground">{c.email ?? "—"}</p>
                  </div>
                </div>

                <div className="my-4 border-t border-border" />

                <div className="flex flex-wrap items-center gap-2">
                  {c.department_id && (
                    <span
                      className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium"
                      style={{ backgroundColor: `${c.department_cor}22`, color: c.department_cor }}
                    >
                      <span
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ backgroundColor: c.department_cor }}
                      />
                      {c.department_nome}
                    </span>
                  )}
                  <span
                    className="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium"
                    style={{ backgroundColor: stStyle.bg, color: stStyle.fg }}
                  >
                    {stStyle.label}
                  </span>
                </div>

                <p className="mt-2 text-xs text-muted-foreground">
                  Cadastrado em {formatDate(c.created_at)}
                </p>

                <div className="mt-4 flex gap-2">
                  <button
                    onClick={() => openEdit(c)}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
                  >
                    <Pencil className="h-3.5 w-3.5" strokeWidth={1.7} /> Editar
                  </button>
                  {!isMeSuper && (
                    <button
                      onClick={() => toggleAtivo(c)}
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
                    >
                      {c.ativo ? (
                        <>
                          <UserX className="h-3.5 w-3.5" strokeWidth={1.7} /> Desativar
                        </>
                      ) : (
                        <>
                          <UserCheck className="h-3.5 w-3.5" strokeWidth={1.7} /> Ativar
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !saving && setModalOpen(false)}
        >
          <div
            className="w-full max-w-[480px] rounded-lg bg-card p-6 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <h4 className="text-base font-semibold text-foreground">
                {editing ? "Editar colaborador" : "Novo colaborador"}
              </h4>
              <button
                onClick={() => setModalOpen(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-5 space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-foreground">
                  Nome completo
                </label>
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
                  disabled={!!editing}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  className={`w-full rounded-md border bg-background px-3 py-2 text-sm disabled:bg-muted disabled:text-muted-foreground ${
                    errors.email ? "border-destructive" : "border-border"
                  }`}
                />
                {editing && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    E-mail vinculado ao login e não pode ser alterado.
                  </p>
                )}
                {errors.email && <p className="mt-1 text-xs text-destructive">{errors.email}</p>}
              </div>
              {!editing && (
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-foreground">
                    Senha temporária
                  </label>
                  <input
                    type="text"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    className={`w-full rounded-md border bg-background px-3 py-2 text-sm ${
                      errors.password ? "border-destructive" : "border-border"
                    }`}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    A pessoa será obrigada a trocá-la no primeiro acesso.
                  </p>
                  {errors.password && (
                    <p className="mt-1 text-xs text-destructive">{errors.password}</p>
                  )}
                </div>
              )}
              {!editing && (
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-foreground">Papel</label>
                  <select
                    value={form.role}
                    onChange={(e) => setForm({ ...form, role: e.target.value as PapelForm })}
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  >
                    <option value="colaborador">Colaborador (atendente de um departamento)</option>
                    <option value="administrador">Administrador (acesso total)</option>
                  </select>
                </div>
              )}
              {form.role === "colaborador" && (
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-foreground">
                    Departamento
                  </label>
                  <select
                    value={form.department_id}
                    onChange={(e) => setForm({ ...form, department_id: e.target.value })}
                    className={`w-full rounded-md border bg-background px-3 py-2 text-sm ${
                      errors.department_id ? "border-destructive" : "border-border"
                    }`}
                  >
                    <option value="">Selecione...</option>
                    {depts.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.nome}
                      </option>
                    ))}
                  </select>
                  {errors.department_id && (
                    <p className="mt-1 text-xs text-destructive">{errors.department_id}</p>
                  )}
                </div>
              )}

              {editing && (
                <>
                  <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                    <div>
                      <p className="text-sm font-medium text-foreground">Ativo</p>
                      <p className="text-xs text-muted-foreground">
                        Pode acessar o sistema e receber atendimentos.
                      </p>
                    </div>
                    <Switch
                      checked={form.ativo}
                      disabled={!!isSelfSuper}
                      onCheckedChange={(v) => setForm({ ...form, ativo: v })}
                    />
                  </div>
                  <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                    <div>
                      <p className="text-sm font-medium text-foreground">Disponível</p>
                      <p className="text-xs text-muted-foreground">
                        Recebe novos atendimentos quando online.
                      </p>
                    </div>
                    <Switch
                      checked={form.disponivel}
                      disabled={!!isSelfSuper}
                      onCheckedChange={(v) => setForm({ ...form, disponivel: v })}
                    />
                  </div>
                  {isSelfSuper && (
                    <p className="text-xs text-muted-foreground">
                      Superadmin não pode se desativar.
                    </p>
                  )}
                </>
              )}
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => setModalOpen(false)}
                disabled={saving}
                className="rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted"
              >
                Cancelar
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Salvar
              </button>
            </div>
          </div>
        </div>
      )}

      <AlertDialog open={!!confirmTarget} onOpenChange={(open) => !open && setConfirmTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Desativar colaborador?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmTarget?.nome} não poderá mais acessar o sistema. Os atendimentos atribuídos a
              ele serão liberados automaticamente para pendentes do departamento. Esta ação pode ser
              revertida.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                confirmTarget && deactivateMut.mutate({ id: confirmTarget.id, ativo: false })
              }
              style={{ backgroundColor: "#DC2626", color: "#fff" }}
              className="hover:opacity-90"
            >
              Desativar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
