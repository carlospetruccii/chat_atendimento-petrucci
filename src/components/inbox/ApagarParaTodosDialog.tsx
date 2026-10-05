import { useState } from "react";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
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
import type { InboxMessage } from "@/lib/inbox-queries";
import {
  apagarMensagensParaTodos,
  explicarMotivo,
  type ResultadoApagar,
} from "@/lib/mensagem-acoes";

/** O que o diálogo lê de cada mensagem (Inbox ou Docs). */
type MensagemApagavel = Pick<
  InboxMessage,
  "id" | "tipo" | "content" | "senderType" | "mediaMetadata"
>;

interface ApagarParaTodosDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Mensagens selecionadas, na ordem da conversa. */
  mensagens: MensagemApagavel[];
  /** Chamado depois do apagar (parcial ou total) para a tela recarregar. */
  onConcluido: (resultados: ResultadoApagar[]) => void;
  /** Quem executa. Padrão: a da Inbox (mensagem-acao); o Docs passa a sua. */
  apagar?: (mensagemIds: string[]) => Promise<ResultadoApagar[]>;
}

function resumoDaMensagem(m: MensagemApagavel): string {
  if (m.tipo !== "texto") {
    const rotulos: Record<string, string> = {
      imagem: "📷 Imagem",
      audio: "🎤 Áudio",
      video: "🎥 Vídeo",
      documento: "📎 Documento",
      sticker: "Figurinha",
      localizacao: "Localização",
      contato: "Contato",
    };
    return rotulos[m.tipo] ?? `(${m.tipo})`;
  }
  const texto = (m.content ?? "").trim();
  return texto.length > 90 ? `${texto.slice(0, 90)}…` : texto || "(sem texto)";
}

/**
 * A mensagem saiu do celular da empresa, não deste sistema?
 *
 * Vale marcar na confirmação: a bolha do sistema é "eu mandei", a do celular
 * pode ter sido um colega respondendo pelo aparelho. Antes de apagar sem
 * desfazer, quem clica merece ver essa diferença.
 */
function veioDoCelular(m: MensagemApagavel): boolean {
  return (
    m.senderType === "externo" &&
    (m.mediaMetadata as { origem?: string } | null)?.origem === "celular"
  );
}

/**
 * Confirmação de "apagar para todos".
 *
 * A confirmação é obrigatória por pedido do produto e por natureza da ação: não
 * existe desfazer no WhatsApp. O diálogo mostra o que vai ser apagado para a
 * pessoa reconhecer a mensagem antes de decidir.
 */
export function ApagarParaTodosDialog({
  open,
  onOpenChange,
  mensagens,
  onConcluido,
  apagar = apagarMensagensParaTodos,
}: ApagarParaTodosDialogProps) {
  const [enviando, setEnviando] = useState(false);

  const confirmar = async () => {
    setEnviando(true);
    try {
      const resultados = await apagar(mensagens.map((m) => m.id));
      const apagadas = resultados.filter((r) => r.ok);
      const falhas = resultados.filter((r) => !r.ok);

      if (apagadas.length > 0) {
        toast.success(
          apagadas.length === 1
            ? "Mensagem apagada para todos"
            : `${apagadas.length} mensagens apagadas para todos`,
        );
      }
      // Cada falha ganha seu próprio aviso com o motivo: num lote parcial, saber
      // QUAL mensagem continua no celular do cliente é a informação que importa.
      for (const f of falhas) {
        const alvo = mensagens.find((m) => m.id === f.mensagemId);
        toast.error(
          alvo ? `Não apagada: "${resumoDaMensagem(alvo)}"` : "Uma mensagem não foi apagada",
          { description: explicarMotivo("apagar", f.motivo, f.detalhe), duration: 8000 },
        );
      }

      onConcluido(resultados);
      onOpenChange(false);
    } catch (e) {
      toast.error("Falha ao apagar", {
        description: e instanceof Error ? e.message : "Tente novamente.",
      });
    } finally {
      setEnviando(false);
    }
  };

  const quantas = mensagens.length;

  return (
    <Dialog open={open} onOpenChange={(v) => !enviando && onOpenChange(v)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="h-4 w-4" strokeWidth={1.5} />
            {quantas === 1
              ? "Apagar mensagem para todos?"
              : `Apagar ${quantas} mensagens para todos?`}
          </DialogTitle>
          <DialogDescription>
            {quantas === 1 ? "A mensagem sai" : "As mensagens saem"} do WhatsApp do cliente e no
            lugar aparece “Esta mensagem foi apagada”. Não tem como desfazer.
          </DialogDescription>
        </DialogHeader>

        <ul className="max-h-40 space-y-1.5 overflow-y-auto rounded-md border border-border bg-muted/40 p-2.5">
          {mensagens.map((m) => (
            <li key={m.id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="truncate">{resumoDaMensagem(m)}</span>
              {veioDoCelular(m) && (
                <span className="shrink-0 rounded border border-border px-1 py-px text-[10px] leading-tight">
                  do celular
                </span>
              )}
            </li>
          ))}
        </ul>

        <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" strokeWidth={1.5} />
          Se o cliente já tiver lido, ele pode ter visto o conteúdo antes de você apagar.
        </p>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={enviando}>
            Cancelar
          </Button>
          <Button
            onClick={confirmar}
            disabled={enviando || quantas === 0}
            className="bg-[#DC2626] text-white hover:bg-[#DC2626]/90"
          >
            {enviando && <Loader2 className="h-4 w-4 animate-spin" />}
            Apagar para todos
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
