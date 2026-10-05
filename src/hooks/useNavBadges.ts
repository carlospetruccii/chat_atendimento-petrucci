import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/useCurrentUser";

/**
 * Contadores dos badges da navegação principal.
 *
 * Mora num hook porque a régua lateral (desktop) e a barra inferior (celular)
 * ficam as duas montadas — só uma aparece, escondida por CSS, para não haver
 * "pulo" na hidratação. As chaves do React Query são iguais nas duas, então as
 * três RPCs saem uma vez só e as duas leem o mesmo cache.
 */
export interface NavBadges {
  pendentes: number;
  inbox: number;
}

export function useNavBadges(): NavBadges {
  const { user } = useCurrentUser();

  const pendentesQ = useQuery({
    queryKey: ["pendentes-count"],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("atendimentos")
        .select("*", { head: true, count: "exact" })
        .in("status", ["pendente", "em_triagem"])
        .is("assigned_to", null);
      if (error) throw error;
      return count ?? 0;
    },
    refetchInterval: 30_000,
  });

  // O badge do Inbox soma as três abas (Chat + Grupos + Equipe), que é o que o
  // usuário vê ao entrar na tela. São três RPCs porque grupo e conversa interna
  // moram em tabelas separadas.
  const inboxQ = useQuery({
    queryKey: ["inbox-unread-total"],
    queryFn: async () => {
      const [individual, grupos, equipe] = await Promise.all([
        supabase.rpc("get_my_inbox_unread_total"),
        supabase.rpc("get_my_grupos_unread_total"),
        supabase.rpc("get_my_internas_unread_total"),
      ]);
      if (individual.error) throw individual.error;
      if (grupos.error) throw grupos.error;
      if (equipe.error) throw equipe.error;
      return (individual.data ?? 0) + (grupos.data ?? 0) + (equipe.data ?? 0);
    },
    enabled: !!user,
    refetchInterval: 30_000,
  });

  return {
    pendentes: pendentesQ.data ?? 0,
    inbox: inboxQ.data ?? 0,
  };
}
