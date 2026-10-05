import { MessageCircle, MessagesSquare, Users } from "lucide-react";

export type InboxAba = "chat" | "grupos" | "equipe";

interface Props {
  aba: InboxAba;
  chatUnread: number;
  gruposUnread: number;
  equipeUnread: number;
  onChange: (aba: InboxAba) => void;
}

/**
 * Alternador Chat | Grupos | Equipe da Inbox. São três mundos separados:
 * "Chat" são os atendimentos individuais (com triagem, bot, departamento);
 * "Grupos" são conversas de grupo do WhatsApp, sem nenhuma automação;
 * "Equipe" é o chat interno entre colaboradores, que não passa pelo WhatsApp.
 */
export function InboxTabs({ aba, chatUnread, gruposUnread, equipeUnread, onChange }: Props) {
  const abas: { id: InboxAba; label: string; unread: number; Icon: typeof MessageCircle }[] = [
    { id: "chat", label: "Chat", unread: chatUnread, Icon: MessageCircle },
    { id: "grupos", label: "Grupos", unread: gruposUnread, Icon: Users },
    { id: "equipe", label: "Equipe", unread: equipeUnread, Icon: MessagesSquare },
  ];

  return (
    <div
      role="tablist"
      aria-label="Tipo de conversa"
      className="flex gap-1 rounded-full bg-muted p-1"
    >
      {abas.map(({ id, label, unread, Icon }) => {
        const ativa = aba === id;
        return (
          <button
            key={id}
            role="tab"
            aria-selected={ativa}
            onClick={() => onChange(id)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-full px-2 py-1.5 text-sm font-medium transition-all duration-200 active:scale-95 ${
              ativa
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:bg-card/60 hover:text-foreground hover:shadow-sm"
            }`}
          >
            <Icon className="h-4 w-4" strokeWidth={1.8} />
            {label}
            {unread > 0 && (
              <span className="badge-counter flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none">
                {unread}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
