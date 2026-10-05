import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquarePlus } from "lucide-react";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { IniciarAtendimentoDialog } from "@/components/inbox/IniciarAtendimentoDialog";

/**
 * Ação principal "Iniciar atendimento" na barra lateral, logo acima do avatar.
 *
 * Por que fica aqui e não mais no topo da lista do Inbox: é a única ação de
 * *criação de conversa* do sistema. Na barra lateral ela fica alcançável de
 * qualquer lugar (Pendentes, Contatos, Dashboard) sem navegar primeiro.
 *
 * Desenho — a régua lateral é plana e monocromática, com os ícones de navegação
 * todos iguais. Para esta não ser "mais um ícone", ela se separa em três eixos,
 * de propósito:
 *   - FORMA: raio maior (2xl) que os itens de navegação (xl). Destino e ação são
 *     classes diferentes de coisa e devem ter silhuetas diferentes.
 *   - PROFUNDIDADE: é o único elemento preenchido e elevado do topo da barra —
 *     numa régua plana, a sombra sozinha já cria hierarquia sem precisar de cor
 *     nova. O gradiente usa os dois tokens de verde que já existem
 *     (--wa-green → --wa-green-hover), então acompanha o tema claro/escuro sem
 *     valor hardcoded.
 *   - MOVIMENTO: sobe 1px no hover e volta ao normal no clique — o botão
 *     "afunda" quando pressionado, dando resposta física. Só transform e
 *     box-shadow (compositor), e tudo desligado em prefers-reduced-motion.
 *
 * Um traço divide a navegação do bloco de baixo, para o rodapé da barra ler como
 * "ação · identidade" em vez de virar uma pilha de ícones sem hierarquia.
 */
export function NovoAtendimentoButton() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { user } = useCurrentUser();

  // Mesma regra do Inbox: só quem enxerga todos os departamentos escolhe
  // departamento/atendente na hora de abrir o atendimento.
  const canViewAll =
    !!user && (user.isSuperadmin || user.permissions.includes("view_all_departments"));

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Iniciar atendimento"
            className="group relative flex h-11 w-11 items-center justify-center rounded-2xl text-primary-foreground
                       shadow-[0_2px_10px_-2px_color-mix(in_oklab,var(--wa-green)_55%,transparent)]
                       transition-[transform,box-shadow] duration-200 ease-out
                       hover:-translate-y-px hover:shadow-[0_6px_18px_-4px_color-mix(in_oklab,var(--wa-green)_65%,transparent)]
                       active:translate-y-0 active:shadow-[0_1px_4px_-1px_color-mix(in_oklab,var(--wa-green)_50%,transparent)]
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar
                       motion-reduce:transition-none motion-reduce:hover:translate-y-0"
            style={{
              backgroundImage:
                "linear-gradient(140deg, var(--wa-green) 0%, var(--wa-green-hover) 100%)",
            }}
          >
            <MessageSquarePlus
              className="h-5 w-5 transition-transform duration-200 ease-out group-hover:scale-110 motion-reduce:transition-none motion-reduce:group-hover:scale-100"
              strokeWidth={1.9}
            />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Iniciar atendimento</TooltipContent>
      </Tooltip>

      <IniciarAtendimentoDialog
        open={open}
        onOpenChange={setOpen}
        canChooseDept={canViewAll}
        onCreated={(atendimentoId) => {
          setOpen(false);
          // A ação pode ser disparada de qualquer tela, então leva para o Inbox
          // com a conversa já aberta (a rota lê ?conversation= e seleciona).
          void navigate({
            to: "/inbox",
            search: { conversation: atendimentoId },
          });
        }}
      />
    </>
  );
}
