import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { ClienteRow } from "@/lib/clientes-queries";

interface Props {
  cliente: ClienteRow | null;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}

function normalizarTelefone(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15) return null;
    return `+${digits}`;
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 11) return null;
  return `+55${digits}`;
}

export function EditClienteDialog({ cliente, onOpenChange, onSaved }: Props) {
  const [nome, setNome] = useState("");
  const [telefone, setTelefone] = useState("");

  useEffect(() => {
    if (cliente) {
      setNome(cliente.nome ?? "");
      setTelefone(cliente.numero_whatsapp ?? "");
    }
  }, [cliente]);

  const mut = useMutation({
    mutationFn: async () => {
      if (!cliente) throw new Error("Cliente inválido");
      const nomeLimpo = nome.trim();
      if (nomeLimpo.length < 2) throw new Error("Nome precisa ter ao menos 2 caracteres");
      const telE164 = normalizarTelefone(telefone);
      if (!telE164) throw new Error("Telefone inválido. Use 10–11 dígitos ou formato +55…");

      const { error } = await supabase
        .from("clients")
        .update({ nome: nomeLimpo, numero_whatsapp: telE164 })
        .eq("id", cliente.id);
      if (error) {
        if (/duplicate|unique/i.test(error.message)) {
          throw new Error("Já existe outro cliente com esse telefone");
        }
        throw new Error(error.message);
      }
    },
    onSuccess: () => {
      toast.success("Cliente atualizado");
      onSaved();
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!cliente) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => !mut.isPending && onOpenChange(false)}
    >
      <div
        className="w-full max-w-md rounded-lg bg-card p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <h4 className="text-base font-semibold text-foreground">Editar cliente</h4>
          <button
            onClick={() => onOpenChange(false)}
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
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={() => onOpenChange(false)}
            disabled={mut.isPending}
            className="rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            onClick={() => mut.mutate()}
            disabled={mut.isPending}
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
