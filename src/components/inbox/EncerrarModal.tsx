import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  atendimentoId: string | null;
  userId: string;
  onDone: () => void;
}

/**
 * Extraído de `_app.inbox.tsx` (que já passava de 1500 linhas) — componente
 * autocontido, só depende de props e dos imports próprios, sem closures sobre
 * o estado da tela de Inbox.
 *
 * `userId` fica na assinatura sem uso no corpo — a RPC já resolve o usuário
 * pela sessão. Mantido para não mudar a API que `_app.inbox.tsx` já chama.
 */
export function EncerrarModal({ open, onOpenChange, atendimentoId, userId: _userId, onDone }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [motivo, setMotivo] = useState("");

  // Reset motivo sempre que o modal fecha (cancelar, overlay, sucesso).
  useEffect(() => {
    if (!open) setMotivo("");
  }, [open]);

  const handleConfirm = async () => {
    if (!atendimentoId) return;
    setSubmitting(true);

    const { data, error } = await supabase.rpc("encerrar_atendimento", {
      p_atendimento_id: atendimentoId,
      p_motivo: motivo.trim() || undefined,
    });

    setSubmitting(false);

    if (error) {
      if (error.code === "42501") {
        toast.error("Você não tem permissão para encerrar este atendimento.");
      } else {
        toast.error("Não foi possível encerrar o atendimento.");
      }
      return;
    }

    if (data === false) {
      toast.message("Este atendimento já estava encerrado.");
      onDone();
      return;
    }

    toast.success("Atendimento encerrado");
    onDone();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Encerrar atendimento</DialogTitle>
          <DialogDescription>
            Tem certeza que deseja encerrar este atendimento? Novas mensagens do cliente iniciarão
            um novo atendimento.
          </DialogDescription>
        </DialogHeader>

        <Textarea
          placeholder="Motivo do encerramento (opcional)"
          rows={3}
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
        />

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={submitting}
            className="bg-[#DC2626] text-white hover:bg-[#DC2626]/90"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            Encerrar atendimento
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
