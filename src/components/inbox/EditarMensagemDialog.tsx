import { useEffect, useMemo, useState } from "react";
import { Loader2, Pencil } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import type { InboxMessage } from "@/lib/inbox-queries";
import { avaliarAcao, expiraEm, textoMotivo } from "@/lib/janelas-whatsapp";
import { editarMensagemEnviada, explicarMotivo, type ResultadoEditar } from "@/lib/mensagem-acoes";
import { type MensagemAvaliavelNaTela, paraAvaliavel } from "@/hooks/useSelecaoMensagens";
import { useAgora } from "@/hooks/useAgora";

interface EditarMensagemDialogProps {
  /** null = fechado. Mensagem da Inbox ou do Docs. */
  mensagem: (MensagemAvaliavelNaTela & Pick<InboxMessage, "id" | "content">) | null;
  onOpenChange: (open: boolean) => void;
  onEditada: (mensagemId: string, texto: string) => void;
  /** Quem executa a edição. Padrão: a da Inbox (mensagem-acao); o Docs passa a sua. */
  editar?: (params: { mensagemId: string; texto: string }) => Promise<ResultadoEditar>;
}

/** "4 min" / "38 s" — quanto ainda dá para editar. */
function tempoRestante(msRestantes: number): string {
  if (msRestantes <= 0) return "expirado";
  const seg = Math.ceil(msRestantes / 1000);
  return seg >= 60 ? `${Math.floor(seg / 60)} min` : `${seg} s`;
}

/**
 * Edição de uma mensagem já enviada (recurso nativo do WhatsApp, ~15 min).
 *
 * O contador de tempo restante fica visível porque a janela é curta: sem ele a
 * pessoa escreve com calma, salva, e leva um "passou do prazo" sem entender por
 * quê. Quando o prazo estoura com o diálogo aberto, o botão desabilita na hora e
 * o motivo aparece no lugar do contador — o aviso vem antes da tentativa.
 */
export function EditarMensagemDialog({
  mensagem,
  onOpenChange,
  onEditada,
  editar = editarMensagemEnviada,
}: EditarMensagemDialogProps) {
  const [texto, setTexto] = useState("");
  const [salvando, setSalvando] = useState(false);
  // 1s aqui, não os 30s do padrão: é um contador que a pessoa está olhando.
  const agora = useAgora(1_000);

  useEffect(() => {
    setTexto(mensagem?.content ?? "");
  }, [mensagem?.id, mensagem?.content]);

  const elegivel = useMemo(
    () => (mensagem ? avaliarAcao("editar", paraAvaliavel(mensagem), agora) : { pode: false }),
    [mensagem, agora],
  );
  const restanteMs = mensagem ? expiraEm("editar", mensagem.createdAt) - agora : 0;

  const semMudanca = texto.trim() === (mensagem?.content ?? "").trim();
  const vazio = texto.trim() === "";

  const salvar = async () => {
    if (!mensagem) return;
    setSalvando(true);
    try {
      const r = await editar({ mensagemId: mensagem.id, texto });
      if (!r.ok) {
        toast.error("Não foi possível editar", {
          description: explicarMotivo("editar", r.motivo, r.detalhe),
          duration: 8000,
        });
        return;
      }
      toast.success("Mensagem editada");
      onEditada(mensagem.id, r.conteudo ?? texto.trim());
      onOpenChange(false);
    } catch (e) {
      toast.error("Falha ao editar", {
        description: e instanceof Error ? e.message : "Tente novamente.",
      });
    } finally {
      setSalvando(false);
    }
  };

  return (
    <Dialog open={!!mensagem} onOpenChange={(v) => !salvando && onOpenChange(v)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="h-4 w-4" strokeWidth={1.5} />
            Editar mensagem
          </DialogTitle>
          <DialogDescription>
            O cliente vê o texto novo com a marca “editada”, igual ao WhatsApp.
          </DialogDescription>
        </DialogHeader>

        <Textarea
          rows={5}
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          disabled={salvando || !elegivel.pode}
          placeholder="Texto da mensagem"
          autoFocus
        />

        {elegivel.pode ? (
          <p className="text-[11px] text-muted-foreground">
            Dá para editar por mais <span className="font-medium">{tempoRestante(restanteMs)}</span>
            .
          </p>
        ) : (
          <p className="text-[11px] font-medium text-[#DC2626]">
            {elegivel.motivo
              ? textoMotivo("editar", elegivel.motivo)
              : "Essa mensagem não pode mais ser editada."}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={salvando}>
            Cancelar
          </Button>
          <Button onClick={salvar} disabled={salvando || !elegivel.pode || semMudanca || vazio}>
            {salvando && <Loader2 className="h-4 w-4 animate-spin" />}
            Salvar edição
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
