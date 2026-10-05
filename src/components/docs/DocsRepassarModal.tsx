import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRightCircle, Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { initialsOf } from "@/lib/inbox-queries";
import { candidatosRepasse } from "@/lib/docs-logic";
import { listarPessoasDocs, repassarDocsConversa } from "@/lib/docs-queries";
import { notificarRepasseDocs } from "@/lib/docs-acoes";

/** Limite da observação no banco (docs_eventos_observacao_len_chk). */
const MAX_OBSERVACAO = 500;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversaId: string | null;
  /** Dono atual — sai da lista (a RPC recusaria repassar para ele mesmo). */
  donoAtual: string | null;
  onDone: () => void;
}

/**
 * Repasse de conversa do Docs. Mesmo desenho do RepassarModal da Inbox, mas o
 * destino só pode ser quem tem acesso ao Docs (docs_listar_acesso) e a ação é
 * a RPC docs_repassar. Depois do repasse, avisa a pessoa no WhatsApp pessoal
 * (best-effort, como a Inbox).
 */
export function DocsRepassarModal({ open, onOpenChange, conversaId, donoAtual, onDone }: Props) {
  const [busca, setBusca] = useState("");
  const [selecionado, setSelecionado] = useState<string | null>(null);
  const [observacao, setObservacao] = useState("");
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    if (!open) {
      setBusca("");
      setSelecionado(null);
      setObservacao("");
    }
  }, [open]);

  const pessoasQ = useQuery({
    queryKey: ["docs", "pessoas-acesso"],
    queryFn: listarPessoasDocs,
    enabled: open,
    staleTime: 60_000,
  });

  const grupos = useMemo(
    () => candidatosRepasse(pessoasQ.data ?? [], { donoAtual, busca }),
    [pessoasQ.data, donoAtual, busca],
  );
  const pessoa = (pessoasQ.data ?? []).find((p) => p.userId === selecionado) ?? null;

  const confirmar = async () => {
    if (!conversaId || !pessoa) return;
    setEnviando(true);
    try {
      await repassarDocsConversa({ conversaId, toUserId: pessoa.userId, observacao });
      toast.success(`Conversa repassada para ${pessoa.nome}`);
      void notificarRepasseDocs(conversaId, pessoa.userId);
      onDone();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível repassar a conversa.");
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !enviando && onOpenChange(v)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Repassar conversa</DialogTitle>
          <DialogDescription>
            Escolha quem assume esta conversa. Só aparece quem tem acesso ao Docs.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Buscar pessoa..."
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            className="pl-9"
          />
        </div>

        <div className="-mx-1 max-h-64 space-y-3 overflow-y-auto scroll-contain px-1">
          {pessoasQ.isLoading ? (
            <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Carregando...
            </div>
          ) : pessoasQ.isError ? (
            <p className="py-6 text-center text-sm text-destructive">
              Não foi possível carregar as pessoas agora.
            </p>
          ) : grupos.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Ninguém disponível para receber esta conversa.
            </p>
          ) : (
            grupos.map((g) => (
              <div key={g.departamento}>
                <div className="mb-1 px-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                  {g.departamento}
                </div>
                <div className="space-y-1">
                  {g.pessoas.map((p) => (
                    <button
                      key={p.userId}
                      type="button"
                      onClick={() => setSelecionado(p.userId)}
                      className={`flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors ${
                        selecionado === p.userId ? "bg-accent" : "hover:bg-muted"
                      }`}
                    >
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-xs font-medium text-primary">
                        {initialsOf(p.nome)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-foreground">{p.nome}</div>
                        {p.isSuperadmin && (
                          <div className="text-xs text-muted-foreground">Admin</div>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>

        <Textarea
          placeholder="Observação (opcional)"
          rows={2}
          maxLength={MAX_OBSERVACAO}
          value={observacao}
          onChange={(e) => setObservacao(e.target.value)}
        />

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={enviando}>
            Cancelar
          </Button>
          <Button disabled={!pessoa || enviando} onClick={confirmar}>
            {enviando ? (
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
