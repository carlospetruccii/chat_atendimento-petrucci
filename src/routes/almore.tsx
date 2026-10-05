import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Loader2, TriangleAlert, Users } from "lucide-react";
import { toast } from "sonner";
import { createWorkspace, fetchWorkspaces, WorkspaceRow } from "@/lib/workspaces-queries";

export const Route = createFileRoute("/almore")({
  staticData: { title: "Almore — Espaços" },
  component: AlmorePage,
});

interface FormState {
  nome: string;
  ownerNome: string;
  ownerEmail: string;
}

const EMPTY: FormState = { nome: "", ownerNome: "", ownerEmail: "" };

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("pt-BR");
}

function AlmorePage() {
  const qc = useQueryClient();
  const workspacesQ = useQuery({ queryKey: ["workspaces"], queryFn: fetchWorkspaces });
  const [form, setForm] = useState<FormState>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});

  const createMut = useMutation({
    mutationFn: createWorkspace,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["workspaces"] });
      toast.success("Espaço criado");
      setForm(EMPTY);
      setErrors({});
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function validate(): boolean {
    const e: Partial<Record<keyof FormState, string>> = {};
    if (!form.nome.trim()) e.nome = "Nome da empresa é obrigatório";
    if (!form.ownerNome.trim()) e.ownerNome = "Nome do dono é obrigatório";
    if (!form.ownerEmail.trim()) e.ownerEmail = "E-mail do dono é obrigatório";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.ownerEmail.trim()))
      e.ownerEmail = "E-mail inválido";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function submit() {
    if (!validate()) return;
    createMut.mutate({
      nome: form.nome,
      ownerNome: form.ownerNome,
      ownerEmail: form.ownerEmail,
    });
  }

  const workspaces = workspacesQ.data ?? [];

  return (
    // min-h-dvh, nunca min-h-screen (100vh): no celular o 100vh conta a barra de
    // endereço do navegador como se estivesse sempre visível.
    <div className="min-h-dvh bg-background px-4 py-10">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-900">
          <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0" strokeWidth={1.8} />
          <div className="text-sm">
            <p className="font-semibold">Ferramenta interna e temporária da Almore</p>
            <p className="mt-0.5">
              Este cantinho é só para a Almore criar os primeiros espaços de trabalho enquanto a
              tela de administração geral não existe. Ele fica fora do menu do sistema e não deve
              ser usado por clientes. Criar um espaço de trabalho é um ato exclusivo da Almore.
            </p>
          </div>
        </div>

        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-foreground">
            <Building2 className="h-5 w-5 text-primary" strokeWidth={1.8} />
            Espaços de trabalho
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Crie um espaço para uma empresa cliente e defina quem é o dono dele.
          </p>
        </div>

        <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
          <h2 className="text-base font-semibold text-foreground">Criar novo espaço</h2>
          {/* grid-cols-1 explícito: sem isso o "1 coluna no celular" funcionava por
              acidente (grid sem grid-template-columns cai em 1 coluna implícita) —
              deixar explícito documenta a intenção mobile-first. */}
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="mb-1.5 block text-xs font-medium text-foreground">
                Nome da empresa
              </label>
              <input
                value={form.nome}
                onChange={(e) => setForm({ ...form, nome: e.target.value })}
                placeholder="Ex: Loja do João"
                className={`w-full rounded-md border bg-background px-3 py-2 text-sm ${
                  errors.nome ? "border-destructive" : "border-border"
                }`}
              />
              {errors.nome && <p className="mt-1 text-xs text-destructive">{errors.nome}</p>}
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-foreground">
                Nome do dono
              </label>
              <input
                value={form.ownerNome}
                onChange={(e) => setForm({ ...form, ownerNome: e.target.value })}
                placeholder="Ex: João Silva"
                className={`w-full rounded-md border bg-background px-3 py-2 text-sm ${
                  errors.ownerNome ? "border-destructive" : "border-border"
                }`}
              />
              {errors.ownerNome && (
                <p className="mt-1 text-xs text-destructive">{errors.ownerNome}</p>
              )}
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-foreground">
                E-mail do dono
              </label>
              <input
                type="email"
                value={form.ownerEmail}
                onChange={(e) => setForm({ ...form, ownerEmail: e.target.value })}
                placeholder="dono@empresa.com"
                className={`w-full rounded-md border bg-background px-3 py-2 text-sm ${
                  errors.ownerEmail ? "border-destructive" : "border-border"
                }`}
              />
              {errors.ownerEmail && (
                <p className="mt-1 text-xs text-destructive">{errors.ownerEmail}</p>
              )}
            </div>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Como o login ainda não existe, o dono fica registrado como dono do espaço, mas só vai
            conseguir entrar quando o login for ligado.
          </p>
          <div className="mt-4 flex justify-end">
            <button
              onClick={submit}
              disabled={createMut.isPending}
              className="touch-target-mobile flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {createMut.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Criar espaço
            </button>
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
          <h2 className="text-base font-semibold text-foreground">
            Espaços já criados
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {workspaces.length}
            </span>
          </h2>

          {workspacesQ.isLoading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : workspaces.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nenhum espaço criado ainda.
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-border rounded-xl border border-border">
              {workspaces.map((w: WorkspaceRow) => (
                <li key={w.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-foreground">{w.nome}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      Dono: {w.ownerNome ?? "—"}
                      {w.ownerEmail ? ` · ${w.ownerEmail}` : ""}
                      {w.ownerPendente && (
                        <span className="ml-1.5 inline-flex items-center rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                          convite pendente
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      Criado em {formatDate(w.created_at)}
                    </p>
                  </div>
                  <a
                    href={`/almore-membros/${w.id}`}
                    className="touch-target-mobile flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
                  >
                    <Users className="h-3.5 w-3.5" strokeWidth={1.7} /> Gerenciar membros
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
