import { useMemo, useState } from "react";
import { Forward, Loader2, Search } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { initialsOf, type InboxConversation, type InboxMessage } from "@/lib/inbox-queries";
import {
  encaminharMensagem,
  explicarMotivoEncaminhar,
  type ResultadoEncaminhar,
} from "@/lib/mensagem-encaminhar";

/** Encaminhamento da Inbox (padrão): destino é um atendimento. */
function encaminharNaInbox(params: {
  mensagemId: string;
  destinoId: string;
}): Promise<ResultadoEncaminhar> {
  return encaminharMensagem({
    mensagemId: params.mensagemId,
    atendimentoIdDestino: params.destinoId,
  });
}

interface EncaminharDialogProps {
  /** null = fechado. */
  mensagem: Pick<InboxMessage, "id"> | null;
  /** Conversas já carregadas na tela (mesma lista da barra lateral) — não faz query própria. */
  conversations: Array<Pick<InboxConversation, "id" | "clientNome" | "clientNumero">>;
  /** Excluída da lista: não faz sentido encaminhar para a própria conversa. */
  currentAtendimentoId: string | null;
  onOpenChange: (open: boolean) => void;
  onEncaminhada: () => void;
  /** Quem executa. Padrão: a da Inbox (mensagem-encaminhar); o Docs passa a sua. */
  encaminhar?: (params: { mensagemId: string; destinoId: string }) => Promise<ResultadoEncaminhar>;
  /** Texto da lista vazia (o Docs explica que só vale conversa em que você é dono). */
  textoSemDestino?: string;
}

/**
 * Escolha de destino para "Encaminhar" — reaproveita as conversas já visíveis
 * na Inbox (mesma régua de permissão da barra lateral); não cria contato nem
 * atendimento novo.
 */
export function EncaminharDialog({
  mensagem,
  conversations,
  currentAtendimentoId,
  onOpenChange,
  onEncaminhada,
  encaminhar = encaminharNaInbox,
  textoSemDestino = "Nenhuma conversa encontrada.",
}: EncaminharDialogProps) {
  const [search, setSearch] = useState("");
  const [destinoId, setDestinoId] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const candidatos = useMemo(() => {
    const termo = search.trim().toLowerCase();
    return conversations
      .filter((c) => c.id !== currentAtendimentoId)
      .filter(
        (c) =>
          !termo ||
          c.clientNome.toLowerCase().includes(termo) ||
          c.clientNumero.includes(search.trim()),
      );
  }, [conversations, currentAtendimentoId, search]);

  const fechar = (v: boolean) => {
    if (enviando) return;
    if (!v) {
      setSearch("");
      setDestinoId(null);
    }
    onOpenChange(v);
  };

  const confirmar = async () => {
    if (!mensagem || !destinoId) return;
    setEnviando(true);
    try {
      const r = await encaminhar({ mensagemId: mensagem.id, destinoId });
      if (!r.ok) {
        toast.error("Não foi possível encaminhar", {
          description: explicarMotivoEncaminhar(r.motivo, r.detalhe),
        });
        return;
      }
      toast.success("Mensagem encaminhada");
      onEncaminhada();
      fechar(false);
    } catch (e) {
      toast.error("Falha ao encaminhar", {
        description: e instanceof Error ? e.message : "Tente novamente.",
      });
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Dialog open={!!mensagem} onOpenChange={fechar}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Forward className="h-4 w-4" strokeWidth={1.5} />
            Encaminhar mensagem
          </DialogTitle>
          <DialogDescription>Escolha para qual conversa encaminhar.</DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar conversa..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        <div className="max-h-64 overflow-y-auto scroll-contain -mx-1 space-y-1 px-1">
          {candidatos.length === 0 ? (
            <p className="px-1 py-6 text-center text-sm text-muted-foreground">
              {search.trim() ? "Nenhuma conversa encontrada." : textoSemDestino}
            </p>
          ) : (
            candidatos.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setDestinoId(c.id)}
                className={`flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors ${
                  destinoId === c.id ? "bg-accent" : "hover:bg-muted"
                }`}
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-medium text-primary">
                  {initialsOf(c.clientNome)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-foreground">{c.clientNome}</div>
                  <div className="truncate text-xs text-muted-foreground">{c.clientNumero}</div>
                </div>
              </button>
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => fechar(false)} disabled={enviando}>
            Cancelar
          </Button>
          <Button onClick={confirmar} disabled={!destinoId || enviando}>
            {enviando ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Forward className="h-4 w-4" strokeWidth={1.5} />
            )}
            Encaminhar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
