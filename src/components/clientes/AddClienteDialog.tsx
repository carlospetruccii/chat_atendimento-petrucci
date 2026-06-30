import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2, X, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { cadastrarClienteSingle } from "@/lib/clientes-queries";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}

export function AddClienteDialog({ open, onOpenChange, onSaved }: Props) {
  const [nome, setNome] = useState("");
  const [telefone, setTelefone] = useState("");
  const [conflito, setConflito] = useState<{ nomeAnterior: string } | null>(null);

  const reset = () => {
    setNome("");
    setTelefone("");
    setConflito(null);
  };

  const mut = useMutation({
    mutationFn: () => cadastrarClienteSingle(nome, telefone),
    onSuccess: (resp) => {
      if (resp.atualizado && !conflito) {
        // Telefone já existia: pergunta antes de sobrescrever (mas o upsert já rodou).
        // Como já atualizamos, mostra info e fecha.
        setConflito({ nomeAnterior: resp.nome_anterior ?? "(sem nome)" });
        toast.success(`Cliente atualizado (era: ${resp.nome_anterior ?? "sem nome"})`);
      } else {
        toast.success(resp.criado ? "Cliente cadastrado" : "Cliente atualizado");
      }
      onSaved();
      reset();
      onOpenChange(false);
    },
    onError: (e: Error) => {
      toast.error(e.message);
    },
  });

  if (!open) return null;

  const podeSalvar = nome.trim().length >= 2 && telefone.trim().length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => !mut.isPending && (reset(), onOpenChange(false))}
    >
      <div
        className="w-full max-w-md rounded-lg bg-card p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <h4 className="text-base font-semibold text-foreground">Adicionar cliente</h4>
          <button
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-5 space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-foreground">Nome</label>
            <input
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder="Nome completo"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-foreground">Telefone</label>
            <input
              value={telefone}
              onChange={(e) => setTelefone(e.target.value)}
              placeholder="11999999999 ou +5511999999999"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Se não começar com +, prefixamos +55 automaticamente.
            </p>
          </div>

          {conflito && (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <div>
                Telefone já existia. Nome anterior: <strong>{conflito.nomeAnterior}</strong>.
              </div>
            </div>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
            disabled={mut.isPending}
            className="rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            onClick={() => mut.mutate()}
            disabled={!podeSalvar || mut.isPending}
            className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {mut.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}
