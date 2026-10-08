import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, ArrowRightCircle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { initialsOf, notificarRepasse } from "@/lib/inbox-queries";
import { mensagemErroRepasse } from "@/lib/repasse-erro";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

interface CollabRow {
  id: string;
  nome: string;
  department_id: string | null;
  departmentNome: string;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  atendimentoId: string | null;
  onDone: () => void;
}

/**
 * Extraído de `_app.inbox.tsx` (que já passava de 1500 linhas) — componente
 * autocontido, só depende de props e dos imports próprios, sem closures sobre
 * o estado da tela de Inbox.
 */
export function RepassarModal({ open, onOpenChange, atendimentoId, onDone }: Props) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [observacao, setObservacao] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const { data: collabs } = useQuery({
    queryKey: ["collaborators-active"],
    queryFn: async (): Promise<CollabRow[]> => {
      const { data, error } = await supabase
        .from("users")
        .select("id, nome, department_id, ativo, is_system_user, departments:department_id(nome)")
        .eq("ativo", true)
        .eq("is_system_user", false)
        .order("nome");
      if (error) throw error;
      return (data ?? []).map((u) => ({
        id: u.id,
        nome: u.nome,
        department_id: u.department_id,
        departmentNome: (u.departments as { nome: string } | null)?.nome ?? "Sem departamento",
      }));
    },
    enabled: open,
  });

  // Filtrar dentro do useMemo, não fora: `filtered` criado no corpo do render é
  // uma referência nova a cada passada, então como dependência ele nunca deixava
  // o cache bater — o memo era decorativo.
  const grouped = useMemo(() => {
    const termo = search.toLowerCase();
    const acc: Record<string, CollabRow[]> = {};
    for (const c of collabs ?? []) {
      if (!c.nome.toLowerCase().includes(termo)) continue;
      (acc[c.departmentNome] ??= []).push(c);
    }
    return acc;
  }, [collabs, search]);
  const selectedUser = (collabs ?? []).find((c) => c.id === selected);

  const handleConfirm = async () => {
    if (!atendimentoId || !selectedUser) return;
    setSubmitting(true);

    const { data, error } = await supabase.rpc("repassar_atendimento", {
      p_atendimento_id: atendimentoId,
      p_to_user_id: selectedUser.id,
      p_observacao: observacao.trim() || undefined,
    });

    setSubmitting(false);

    if (error) {
      toast.error(mensagemErroRepasse(error, selectedUser.nome));
      return;
    }

    if (data === false) {
      toast.message("Atendimento já não pode mais ser repassado.");
      setObservacao("");
      onDone();
      return;
    }

    setObservacao("");
    toast.success(`Atendimento repassado para ${selectedUser.nome}`);
    // Avisa o colaborador no WhatsApp pessoal (best-effort, não bloqueia).
    void notificarRepasse(atendimentoId, selectedUser.id);
    onDone();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Repassar atendimento</DialogTitle>
          <DialogDescription>
            Selecione o colaborador que deve assumir esta conversa.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar colaborador..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        <div className="max-h-64 overflow-y-auto scroll-contain -mx-1 px-1 space-y-3">
          {Object.entries(grouped).map(([dept, users]) => (
            <div key={dept}>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground px-1 mb-1">
                {dept}
              </div>
              <div className="space-y-1">
                {users.map((u) => (
                  <button
                    key={u.id}
                    onClick={() => setSelected(u.id)}
                    className={`w-full flex items-center gap-3 rounded-md px-2 py-2 text-left transition-colors ${
                      selected === u.id ? "bg-accent" : "hover:bg-muted"
                    }`}
                  >
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-xs font-medium text-primary">
                      {initialsOf(u.nome)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-foreground">{u.nome}</div>
                      <div className="text-xs text-muted-foreground">{u.departmentNome}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <Textarea
          placeholder="Observação (opcional)"
          rows={2}
          value={observacao}
          onChange={(e) => setObservacao(e.target.value)}
        />

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button disabled={!selectedUser || submitting} onClick={handleConfirm}>
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowRightCircle className="h-4 w-4" strokeWidth={1.5} />
            )}
            Confirmar repasse
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
