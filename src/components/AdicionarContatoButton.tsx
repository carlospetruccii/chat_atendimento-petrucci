import { useRef, useState } from "react";
import { UserPlus } from "lucide-react";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { AdicionarContatoDialog } from "@/components/AdicionarContatoDialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function AdicionarContatoButton() {
  const { user } = useCurrentUser();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Cadastro avulso de contato não expõe dado de ninguém (ver
  // cadastrar-cliente/logic.ts): qualquer colaborador autenticado pode.
  if (!user) return null;

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            ref={buttonRef}
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Adicionar contato"
            className="flex h-11 w-11 items-center justify-center rounded-xl border border-sidebar-border text-sidebar-foreground/70 transition-colors hover:bg-[color-mix(in_oklab,var(--wa-green)_10%,transparent)] hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
          >
            <UserPlus className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Adicionar contato</TooltipContent>
      </Tooltip>

      <AdicionarContatoDialog open={open} onOpenChange={setOpen} returnFocusRef={buttonRef} />
    </>
  );
}
