import { useEffect, useRef } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser, type CurrentUserProfile } from "@/hooks/useCurrentUser";
import {
  isDocumentVisible,
  playMessageSound,
  playPendingSound,
  requestNotificationPermission,
  showBrowserNotification,
  unlockAudio,
} from "@/lib/notifications";
import { deveNotificarDocs, podeAcessarDocs } from "@/lib/docs-logic";
import { fetchDocsConversaInfo } from "@/lib/docs-queries";

// Componente invisível: mora no layout autenticado e escuta o realtime
// globalmente para tocar sons/mostrar notificações estilo WhatsApp Web.
//
// Regras:
//  - Mensagem nova (inbound) numa conversa MINHA (assigned_to = eu):
//      toca som de mensagem sempre; mostra notificação só se eu NÃO estiver
//      olhando aquela conversa no momento.
//  - Pendência nova (status pendente/em_triagem, sem responsável):
//      toca som de pendência; admin ouve de todos os departamentos,
//      colaborador só do seu. Notificação some se eu já estou na tela de
//      Pendentes.
//  - Docs (número financeiro), só para quem tem acesso à aba: cliente escreveu
//      numa conversa SEM DONO → todo mundo com acesso ouve; EM ANDAMENTO → só
//      o dono. Mesma regra de "não notificar a conversa que estou olhando".

interface AtendimentoInfo {
  departmentId: string | null;
  assignedTo: string | null;
  clientNome: string;
}

async function fetchAtendimentoInfo(atendimentoId: string): Promise<AtendimentoInfo | null> {
  const { data, error } = await supabase
    .from("atendimentos")
    .select(
      "current_department_id, assigned_to, client:clients!atendimentos_client_id_fkey ( nome, numero_whatsapp )",
    )
    .eq("id", atendimentoId)
    .maybeSingle();
  if (error || !data) return null;
  const client = data.client as { nome: string | null; numero_whatsapp: string } | null;
  return {
    departmentId: data.current_department_id ?? null,
    assignedTo: data.assigned_to ?? null,
    clientNome: client?.nome || client?.numero_whatsapp || "Cliente",
  };
}

function messagePreview(content: string | null, tipo: string | null): string {
  if (content && content.trim()) return content.trim();
  switch (tipo) {
    case "imagem":
      return "📷 Imagem";
    case "audio":
      return "🎤 Áudio";
    case "video":
      return "🎥 Vídeo";
    case "documento":
      return "📎 Documento";
    case "localizacao":
      return "📍 Localização";
    case "contato":
      return "👤 Contato";
    default:
      return "Nova mensagem";
  }
}

