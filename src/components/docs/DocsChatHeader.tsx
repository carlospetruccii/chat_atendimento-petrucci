import { ArrowRightLeft, CheckCircle2, ChevronLeft, MoreVertical, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { initialsOf } from "@/lib/inbox-queries";
import {
  type AcoesConversa,
  classeStatus,
  type DocsConversa,
  rotuloStatus,
} from "@/lib/docs-logic";

interface Props {
  conversa: DocsConversa;
  meuUserId: string;
  acoes: AcoesConversa;
  assumindo: boolean;
  onVoltar: () => void;
  onAssumir: () => void;
  onRepassar: () => void;
  onEncerrar: () => void;
}

/**
 * Cabeçalho do chat do Docs: cliente, status, dono e as ações de ciclo
 * (Assumir / Repassar / Encerrar). Mesma disposição do cabeçalho da Inbox:
 * no celular Repassar/Encerrar colapsam no menu "⋮" e Assumir fica à vista.
 */
export function DocsChatHeader({
  conversa,
  meuUserId,
  acoes,
  assumindo,
  onVoltar,
  onAssumir,
  onRepassar,
  onEncerrar,
}: Props) {
  const dono =
    conversa.status === "em_andamento"
      ? conversa.assignedTo === meuUserId
        ? "com você"
        : `com ${conversa.assignedNome ?? "outra pessoa"}`
      : null;
  const temMenu = acoes.podeRepassar || acoes.podeEncerrar;

  return (
    <div className="flex items-center gap-3 border-b border-border bg-card px-3 py-2 sm:px-6 sm:py-3">
      {/* Só existe no celular: lista e conversa não convivem em tela estreita. */}
      <button
        type="button"
        onClick={onVoltar}
        aria-label="Voltar para a lista de conversas"
        className="touch-target-mobile -ml-1 inline-flex shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground md:hidden"
      >
        <ChevronLeft className="h-5 w-5" strokeWidth={1.8} />
      </button>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-medium text-primary">
          {initialsOf(conversa.clientNome) || "?"}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 truncate text-sm font-medium text-foreground">
              {conversa.clientNome}
            </span>
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${classeStatus(conversa.status)}`}
            >
              {rotuloStatus(conversa.status)}
            </span>
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {conversa.clientNumero}
            {dono ? ` · ${dono}` : ""}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {acoes.podeAssumir && (
          <Button
            // O rótulo some abaixo de sm: sem aria-label o leitor de tela diria só "botão".
            aria-label="Assumir conversa"
            size="sm"
            onClick={onAssumir}
            disabled={assumindo}
            className="rounded-2xl bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <UserPlus className="h-4 w-4" strokeWidth={1.5} />
            <span className="hidden sm:inline">Assumir</span>
          </Button>
        )}
        <div className="hidden items-center gap-2 md:flex">
          {acoes.podeRepassar && (
            <Button variant="outline" size="sm" onClick={onRepassar} className="rounded-2xl">
              <ArrowRightLeft className="h-4 w-4" strokeWidth={1.5} />
              Repassar
            </Button>
          )}
          {acoes.podeEncerrar && (
            <Button variant="outline" size="sm" onClick={onEncerrar} className="rounded-2xl">
              <CheckCircle2 className="h-4 w-4" strokeWidth={1.5} />
              Encerrar
            </Button>
          )}
        </div>
        {temMenu && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Mais ações da conversa"
                className="touch-target-mobile inline-flex items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground md:hidden"
              >
                <MoreVertical className="h-5 w-5" strokeWidth={1.8} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {acoes.podeRepassar && (
                <DropdownMenuItem onSelect={onRepassar}>
                  <ArrowRightLeft className="h-4 w-4" strokeWidth={1.5} />
                  Repassar
                </DropdownMenuItem>
              )}
              {acoes.podeEncerrar && (
                <DropdownMenuItem onSelect={onEncerrar}>
                  <CheckCircle2 className="h-4 w-4" strokeWidth={1.5} />
                  Encerrar
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}
