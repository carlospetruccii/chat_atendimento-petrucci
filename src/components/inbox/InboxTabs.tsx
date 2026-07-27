import { MessageCircle, Users } from "lucide-react";

export type InboxAba = "chat" | "grupos";

interface Props {
  aba: InboxAba;
  chatUnread: number;
  gruposUnread: number;
  onChange: (aba: InboxAba) => void;
}

/**
 * Alternador Chat | Grupos da Inbox. São dois mundos separados: "Chat" são os
 * atendimentos individuais (com triagem, bot, departamento); "Grupos" são
 * conversas de grupo, sem nenhuma automação.
 */
export function InboxTabs({ aba, chatUnread, gruposUnread, onChange }: Props) {
  const abas: { id: InboxAba; label: string; unread: number; Icon: typeof MessageCircle }[] = [
    { id: "chat", label: "Chat", unread: chatUnread, Icon: MessageCircle },
    { id: "grupos", label: "Grupos", unread: gruposUnread, Icon: Users },
  ];

  return (
    <div
      role="tablist"
      aria-label="Tipo de conversa"
      className="flex gap-1 rounded-md bg-muted p-1"
    >
      {abas.map(({ id, label, unread, Icon }) => {
        const ativa = aba === id;
        return (
          <button
            key={id}
            role="tab"
            aria-selected={ativa}
            onClick={() => onChange(id)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 text-sm font-medium transition-colors ${
              ativa
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
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
