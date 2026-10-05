import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  titulo: string;
  descricao: string;
  rotuloConfirmar: string;
  /** Vermelho, como o "Encerrar atendimento" da Inbox. */
  destrutivo?: boolean;
  /** Lança Error com a frase pronta para o toast (ver docs-queries). */
  onConfirmar: () => Promise<void>;
  mensagemSucesso: string;
  onConcluido: () => void;
}

/**
 * Confirmação curta das ações de ciclo do Docs (encerrar, tomar a conversa de
 * outra pessoa). As duas mexem no dono da conversa de um jeito que a outra
 * pessoa sente — por isso não saem num clique só.
 */
export function DocsConfirmacaoDialog({
  open,
  onOpenChange,
  titulo,
  descricao,
  rotuloConfirmar,
  destrutivo = false,
  onConfirmar,
  mensagemSucesso,
  onConcluido,
}: Props) {
  const [enviando, setEnviando] = useState(false);

  const confirmar = async () => {
    setEnviando(true);
    try {
      await onConfirmar();
      toast.success(mensagemSucesso);
      onConcluido();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível concluir.");
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !enviando && onOpenChange(v)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{titulo}</DialogTitle>
          <DialogDescription>{descricao}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={enviando}>
            Cancelar
          </Button>
          <Button
            onClick={confirmar}
            disabled={enviando}
            className={destrutivo ? "bg-[#DC2626] text-white hover:bg-[#DC2626]/90" : undefined}
          >
            {enviando && <Loader2 className="h-4 w-4 animate-spin" />}
            {rotuloConfirmar}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
