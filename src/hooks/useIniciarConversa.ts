import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { iniciarConversa, type IniciarConversaInput } from "@/lib/iniciar-conversa";

/**
 * "Conversar" com um número: abre o atendimento na hora, atribuído a quem
 * clicou, e leva para o Inbox com a conversa aberta. Os avisos (já existe,
 * está com outra pessoa, erro) saem por toast.
 */
export function useIniciarConversa() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useCurrentUser();
  const canViewAll =
    !!user && (user.isSuperadmin || user.permissions.includes("view_all_departments"));

  return async function iniciar(input: IniciarConversaInput): Promise<void> {
    try {
      const r = await iniciarConversa(input, { userId: user?.id ?? null, canViewAll });
      if (r.tipo === "ocupada") {
        toast.error(`Já está em atendimento com ${r.responsavel} (${r.departamento}).`);
        return;
      }
      if (r.jaExistia) {
        toast.info("Este cliente já tem um atendimento aberto. Abrindo a conversa.");
      } else {
        toast.success("Atendimento iniciado");
        void qc.invalidateQueries({ queryKey: ["inbox", "conversations"] });
      }
      void navigate({ to: "/inbox", search: { conversation: r.atendimentoId } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao iniciar a conversa.");
    }
  };
}