export function NotificationsManager() {
  const { user } = useCurrentUser();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const location = useRouterState({ select: (s) => s.location });

  // Estado "vivo" lido dentro dos callbacks do canal (que são criados uma vez).
  const stateRef = useRef<{
    user: CurrentUserProfile | null;
    pathname: string;
    conversation: string | null;
    /** ?conversa= da aba Docs. */
    conversaDocs: string | null;
  }>({ user, pathname: location.pathname, conversation: null, conversaDocs: null });
  stateRef.current = {
    user,
    pathname: location.pathname,
    conversation: (location.search as { conversation?: string } | undefined)?.conversation ?? null,
    conversaDocs: (location.search as { conversa?: string } | undefined)?.conversa ?? null,
  };

  // Muda quando um admin libera/tira o acesso: o canal é refeito com ou sem Docs.
  const temDocs = podeAcessarDocs(user);

  // Pendências já avisadas (para não repetir a cada UPDATE do atendimento).
  const notifiedPending = useRef<Set<string>>(new Set());

  // Destrava o áudio e pede permissão de notificação no primeiro gesto.
  useEffect(() => {
    if (typeof window === "undefined") return;
    let done = false;
    const onGesture = () => {
      if (done) return;
      done = true;
      unlockAudio();
      requestNotificationPermission();
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
    };
    window.addEventListener("pointerdown", onGesture);
    window.addEventListener("keydown", onGesture);
    return () => {
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
    };
  }, []);

  useEffect(() => {
    if (!user) return;

    const handleMessage = async (row: {
      id?: string;
      atendimento_id?: string;
      direction?: string;
      content?: string | null;
      tipo?: string | null;
    }) => {
      const me = stateRef.current.user;
      if (!me || !row?.atendimento_id) return;
      // Só mensagens recebidas de clientes — nunca o que nós enviamos.
      if (row.direction !== "inbound") return;

      const info = await fetchAtendimentoInfo(row.atendimento_id);
      if (!info) return;
      // Notificação de MENSAGEM é só das MINHAS conversas (as pendências, sem
      // responsável, são tratadas pelo som de pendência).
      if (info.assignedTo !== me.id) return;

      playMessageSound();

      const viewing =
        stateRef.current.pathname === "/inbox" &&
        stateRef.current.conversation === row.atendimento_id &&
        isDocumentVisible();
      if (!viewing) {
        showBrowserNotification(
          info.clientNome,
          messagePreview(row.content ?? null, row.tipo ?? null),
          `msg-${row.atendimento_id}`,
          () =>
            navigate({
              to: "/inbox",
              search: { conversation: row.atendimento_id },
            }),
        );
      }
    };

    const handleAtendimento = (row: {
      id?: string;
      status?: string;
      assigned_to?: string | null;
      current_department_id?: string | null;
    }) => {
      const me = stateRef.current.user;
      if (!me || !row?.id) return;
      const id = row.id;

      const isPending =
        (row.status === "pendente" || row.status === "em_triagem") && row.assigned_to == null;

      if (!isPending) {
        // Saiu da fila (atribuída/encerrada): libera para avisar de novo caso
        // volte a ficar pendente (ex.: liberada por timeout).
        notifiedPending.current.delete(id);
        return;
      }

      const deptId = row.current_department_id ?? null;
      const relevant = me.isSuperadmin || (!!deptId && deptId === me.departmentId);
      if (!relevant) return;
      if (notifiedPending.current.has(id)) return;
      notifiedPending.current.add(id);

      playPendingSound();

      const onPendentesScreen = stateRef.current.pathname === "/pendentes" && isDocumentVisible();
      if (!onPendentesScreen) {
        void fetchAtendimentoInfo(id).then((info) => {
          showBrowserNotification(
            "Nova pendência",
            `${info?.clientNome ?? "Um cliente"} aguardando atendimento`,
            `pend-${id}`,
            () => navigate({ to: "/pendentes" }),
          );
        });
      }
    };

    const handleDocsMessage = async (row: {
      conversa_id?: string;
      direction?: string;
      content?: string | null;
      tipo?: string | null;
    }) => {
      const me = stateRef.current.user;
      if (!me || !row?.conversa_id || row.direction !== "inbound") return;
      // Badge "Docs" do menu: fora da tela do Docs ninguém mais o recarrega.
      queryClient.invalidateQueries({ queryKey: ["docs-unread-total"] });
      // O gatilho do banco já moveu so_envio/encerrada → sem_dono na mesma
      // transação do INSERT, então o status lido aqui é o de depois.
      const info = await fetchDocsConversaInfo(row.conversa_id);
      if (!info) return;
      const avisar = deveNotificarDocs({
        direction: row.direction,
        status: info.status,
        assignedTo: info.assignedTo,
        meuUserId: me.id,
      });
      if (!avisar) return;

      playMessageSound();

      const viewing =
        stateRef.current.pathname === "/docs" &&
        stateRef.current.conversaDocs === row.conversa_id &&
        isDocumentVisible();
      if (!viewing) {
        showBrowserNotification(
          `Docs · ${info.clientNome}`,
          messagePreview(row.content ?? null, row.tipo ?? null),
          `docs-${row.conversa_id}`,
          () => navigate({ to: "/docs", search: { conversa: row.conversa_id } }),
        );
      }
    };

    const channel = supabase
      .channel("global-notifications")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "mensagens" },
        (payload) => {
          void handleMessage(payload.new as Parameters<typeof handleMessage>[0]);
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "atendimentos" },
        (payload) => {
          const row = (payload.new ?? payload.old) as Parameters<typeof handleAtendimento>[0];
          handleAtendimento(row);
        },
      );
    // A RLS já não entrega docs_mensagens a quem não tem acesso; nem assinar
    // evita um listener inútil para a maioria dos colaboradores.
    if (temDocs) {
      channel.on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "docs_mensagens" },
        (payload) => {
          void handleDocsMessage(payload.new as Parameters<typeof handleDocsMessage>[0]);
        },
      );
    }
    channel.subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, temDocs]);

  return null;
}
