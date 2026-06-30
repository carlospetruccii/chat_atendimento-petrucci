import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Loader2, X, Search, AlertTriangle, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  searchClientesAutocomplete,
  cadastrarClienteSingle,
  formatTelefoneBR,
  type ClienteAutocompleteRow,
} from "@/lib/clientes-queries";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  canChooseDept: boolean;
  onCreated: (atendimentoId: string) => void;
}

interface Conflito {
  atendimento_id: string;
  assigned_to_nome: string;
  department_nome: string;
}

interface DeptRow { id: string; nome: string }
interface UserRow { id: string; nome: string; department_id: string | null }

export function IniciarAtendimentoDialog({
  open,
  onOpenChange,
  canChooseDept,
  onCreated,
}: Props) {
  const navigate = useNavigate();
  const [busca, setBusca] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selecionado, setSelecionado] = useState<ClienteAutocompleteRow | null>(null);
  const [departmentId, setDepartmentId] = useState<string>("");
  const [assignedTo, setAssignedTo] = useState<string>("");
  const [conflito, setConflito] = useState<Conflito | null>(null);
  const [iniciando, setIniciando] = useState(false);

  // Subform "novo cliente"
  const [showNovo, setShowNovo] = useState(false);
  const [novoNome, setNovoNome] = useState("");
  const [novoTel, setNovoTel] = useState("");
  const [salvandoNovo, setSalvandoNovo] = useState(false);

  // Reset ao abrir
  useEffect(() => {
    if (open) {
      setBusca("");
      setDebounced("");
      setSelecionado(null);
      setDepartmentId("");
      setAssignedTo("");
      setConflito(null);
      setShowNovo(false);
      setNovoNome("");
      setNovoTel("");
    }
  }, [open]);

  // Debounce busca
  useEffect(() => {
    const t = setTimeout(() => setDebounced(busca), 200);
    return () => clearTimeout(t);
  }, [busca]);

  const sugestoesQ = useQuery({
    queryKey: ["clientes-autocomplete", debounced],
    queryFn: () => searchClientesAutocomplete(debounced, 10),
    enabled: open && !selecionado && debounced.trim().length >= 2,
  });

  // Departamentos (canChooseDept)
  const deptsQ = useQuery({
    queryKey: ["iniciar-atend", "departments"],
    queryFn: async (): Promise<DeptRow[]> => {
      const { data, error } = await supabase
        .from("departments")
        .select("id, nome")
        .eq("ativo", true)
        .order("nome");
      if (error) throw error;
      return data ?? [];
    },
    enabled: open && canChooseDept,
  });

  // Atendentes do depto escolhido
  const usersQ = useQuery({
    queryKey: ["iniciar-atend", "users", departmentId],
    queryFn: async (): Promise<UserRow[]> => {
      const { data, error } = await supabase
        .from("users")
        .select("id, nome, department_id, ativo, disponivel, is_system_user")
        .eq("department_id", departmentId)
        .eq("ativo", true)
        .eq("disponivel", true)
        .eq("is_system_user", false)
        .order("nome");
      if (error) throw error;
      return (data ?? []) as UserRow[];
    },
    enabled: open && canChooseDept && !!departmentId,
  });

  // Quando troca depto, limpa assigned_to
  useEffect(() => {
    setAssignedTo("");
  }, [departmentId]);

  const sugestoes = sugestoesQ.data ?? [];
  const semResultado = !selecionado && debounced.trim().length >= 2 && !sugestoesQ.isLoading && sugestoes.length === 0;

  // Heurística: input só dígitos => provavelmente telefone
  const buscaSoDigitos = useMemo(() => /^\+?[\d\s()-]+$/.test(busca.trim()) && /\d/.test(busca), [busca]);

  function abrirNovo() {
    setShowNovo(true);
    if (buscaSoDigitos) {
      setNovoTel(busca);
      setNovoNome("");
    } else {
      setNovoNome(busca);
      setNovoTel("");
    }
  }

  async function salvarNovo() {
    if (novoNome.trim().length < 2) {
      toast.error("Nome precisa ter ao menos 2 caracteres");
      return;
    }
    if (!novoTel.trim()) {
      toast.error("Telefone obrigatório");
      return;
    }
    setSalvandoNovo(true);
    try {
      const resp = await cadastrarClienteSingle(novoNome, novoTel);
      setSelecionado({
        id: resp.cliente.id,
        nome: resp.cliente.nome,
        numero_whatsapp: resp.cliente.numero_whatsapp,
      });
      setShowNovo(false);
      setBusca("");
      toast.success(resp.criado ? "Cliente cadastrado" : "Cliente atualizado");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao cadastrar cliente");
    } finally {
      setSalvandoNovo(false);
    }
  }

  async function iniciar() {
    if (!selecionado) return;
    if (canChooseDept && (!departmentId || !assignedTo)) return;

    setIniciando(true);
    setConflito(null);
    try {
      const body: Record<string, string> = { client_id: selecionado.id };
      if (canChooseDept) {
        body.department_id = departmentId;
        body.assigned_to = assignedTo;
      }
      const { data, error } = await supabase.functions.invoke("iniciar-atendimento", { body });

      if (error) {
        // Tenta extrair body 409
        const ctx = (error as { context?: Response }).context;
        if (ctx) {
          try {
            const j = await ctx.json();
            if (j?.error === "cliente_com_atendimento_ativo") {
              setConflito({
                atendimento_id: j.atendimento_id,
                assigned_to_nome: j.assigned_to_nome,
                department_nome: j.department_nome,
              });
              return;
            }
            toast.error(j?.detalhe || j?.erro || error.message);
            return;
          } catch {
            // segue
          }
        }
        toast.error(error.message);
        return;
      }

      const resp = data as { ok: boolean; atendimento_id: string };
      if (resp?.ok) {
        toast.success("Atendimento iniciado");
        onCreated(resp.atendimento_id);
        navigate({ to: "/inbox", search: { conversation: resp.atendimento_id } });
        onOpenChange(false);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao iniciar atendimento");
    } finally {
      setIniciando(false);
    }
  }

  if (!open) return null;

  const podeIniciar = !!selecionado && (!canChooseDept || (!!departmentId && !!assignedTo));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => !iniciando && onOpenChange(false)}
    >
      <div
        className="w-full max-w-lg rounded-lg bg-card p-6 shadow-lg max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <h4 className="text-base font-semibold text-foreground">Iniciar atendimento</h4>
          <button
            onClick={() => onOpenChange(false)}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-5 space-y-4">
          {/* Cliente */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-foreground">Cliente</label>

            {selecionado ? (
              <div className="flex items-center justify-between rounded-md border border-border bg-muted px-3 py-2">
                <div className="text-sm">
                  <div className="text-foreground">
                    {selecionado.nome ?? <span className="italic text-muted-foreground">sem nome</span>}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {formatTelefoneBR(selecionado.numero_whatsapp)}
                  </div>
                </div>
                <button
                  onClick={() => {
                    setSelecionado(null);
                    setBusca("");
                    setConflito(null);
                  }}
                  className="text-xs text-primary hover:underline"
                >
                  Trocar
                </button>
              </div>
            ) : (
              <>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <input
                    autoFocus
                    value={busca}
                    onChange={(e) => setBusca(e.target.value)}
                    placeholder="Buscar por nome ou telefone..."
                    className="w-full rounded-md border border-border bg-background pl-9 pr-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/20"
                  />
                </div>

                {debounced.trim().length >= 2 && (
                  <div className="mt-2 max-h-56 overflow-y-auto rounded-md border border-border">
                    {sugestoesQ.isLoading && (
                      <div className="px-3 py-3 text-xs text-muted-foreground flex items-center gap-2">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Buscando...
                      </div>
                    )}
                    {!sugestoesQ.isLoading &&
                      sugestoes.map((c) => (
                        <button
                          key={c.id}
                          onClick={() => setSelecionado(c)}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-muted border-b border-border last:border-b-0"
                        >
                          <div className="text-foreground">
                            {c.nome ?? <span className="italic text-muted-foreground">sem nome</span>}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {formatTelefoneBR(c.numero_whatsapp)}
                          </div>
                        </button>
                      ))}
                    {semResultado && !showNovo && (
                      <button
                        onClick={abrirNovo}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-muted text-primary flex items-center gap-2"
                      >
                        <UserPlus className="h-4 w-4" />
                        Adicionar novo cliente: <strong>{busca}</strong>
                      </button>
                    )}
                  </div>
                )}

                {showNovo && (
                  <div className="mt-3 rounded-md border border-border bg-muted/20 p-3 space-y-2">
                    <div className="text-xs font-medium text-foreground">Novo cliente</div>
                    <input
                      value={novoNome}
                      onChange={(e) => setNovoNome(e.target.value)}
                      placeholder="Nome"
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                    />
                    <input
                      value={novoTel}
                      onChange={(e) => setNovoTel(e.target.value)}
                      placeholder="Telefone (ex: 11999999999)"
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                    />
                    <div className="flex justify-end gap-2 pt-1">
                      <button
                        onClick={() => setShowNovo(false)}
                        className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted"
                      >
                        Cancelar
                      </button>
                      <button
                        onClick={salvarNovo}
                        disabled={salvandoNovo}
                        className="flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                      >
                        {salvandoNovo && <Loader2 className="h-3 w-3 animate-spin" />}
                        Salvar e selecionar
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Depto + assigned_to (só Luana) */}
          {canChooseDept && selecionado && (
            <>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-foreground">
                  Departamento
                </label>
                <select
                  value={departmentId}
                  onChange={(e) => setDepartmentId(e.target.value)}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="">Selecione...</option>
                  {(deptsQ.data ?? []).map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.nome}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-foreground">
                  Atribuir a
                </label>
                <select
                  value={assignedTo}
                  onChange={(e) => setAssignedTo(e.target.value)}
                  disabled={!departmentId || usersQ.isLoading}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm disabled:opacity-50"
                >
                  <option value="">
                    {!departmentId
                      ? "Escolha o departamento primeiro"
                      : usersQ.isLoading
                        ? "Carregando..."
                        : (usersQ.data ?? []).length === 0
                          ? "Nenhum atendente disponível"
                          : "Selecione..."}
                  </option>
                  {(usersQ.data ?? []).map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.nome}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}

          {conflito && (
            <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-900">
              <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
              <div>
                <div className="font-medium">Cliente já está sendo atendido</div>
                <div className="mt-1 text-xs">
                  Atendente: <strong>{conflito.assigned_to_nome}</strong> ({conflito.department_nome}).
                  Peça para essa pessoa encerrar ou repassar o atendimento.
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={() => onOpenChange(false)}
            disabled={iniciando}
            className="rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            onClick={iniciar}
            disabled={!podeIniciar || iniciando}
            className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {iniciando && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Iniciar atendimento
          </button>
        </div>
      </div>
    </div>
  );
}
