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
import { Checkbox } from "@/components/ui/checkbox";
import {
  alterarPapelColaborador,
  ColaboradorRow,
  criarColaborador,
  definirDepartamentosColaborador,
  fetchColaboradores,
  fetchDepartments,
  setColaboradorAtivo,
  TRIAGEM_DEPT_ID,
  updateColaborador,
} from "@/lib/configuracoes-queries";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { filtrarColaboradores } from "@/lib/colaboradores-filter";
import { normalizarE164, formatarNumero } from "@/lib/phone";
import { mesmosDepartamentos } from "@/lib/departamentos-usuario";

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
  /** Ordem de marcação; o 1º é o principal. */
  department_ids: string[];
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
  const todosDepts = (deptsQ.data ?? []).filter((d) => d.id !== TRIAGEM_DEPT_ID);
  const depts = todosDepts.filter((d) => d.ativo);

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
    department_ids: [],
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
      department_ids: depts[0] ? [depts[0].id] : [],
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
      department_ids: c.department_ids,
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
      roleChange?: { role: "administrador" | "colaborador"; department_ids: string[] };
      departmentIds?: string[];
    }) => {
      // A troca de papel muda o acesso (is_superadmin) + o papel canônico, então
      // vai pela Edge Function antes de salvar os demais campos do perfil. Ela
      // já grava os setores; sem troca de papel, os setores vão pela RPC.
      if (vars.roleChange) {
        await alterarPapelColaborador({ user_id: vars.id, ...vars.roleChange });
      } else if (vars.departmentIds) {
        await definirDepartamentosColaborador(vars.id, vars.departmentIds);
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
    if (form.role === "colaborador" && form.department_ids.length === 0)
      e.department_ids = "Escolha pelo menos um departamento";
    // WhatsApp é opcional; se preenchido, precisa ser um número válido.
    if (form.whatsapp.trim() && !normalizarE164(form.whatsapp))
      e.whatsapp = "Número inválido. Use DDD + número (ex.: 11 91234-5678).";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function save() {
    if (!validate()) return;
    const whatsapp = form.whatsapp.trim() ? normalizarE164(form.whatsapp) : null;
    const department_ids = form.department_ids;
    if (editing) {
      const currentRole: PapelForm =
        editing.role === "colaborador" ? "colaborador" : "administrador";
      const roleChanged = canEditRole && form.role !== currentRole;
      const deptsChanged = !mesmosDepartamentos(department_ids, editing.department_ids);
      // Setores de administrador só o dono muda, junto com o papel (mesma
      // Edge Function). Setores de colaborador vão direto pela RPC.
      const deptChangedForAdmin = canEditRole && form.role === "administrador" && deptsChanged;
      const roleChange =
        roleChanged || deptChangedForAdmin ? { role: form.role, department_ids } : undefined;
      const departmentIds =
        !roleChange && deptsChanged && form.role === "colaborador" ? department_ids : undefined;
      updateMut.mutate({
        id: editing.id,
        input: {
          nome: form.nome,
          ativo: form.ativo,
          disponivel: form.disponivel,
          whatsapp,
        },
        roleChange,
        departmentIds,
      });
    } else {
      createMut.mutate({
        nome: form.nome.trim(),
        email: form.email.trim(),
        password: form.password,
        role: form.role,
        department_ids,
        whatsapp,
      });
    }
  }

  // Marcar põe no fim da lista; o 1º marcado continua sendo o principal.
  function toggleDept(id: string, marcado: boolean) {
    setForm((f) => ({
      ...f,
      department_ids: marcado
        ? [...f.department_ids.filter((d) => d !== id), id]
        : f.department_ids.filter((d) => d !== id),
    }));
  }

  function toggleAtivo(c: ColaboradorRow) {
    // O banco também barra (ninguém muda o próprio ativo); aqui só evita o erro.
    if (me?.id === c.id) {
      toast.error("Você não pode desativar o próprio acesso.");
      return;
    }
    if (c.ativo) setConfirmTarget(c);
    else deactivateMut.mutate({ id: c.id, ativo: true });
  }

  // Própria ficha: o Switch "Ativo" fica travado (o banco barra mudar o próprio ativo).
  const isSelf = !!editing && me?.id === editing.id;
  const isSelfSuper = editing?.is_superadmin && isSelf;
  // Toggle de papel na edição: só o dono, nunca no próprio cadastro nem em outro dono.
  const canEditRole = !!editing && isOwnerMe && editing.role !== "dono" && editing.id !== me?.id;
  const saving = createMut.isPending || updateMut.isPending;
  const deptsBloqueados = !!editing && form.role === "administrador" && !canEditRole;
  // Setores ativos + algum inativo que a pessoa ainda tenha (para não sumir).
  const deptsDoForm = todosDepts.filter((d) => d.ativo || form.department_ids.includes(d.id));

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
            Cadastre e gerencie os colaboradores que atendem clientes da Parabrisas Petrucci.
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
            const isMe = me?.id === c.id;
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
                  {c.departamentos.map((d) => (
                    <span
                      key={d.id}
                      className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium"
                      style={{ backgroundColor: `${d.cor}22`, color: d.cor }}
                    >
                      <span
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ backgroundColor: d.cor }}
                      />
                      {d.nome}
                    </span>
                  ))}
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
                  {!isMe && (
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
                  <option value="colaborador">Colaborador (atendente de departamentos)</option>
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
              <p className="mb-1.5 block text-xs font-medium text-foreground">
                Departamentos{form.role === "administrador" && " (opcional)"}
              </p>
              <div
                className={`max-h-48 space-y-1 overflow-y-auto rounded-md border bg-background p-2 ${
                  errors.department_ids ? "border-destructive" : "border-border"
                }`}
              >
                {deptsDoForm.map((d) => {
                  const marcado = form.department_ids.includes(d.id);
                  const principal = form.department_ids[0] === d.id;
                  return (
                    <label
                      key={d.id}
                      className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
                    >
                      <Checkbox
                        checked={marcado}
                        disabled={deptsBloqueados}
                        onCheckedChange={(v) => toggleDept(d.id, v === true)}
                      />
                      <span
                        className="inline-block h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: d.cor }}
                      />
                      <span className="flex-1 truncate">
                        {d.nome}
                        {!d.ativo && " (inativo)"}
                      </span>
                      {principal && form.department_ids.length > 1 && (
                        <span className="text-[10px] font-medium text-muted-foreground">
                          principal
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
              {errors.department_ids && (
                <p className="mt-1 text-xs text-destructive">{errors.department_ids}</p>
              )}
              <p className="mt-1 text-xs text-muted-foreground">
                {form.role === "administrador"
                  ? "Administrador continua vendo tudo. Marcar departamentos só faz esta pessoa passar a receber os avisos de novo pendente desses setores."
                  : "A pessoa vê e atende as conversas de todos os departamentos marcados."}
                {form.department_ids.length > 1 &&
                  " O principal (o primeiro marcado) é usado quando a conversa não tem um setor da pessoa."}
                {deptsBloqueados && " Só o dono pode alterar."}
              </p>
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
                    disabled={isSelf}
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
                {isSelf && (
                  <p className="text-xs text-muted-foreground">
                    Você não pode desativar o próprio acesso.
                  </p>
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
