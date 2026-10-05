import { ChevronRight, List } from "lucide-react";
import type { InboxMessage } from "@/lib/inbox-queries";

interface OpcaoLista {
  id?: string;
  title: string;
  description?: string;
}

interface ListaOpcoesMeta {
  kind?: string;
  titulo?: string;
  button_label?: string;
  opcoes?: OpcaoLista[];
}

export function ListaOpcoesPreview({ message }: { message: InboxMessage }) {
  const meta = (message.mediaMetadata ?? {}) as ListaOpcoesMeta;
  const buttonLabel = meta.button_label ?? "Ver opções";
  const opcoes = Array.isArray(meta.opcoes) ? meta.opcoes : [];

  return (
    <div className="flex flex-col gap-2.5">
      {message.content && (
        <p className="whitespace-pre-wrap break-words leading-relaxed">
          {message.content}
        </p>
      )}

      {opcoes.length > 0 && (
        <div className="flex flex-col gap-0.5 pt-2 border-t border-current/10">
          {opcoes.map((o, i) => (
            <div
              key={o.id ?? `${i}-${o.title}`}
              className="flex items-start gap-2 py-1"
            >
              <span className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-50" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium leading-snug truncate">
                  {o.title}
                </p>
                {o.description && (
                  <p className="text-xs opacity-60 leading-snug truncate">
                    {o.description}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        disabled
        className="-mx-3 -mb-2 mt-1 flex items-center justify-center gap-2 border-t border-current/10 px-3 py-2.5 text-sm font-medium opacity-90 cursor-default"
      >
        <List className="h-4 w-4 shrink-0" strokeWidth={2.25} />
        {/* min-w-0 + break-anywhere: button_label vem de fora (configurado no
            fluxo do WhatsApp); se alguém colar algo comprido e sem espaço ali,
            isso não pode esticar a bolha do chat. */}
        <span className="min-w-0 break-anywhere">{buttonLabel}</span>
        <ChevronRight className="h-4 w-4 shrink-0 opacity-60" strokeWidth={2.25} />
      </button>

      <span className="-mb-1 inline-flex w-fit items-center gap-1 rounded-full bg-current/10 px-2 py-0.5 text-[10px] font-medium opacity-70">
        Lista interativa
      </span>
    </div>
  );
}
