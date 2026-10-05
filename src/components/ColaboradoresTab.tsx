import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, UserX, UserCheck, UsersRound, Search, Loader2, Phone } from "lucide-react";
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
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import {
  alterarPapelColaborador,
  ColaboradorRow,
  criarColaborador,
  fetchColaboradores,
  fetchDepartments,
  setColaboradorAtivo,
  TRIAGEM_DEPT_ID,
  updateColaborador,
} from "@/lib/configuracoes-queries";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { filtrarColaboradores } from "@/lib/colaboradores-filter";
import { normalizarE164, formatarNumero } from "@/lib/phone";

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
type FiltroStatus = "Todos" | "ativo" | "indisponivel";

interface FormState {
  nome: string;
  email: string;
  password: string;
  role: PapelForm;
  department_id: string;
  whatsapp: string;
  ativo: boolean;
  disponivel: boolean;
}

const PAPEL_LABEL: Record<"dono" | "administrador" | "colaborador", string> = {
  dono: "Dono",
  administrador: "Administrador",
  colaborador: "Colaborador",
};

const EMPTY_COLABORADORES: ColaboradorRow[] = [];

function isFiltroStatus(value: string): value is FiltroStatus {
  return value === "Todos" || value === "ativo" || value === "indisponivel";
}

export function ColaboradoresTab() {
  const qc = useQueryClient();
  const { user: me } = useCurrentUser();

  const colaboradoresQ = useQuery({ queryKey: ["colaboradores"], queryFn: fetchColaboradores });
  const deptsQ = useQuery({ queryKey: ["departments"], queryFn: fetchDepartments });

  const colaboradores = colaboradoresQ.data ?? EMPTY_COLABORADORES;
  const depts = (deptsQ.data ?? []).filter((d) => d.id !== TRIAGEM_DEPT_ID && d.ativo);

  // Só o dono pode promover/rebaixar (bate com a RLS de company_members).
  const meRole = useMemo(
    () => colaboradores.find((c) => c.id === me?.id)?.role ?? null,
    [colaboradores, me?.id],
  );
  const isOwnerMe = meRole === "dono";

  const [search, setSearch] = useState("");
  const [filterDept, setFilterDept] = useState("Todos");
  const [filterStatus, setFilterStatus] = useState<FiltroStatus>("Todos");
  const [mostrarInativos, setMostrarInativos] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ColaboradorRow | null>(null);
  const [form, setForm] = useState<FormState>({
    nome: "",
    email: "",
    password: "",
    role: "colaborador",
    department_id: "",
    whatsapp: "",
    ativo: true,
    disponivel: true,
  });
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [confirmTarget, setConfirmTarget] = useState<ColaboradorRow | null>(null);

  const filtered = useMemo(
    () =>
      filtrarColaboradores(colaboradores, {
        busca: search,
        departamentoId: filterDept,
        status: filterStatus,
        mostrarInativos,
      }),
    [colaboradores, search, filterDept, filterStatus, mostrarInativos],
  );

  function openNew() {
    setEditing(null);
    setForm({
      nome: "",
      email: "",
      password: "",
      role: "colaborador",
      department_id: depts[0]?.id ?? "",
      whatsapp: "",
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
      whatsapp: c.whatsapp ?? "",
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
    mutationFn: async (vars: {
      id: string;
      input: Parameters<typeof updateColaborador>[1];
      roleChange?: { role: "administrador" | "colaborador"; department_id: string | null };
    }) => {
      // A troca de papel muda o acesso (is_superadmin) + o papel canônico, então
      // vai pela Edge Function antes de salvar os demais campos do perfil.
      if (vars.roleChange) {
        await alterarPapelColaborador({ user_id: vars.id, ...vars.roleChange });
      }
      await updateColaborador(vars.id, vars.input);
    },
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
    // Departamento é obrigatório só para colaborador (admin pode ter, mas é opcional).
    if (form.role === "colaborador" && !form.department_id)
      e.department_id = "Departamento é obrigatório";
    // WhatsApp é opcional; se preenchido, precisa ser um número válido.
    if (form.whatsapp.trim() && !normalizarE164(form.whatsapp))
      e.whatsapp = "Número inválido. Use DDD + número (ex.: 11 91234-5678).";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function save() {
    if (!validate()) return;
    const whatsapp = form.whatsapp.trim() ? normalizarE164(form.whatsapp) : null;
    const department_id = form.department_id || null;
    if (editing) {
      const currentRole: PapelForm =
        editing.role === "colaborador" ? "colaborador" : "administrador";
      const roleChanged = canEditRole && form.role !== currentRole;
      // O departamento de um administrador só é espelhado em company_members
      // pela RPC de troca de papel (dual-write atômico). Se só o departamento
      // mudou — sem trocar o papel — força a mesma chamada mesmo assim, senão
      // users.department_id e company_members.department_id ficam divergentes.
      const deptChangedForAdmin =
        canEditRole &&
        form.role === "administrador" &&
        department_id !== (editing.department_id ?? null);
      const roleChange =
        roleChanged || deptChangedForAdmin ? { role: form.role, department_id } : undefined;
      updateMut.mutate({
        id: editing.id,
        input: {
          nome: form.nome,
          department_id,
          ativo: form.ativo,
          disponivel: form.disponivel,
          whatsapp,
        },
        roleChange,
      });
    } else {
      createMut.mutate({
        nome: form.nome.trim(),
        email: form.email.trim(),
        password: form.password,
        role: form.role,
        department_id,
        whatsapp,
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
  // Toggle de papel na edição: só o dono, nunca no próprio cadastro nem em outro dono.
  const canEditRole = !!editing && isOwnerMe && editing.role !== "dono" && editing.id !== me?.id;
  const saving = createMut.isPending || updateMut.isPending;

  return (
    <div className="space-y-5">
      {/* Celular: título e botão empilham (o botão "+ Novo colaborador" ao
          lado do parágrafo descritivo sobrava pouco espaço pro texto em
          360px). Do sm: pra cima volta ao layout lado a lado original. */}
      <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
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
          className="flex w-full shrink-0 items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 sm:w-auto"
        >
          + Novo colaborador
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:max-w-[320px]">
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
          className="w-full rounded-2xl border border-border bg-card px-3 py-2 text-sm sm:w-auto"
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
          onChange={(e) => {
            const status = e.target.value;
            if (isFiltroStatus(status)) setFilterStatus(status);
          }}
          className="w-full rounded-2xl border border-border bg-card px-3 py-2 text-sm sm:w-auto"
        >
          <option value="Todos">Todos os status</option>
          <option value="ativo">Ativos</option>
          <option value="indisponivel">Indisponíveis</option>
        </select>
        <button
          type="button"
          onClick={() => setMostrarInativos((mostrar) => !mostrar)}
          aria-pressed={mostrarInativos}
          className={`w-full rounded-2xl border px-3 py-2 text-sm font-medium sm:w-auto ${
            mostrarInativos
              ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90"
              : "border-border bg-card text-foreground hover:bg-muted"
          }`}
        >
          Inativos
        </button>
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
                    {c.whatsapp && (
                      <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                        <Phone className="h-3 w-3 shrink-0" strokeWidth={1.7} />
                        {formatarNumero(c.whatsapp)}
                      </p>
                    )}
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

      {/* Era um overlay/painel montado à mão (fixed + max-w fixo, sem max-h
          nem rolagem própria) — um formulário deste tamanho em tela baixa
          (celular deitado, teclado aberto) ficava sem como chegar no botão
          Salvar. Migrado para o Dialog da fundação, que já resolve isso
          (w-[calc(100%-2rem)], max-h-[calc(100dvh-2rem)], overflow-y-auto,
          padding p-4 sm:p-6) — não repetimos essas classes aqui.
          onOpenChange só fecha fora de um salvamento em andamento: antes o
          botão "×" fechava mesmo salvando (só o backdrop e o Cancelar eram
          bloqueados); aqui os três caminhos de fechar passam pelo mesmo
          guard, o que é estritamente mais seguro. */}
      <Dialog open={modalOpen} onOpenChange={(open) => !open && !saving && setModalOpen(false)}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>{editing ? "Editar colaborador" : "Novo colaborador"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
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
            <div>
              <label className="mb-1.5 block text-xs font-medium text-foreground">
                WhatsApp pessoal
              </label>
              <input
                type="tel"
                value={form.whatsapp}
                onChange={(e) => setForm({ ...form, whatsapp: e.target.value })}
                placeholder="(11) 91234-5678"
                className={`w-full rounded-md border bg-background px-3 py-2 text-sm ${
                  errors.whatsapp ? "border-destructive" : "border-border"
                }`}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Recebe um aviso no WhatsApp quando um atendimento for repassado a esta pessoa.
                Opcional.
              </p>
              {errors.whatsapp && (
                <p className="mt-1 text-xs text-destructive">{errors.whatsapp}</p>
              )}
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
            {(!editing || canEditRole) && (
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
                {editing && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Alterar o papel muda o acesso da pessoa ao sistema.
                  </p>
                )}
              </div>
            )}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-foreground">
                Departamento{form.role === "administrador" && " (opcional)"}
              </label>
              <select
                value={form.department_id}
                onChange={(e) => setForm({ ...form, department_id: e.target.value })}
                disabled={!!editing && form.role === "administrador" && !canEditRole}
                className={`w-full rounded-md border bg-background px-3 py-2 text-sm ${
                  errors.department_id ? "border-destructive" : "border-border"
                }`}
              >
                <option value="">
                  {form.role === "administrador" ? "Nenhum" : "Selecione..."}
                </option>
                {depts.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.nome}
                  </option>
                ))}
              </select>
              {errors.department_id && (
                <p className="mt-1 text-xs text-destructive">{errors.department_id}</p>
              )}
              {form.role === "administrador" && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Administrador continua vendo tudo. Atribuir um departamento só faz esta pessoa
                  passar a receber os avisos de novo pendente daquele setor.
                  {!!editing && !canEditRole && " Só o dono pode alterar."}
                </p>
              )}
            </div>

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
                  <p className="text-xs text-muted-foreground">Superadmin não pode se desativar.</p>
                )}
              </>
            )}
          </div>

          <DialogFooter>
            <button
              onClick={() => setModalOpen(false)}
              disabled={saving}
              className="w-full justify-center rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted sm:w-auto"
            >
              Cancelar
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 sm:w-auto"
            >
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Salvar
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
