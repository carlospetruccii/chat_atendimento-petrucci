import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Contact, Loader2, Plus, Search, Trash2, UserPlus, ZapOff } from "lucide-react";
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
  addSemTriagem,
  fetchSemTriagem,
  formatarNumero,
  removeSemTriagem,
  setSemTriagemAtivo,
  type SemTriagemRow,
} from "@/lib/sem-triagem-queries";
import { listContatos, type Contato } from "@/lib/contatos-queries";

export function SemTriagemSection() {
  const qc = useQueryClient();
  const [nome, setNome] = useState("");
  const [numero, setNumero] = useState("");
  const [busca, setBusca] = useState("");
  const [buscaAtiva, setBuscaAtiva] = useState("");

  const listaQ = useQuery({ queryKey: ["numeros-sem-triagem"], queryFn: fetchSemTriagem });

  const contatosQ = useQuery({
    queryKey: ["sem-triagem-contatos", buscaAtiva],
    queryFn: () => listContatos({ search: buscaAtiva, pageSize: 8 }),
    enabled: buscaAtiva.trim().length > 0,
  });

  const invalidar = () => qc.invalidateQueries({ queryKey: ["numeros-sem-triagem"] });

  const addM = useMutation({
    mutationFn: addSemTriagem,
    onSuccess: () => {
      toast.success("Número adicionado à lista Sem Triagem.");
      setNome("");
      setNumero("");
      invalidar();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Falha ao adicionar."),
  });

  const addContatoM = useMutation({
    mutationFn: (c: Contato) =>
      addSemTriagem({ numero: c.numero_whatsapp ?? "", nome: c.nome ?? null }),
    onSuccess: () => {
      toast.success("Contato adicionado à lista Sem Triagem.");
      invalidar();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Falha ao adicionar."),
  });

  const toggleM = useMutation({
    mutationFn: ({ id, ativo }: { id: string; ativo: boolean }) => setSemTriagemAtivo(id, ativo),
    onSuccess: () => invalidar(),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Falha ao atualizar."),
  });

  const removeM = useMutation({
    mutationFn: removeSemTriagem,
    onSuccess: () => {
      toast.success("Número removido da lista.");
      invalidar();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Falha ao remover."),
  });

  const itens = listaQ.data ?? [];
  const numerosJaNaLista = new Set(itens.map((s) => s.numero_whatsapp));

  return (
    <div className="mx-auto max-w-2xl">
      {/* Cabeçalho */}
      <div className="mb-6 flex items-center gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent">
          <ZapOff className="h-5 w-5 text-primary" strokeWidth={1.75} />
        </div>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">Sem Triagem</h2>
          <p className="text-sm text-muted-foreground">
            Números que <strong>não recebem nenhuma triagem</strong>. Ao mandar mensagem, a pessoa{" "}
            <strong>não</strong> conversa com o bot — nem saudação, nem escolha de setor ou
            colaborador. A conversa cai direto na fila geral de Pendentes para um atendente assumir.
            É diferente da Lista de Sessões (que ainda pergunta setor e pessoa).
          </p>
        </div>
      </div>

      {/* Adicionar manualmente */}
      <div className="rounded-2xl border border-border bg-card p-5">
        <h3 className="text-sm font-semibold text-foreground">Adicionar um número</h3>
        <form
          className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (!numero.trim()) return;
            addM.mutate({ numero, nome });
          }}
        >
          <div className="flex-1">
            <label className="mb-1 block text-xs text-muted-foreground">Nome (opcional)</label>
            <Input
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder="Ex.: Cristiane"
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
                    <li
                      key={c.id}
                      className="flex min-h-16 items-center justify-between gap-3 py-2.5"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm text-foreground">{c.nome ?? "Sem nome"}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {c.numero_whatsapp
                            ? formatarNumero(c.numero_whatsapp)
                            : (c.numero_raw ?? "sem número")}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={semNumero || jaNaLista || addContatoM.isPending}
                        onClick={() => addContatoM.mutate(c)}
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
          Números na lista {itens.length > 0 && `(${itens.length})`}
        </h3>

        {listaQ.isLoading ? (
          <div className="flex items-center justify-center rounded-2xl border border-border bg-card py-12 text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Carregando…
          </div>
        ) : itens.length === 0 ? (
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
            {itens.map((s: SemTriagemRow) => (
              <li key={s.id} className="flex min-h-16 items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {s.nome ?? "Sem nome"}
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
                      <Button
                        size="icon"
                        variant="ghost"
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Remover da lista Sem Triagem?</AlertDialogTitle>
                        <AlertDialogDescription>
                          {s.nome
                            ? `${s.nome} (${formatarNumero(s.numero_whatsapp)})`
                            : formatarNumero(s.numero_whatsapp)}{" "}
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
