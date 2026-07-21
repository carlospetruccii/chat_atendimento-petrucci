import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Contact, Loader2, Plus, Search, Trash2, UserPlus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  addSessao,
  fetchSessoes,
  formatarNumero,
  removeSessao,
  setSessaoAtivo,
  type SessaoRow,
} from "@/lib/sessoes-queries";
import { listContatos, type Contato } from "@/lib/contatos-queries";

export function SessoesTab() {
  const qc = useQueryClient();
  const [nome, setNome] = useState("");
  const [numero, setNumero] = useState("");
  const [semTriagem, setSemTriagem] = useState(false);
  const [busca, setBusca] = useState("");
  const [buscaAtiva, setBuscaAtiva] = useState("");

  const sessoesQ = useQuery({ queryKey: ["sessoes"], queryFn: fetchSessoes });

  const contatosQ = useQuery({
    queryKey: ["sessoes-contatos", buscaAtiva],
    queryFn: () => listContatos({ search: buscaAtiva, pageSize: 8 }),
    enabled: buscaAtiva.trim().length > 0,
  });

  const invalidar = () => qc.invalidateQueries({ queryKey: ["sessoes"] });

  const addM = useMutation({
    mutationFn: addSessao,
    onSuccess: () => {
      toast.success("Número adicionado à Lista de Sessões.");
      setNome("");
      setNumero("");
      setSemTriagem(false);
      invalidar();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Falha ao adicionar."),
  });

  const addContatoM = useMutation({
    mutationFn: ({ contato, semTriagem }: { contato: Contato; semTriagem: boolean }) =>
      addSessao({ numero: contato.numero_whatsapp ?? "", nome: contato.nome ?? null, semTriagem }),
    onSuccess: () => {
      toast.success("Contato adicionado à Lista de Sessões.");
      setSemTriagem(false);
      invalidar();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Falha ao adicionar."),
  });

  const toggleM = useMutation({
    mutationFn: ({ id, ativo }: { id: string; ativo: boolean }) => setSessaoAtivo(id, ativo),
    onSuccess: () => invalidar(),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Falha ao atualizar."),
  });

  const removeM = useMutation({
    mutationFn: removeSessao,
    onSuccess: () => {
      toast.success("Número removido da lista.");
      invalidar();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Falha ao remover."),
  });

  const sessoes = sessoesQ.data ?? [];
  const numerosJaNaLista = new Set(sessoes.map((s) => s.numero_whatsapp));

  return (
    <div className="max-w-2xl">
      {/* Cabeçalho */}
      <div className="mb-6 flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent">
          <Users className="h-5 w-5 text-primary" strokeWidth={1.75} />
        </div>
        <div>
          <h2 className="text-base font-semibold text-foreground">Lista de Sessões</h2>
          <p className="text-sm text-muted-foreground">
            Números liberados (gerentes, diretoria, contatos internos) que{" "}
            <strong>não passam pela triagem de cliente</strong>. Por padrão, a pessoa recebe uma
            saudação pelo nome, escolhe o setor e depois com qual colaborador quer falar — mas dá
            para marcar um número para não ter <strong>nenhuma</strong> triagem, direto na fila
            geral. É opcional — deixe vazio se não quiser usar.
          </p>
        </div>
      </div>

      {/* Modo — vale para o próximo número adicionado, manual ou por contato */}
      <label
        htmlFor="sem-triagem-switch"
        className="mb-4 flex cursor-pointer items-start gap-3 rounded-2xl border border-border bg-card p-4"
      >
        <Switch
          id="sem-triagem-switch"
          checked={semTriagem}
          onCheckedChange={setSemTriagem}
          className="mt-0.5"
        />
        <span>
          <span className="block text-sm font-medium text-foreground">
            Adicionar sem nenhuma triagem
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            Vale para o próximo número adicionado (manual ou por contato salvo). A mensagem cai
            direto na fila geral de Pendentes — sem saudação, sem perguntas do bot. Desligado
            (padrão), a pessoa escolhe o setor e depois com quem quer falar.
          </span>
        </span>
      </label>

      {/* Adicionar manualmente */}
      <div className="rounded-2xl border border-border bg-card p-5">
        <h3 className="text-sm font-semibold text-foreground">Adicionar um número</h3>
        <form
          className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (!numero.trim()) return;
            addM.mutate({ numero, nome, semTriagem });
          }}
        >
          <div className="flex-1">
            <label className="mb-1 block text-xs text-muted-foreground">Nome (opcional)</label>
            <Input
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder="Ex.: Maria (Diretoria)"
            />
          </div>
          <div className="flex-1">
            <label className="mb-1 block text-xs text-muted-foreground">Número</label>
            <Input
              value={numero}
              onChange={(e) => setNumero(e.target.value)}
              placeholder="Ex.: 11 91234-5678"
              inputMode="tel"
            />
          </div>
          <Button type="submit" disabled={addM.isPending || !numero.trim()}>
            {addM.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <UserPlus className="h-4 w-4" />
            )}
            Adicionar
          </Button>
        </form>
      </div>

      {/* Escolher de contatos salvos */}
      <div className="mt-4 rounded-2xl border border-border bg-card p-5">
        <h3 className="text-sm font-semibold text-foreground">Ou escolher um contato salvo</h3>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setBuscaAtiva(busca);
          }}
        >
          <Input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar por nome ou número…"
          />
          <Button type="submit" variant="outline" disabled={!busca.trim()}>
            <Search className="h-4 w-4" />
            Buscar
          </Button>
        </form>

        {buscaAtiva.trim().length > 0 && (
          <div className="mt-3">
            {contatosQ.isLoading ? (
              <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Buscando…
              </div>
            ) : (contatosQ.data?.rows.length ?? 0) === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">Nenhum contato encontrado.</p>
            ) : (
              <ul className="divide-y divide-border">
                {contatosQ.data!.rows.map((c) => {
                  const semNumero = !c.numero_whatsapp;
                  const jaNaLista = c.numero_whatsapp
                    ? numerosJaNaLista.has(c.numero_whatsapp)
                    : false;
                  return (
                    <li key={c.id} className="flex items-center justify-between gap-3 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-sm text-foreground">
                          {c.nome ?? "Sem nome"}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {c.numero_whatsapp
                            ? formatarNumero(c.numero_whatsapp)
                            : c.numero_raw ?? "sem número"}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={semNumero || jaNaLista || addContatoM.isPending}
                        onClick={() => addContatoM.mutate({ contato: c, semTriagem })}
                      >
                        <Plus className="h-4 w-4" />
                        {jaNaLista ? "Já na lista" : "Adicionar"}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Lista atual */}
      <div className="mt-6">
        <h3 className="mb-3 text-sm font-semibold text-foreground">
          Números na lista {sessoes.length > 0 && `(${sessoes.length})`}
        </h3>

        {sessoesQ.isLoading ? (
          <div className="flex items-center justify-center rounded-2xl border border-border bg-card py-12 text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Carregando…
          </div>
        ) : sessoes.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card py-12 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-accent">
              <Contact className="h-5 w-5 text-primary" strokeWidth={1.5} />
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              Nenhum número na lista ainda. Adicione acima quando quiser.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border rounded-2xl border border-border bg-card">
            {sessoes.map((s: SessaoRow) => (
              <li key={s.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <span className="truncate">{s.nome ?? "Sem nome"}</span>
                    {s.sem_triagem && (
                      <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-[10px] font-medium text-primary">
                        Sem triagem
                      </span>
                    )}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {formatarNumero(s.numero_whatsapp)}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={s.ativo}
                      onCheckedChange={(v) => toggleM.mutate({ id: s.id, ativo: v })}
                    />
                    <span className="text-xs text-muted-foreground">
                      {s.ativo ? "Ativo" : "Inativo"}
                    </span>
                  </div>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button size="icon" variant="ghost" className="text-muted-foreground hover:text-destructive">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Remover da Lista de Sessões?</AlertDialogTitle>
                        <AlertDialogDescription>
                          {s.nome ? `${s.nome} (${formatarNumero(s.numero_whatsapp)})` : formatarNumero(s.numero_whatsapp)}{" "}
                          voltará a passar pela triagem normal de cliente ao chamar.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancelar</AlertDialogCancel>
                        <AlertDialogAction onClick={() => removeM.mutate(s.id)}>
                          Remover
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
