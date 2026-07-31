import { useEffect, useRef, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { otimizarTexto } from "@/lib/ai-texto";

interface Props {
  /** Mensagem original digitada; null = diálogo fechado. */
  original: string | null;
  /** Envio em andamento (desabilita os botões). */
  enviando: boolean;
  /** Fechar sem enviar — a pessoa volta a editar o rascunho. */
  onCancelar: () => void;
  /** Enviar o texto escolhido (sugestão, editada ou original). */
  onEnviar: (texto: string) => void;
}

/**
 * Ao enviar, a IA sugere uma versão otimizada da mensagem (pt-BR) e a pessoa
 * escolhe: enviar a sugestão (editável) ou o texto original. Se a IA falhar
 * ou não mudar nada, o original é enviado direto — o atendimento nunca trava.
 */
export function SugestaoEnvioDialog({ original, enviando, onCancelar, onEnviar }: Props) {
  const [sugestao, setSugestao] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);
  // onEnviar/onCancelar mudam a cada render do pai; refs evitam reexecutar o efeito.
  const onEnviarRef = useRef(onEnviar);
  onEnviarRef.current = onEnviar;

  useEffect(() => {
    if (!original) {
      setSugestao(null);
      setCarregando(false);
      return;
    }
    let ativo = true;
    setCarregando(true);
    otimizarTexto(original)
      .then((texto) => {
        if (!ativo) return;
        if (texto.trim() === original.trim()) {
          // Nada a melhorar: envia direto, sem burocracia. O textarea é
          // preenchido antes para o diálogo não ficar vazio se o envio falhar.
          setSugestao(original);
          onEnviarRef.current(original);
          return;
        }
        setSugestao(texto);
      })
      .catch((e) => {
        if (!ativo) return;
        setSugestao(original);
        toast.error(e instanceof Error ? e.message : "IA indisponível.", {
          description: "A mensagem foi enviada como você escreveu.",
        });
        onEnviarRef.current(original);
      })
      .finally(() => {
        if (ativo) setCarregando(false);
      });
    return () => {
      ativo = false;
    };
  }, [original]);

  return (
    <Dialog open={original !== null} onOpenChange={(open) => !open && !enviando && onCancelar()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            Sugestão da IA
          </DialogTitle>
          <DialogDescription>
            Revisão de português e clareza antes do envio.
          </DialogDescription>
        </DialogHeader>

        {carregando || !original ? (
          <div className="flex items-center gap-3 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Otimizando sua mensagem…
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">Você escreveu</p>
              <p className="max-h-24 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                {original}
              </p>
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                Sugestão (edite se quiser)
              </p>
              <Textarea
                value={sugestao ?? ""}
                onChange={(e) => setSugestao(e.target.value)}
                rows={4}
                lang="pt-BR"
                spellCheck
                className="text-sm"
              />
            </div>
          </div>
        )}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            // Bloqueado enquanto a IA responde: com a resposta em voo, um
            // clique aqui + o auto-envio do efeito mandariam a mensagem 2x.
            disabled={enviando || carregando || !original}
            onClick={() => original && onEnviar(original)}
          >
            Enviar original
          </Button>
          <Button
            type="button"
            disabled={enviando || carregando || !sugestao?.trim()}
            onClick={() => sugestao && onEnviar(sugestao.trim())}
          >
            {enviando ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Enviar sugestão
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
