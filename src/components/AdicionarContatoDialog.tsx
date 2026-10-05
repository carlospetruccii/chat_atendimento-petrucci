import { useEffect, useState, type FormEvent, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  adicionarContato,
  AdicionarContatoValidationError,
  type AdicionarContatoErrors,
} from "@/lib/adicionar-contato";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { avisoCadastro } from "@/lib/cadastro-aviso";

interface AdicionarContatoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  /** Valores iniciais dos campos (ex.: vindos de um cartão de contato recebido). */
  initialNome?: string;
  initialTelefone?: string;
}

export function AdicionarContatoDialog({
  open,
  onOpenChange,
  returnFocusRef,
  initialNome = "",
  initialTelefone = "",
}: AdicionarContatoDialogProps) {
  const queryClient = useQueryClient();
  const [nome, setNome] = useState("");
  const [telefone, setTelefone] = useState("");
  const [errors, setErrors] = useState<AdicionarContatoErrors>({});
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    if (!open) return;
    setNome(initialNome);
    setTelefone(initialTelefone);
    setErrors({});
    // Só ao abrir: mudar os iniciais com o diálogo aberto não apaga o que foi digitado.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function alterarAbertura(nextOpen: boolean) {
    if (!salvando) onOpenChange(nextOpen);
  }

  async function salvar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrors({});
    setSalvando(true);

    try {
      const resultado = await adicionarContato({ nome, telefone });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["clientes-autocomplete"] }),
        // A tela Contatos lê `contatos_unificados`, que inclui os clientes
        // cadastrados aqui — sem isto ela só atualizava depois de um refresh.
        queryClient.invalidateQueries({ queryKey: ["contatos"] }),
      ]);
      toast.success(avisoCadastro(resultado, "Contato"));
      onOpenChange(false);
    } catch (error: unknown) {
      if (error instanceof AdicionarContatoValidationError) {
        setErrors(error.errors);
      } else {
        toast.error(error instanceof Error ? error.message : "Não foi possível salvar o contato.");
      }
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={alterarAbertura}>
      <DialogContent
        className="sm:max-w-md"
        onCloseAutoFocus={(event) => {
          if (!returnFocusRef?.current) return;
          event.preventDefault();
          returnFocusRef.current.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Adicionar contato</DialogTitle>
          <DialogDescription>
            Salve um nome e WhatsApp para encontrar esta pessoa ao iniciar um atendimento.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={salvar} noValidate>
          <div className="space-y-4">
            <div>
              <label
                htmlFor="adicionar-contato-nome"
                className="mb-1.5 block text-xs font-medium text-foreground"
              >
                Nome
              </label>
              <input
                id="adicionar-contato-nome"
                type="text"
                autoComplete="name"
                autoFocus
                value={nome}
                onChange={(event) => {
                  setNome(event.target.value);
                  setErrors((current) => ({ ...current, nome: undefined }));
                }}
                aria-required="true"
                aria-invalid={Boolean(errors.nome)}
                aria-describedby={errors.nome ? "adicionar-contato-nome-error" : undefined}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/20"
              />
              {errors.nome && (
                <p
                  id="adicionar-contato-nome-error"
                  role="alert"
                  className="mt-1.5 text-xs text-destructive"
                >
                  {errors.nome}
                </p>
              )}
            </div>

            <div>
              <label
                htmlFor="adicionar-contato-telefone"
                className="mb-1.5 block text-xs font-medium text-foreground"
              >
                WhatsApp
              </label>
              <input
                id="adicionar-contato-telefone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                value={telefone}
                onChange={(event) => {
                  setTelefone(event.target.value);
                  setErrors((current) => ({ ...current, telefone: undefined }));
                }}
                placeholder="(11) 99999-9999"
                aria-required="true"
                aria-invalid={Boolean(errors.telefone)}
                aria-describedby={errors.telefone ? "adicionar-contato-telefone-error" : undefined}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/20"
              />
              {errors.telefone && (
                <p
                  id="adicionar-contato-telefone-error"
                  role="alert"
                  className="mt-1.5 text-xs text-destructive"
                >
                  {errors.telefone}
                </p>
              )}
            </div>
          </div>

          <DialogFooter className="mt-6 gap-2 sm:gap-0">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              disabled={salvando}
              className="w-full rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50 sm:w-auto"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={salvando}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 sm:w-auto"
            >
              {salvando && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Salvar contato
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
