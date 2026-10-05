import { useState } from "react";
import { Loader2, MessageCirclePlus, UserPlus, UserRound } from "lucide-react";
import { AdicionarContatoDialog } from "@/components/AdicionarContatoDialog";
import { useIniciarConversa } from "@/hooks/useIniciarConversa";
import { formatarNumero } from "@/lib/phone";
import { lerVcard } from "@/lib/vcard";

/**
 * Cartão de contato recebido no WhatsApp, com as duas ações que fazem sentido
 * para ele: abrir conversa com a pessoa ou salvá-la nos contatos do sistema.
 * Se o cartão trouxer mais de um número, as ações usam o primeiro.
 */
export function MediaContato({
  vcard,
  nomeExibicao,
}: {
  vcard: string | null;
  nomeExibicao: string | null;
}) {
  const { nome, telefones } = lerVcard(vcard, nomeExibicao);
  const telefone = telefones[0] ?? null;
  const iniciarConversa = useIniciarConversa();
  const [iniciando, setIniciando] = useState(false);
  const [salvarAberto, setSalvarAberto] = useState(false);

  async function conversar() {
    if (!telefone || iniciando) return;
    setIniciando(true);
    try {
      // O nome do cartão é só o rótulo de quem enviou: se o número já é
      // cliente, o nome cadastrado fica como está.
      await iniciarConversa({
        nome: nome ?? telefone,
        numero: telefone,
        manterNomeExistente: true,
      });
    } finally {
      setIniciando(false);
    }
  }

  return (
    <div className="flex w-60 max-w-full flex-col">
      <div className="flex items-center gap-2.5 pb-2">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/10">
          <UserRound className="h-5 w-5 opacity-70" strokeWidth={1.75} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{nome ?? "Contato"}</p>
          <p className="truncate text-xs opacity-70">
            {telefones.length > 0
              ? telefones.map(formatarNumero).join(" · ")
              : "Sem número de WhatsApp"}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 border-t border-black/10 text-xs font-medium text-primary">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void conversar();
          }}
          disabled={!telefone || iniciando}
          className="flex items-center justify-center gap-1.5 py-2 hover:bg-black/5 disabled:opacity-40"
        >
          {iniciando ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <MessageCirclePlus className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          Conversar
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setSalvarAberto(true);
          }}
          disabled={!telefone}
          className="flex items-center justify-center gap-1.5 border-l border-black/10 py-2 hover:bg-black/5 disabled:opacity-40"
        >
          <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />
          Salvar contato
        </button>
      </div>

      {/* O diálogo vai num portal, mas o clique ainda sobe pela árvore do React
          até a linha da mensagem (que no modo seleção marca/desmarca). */}
      <div className="contents" onClick={(e) => e.stopPropagation()}>
        <AdicionarContatoDialog
          open={salvarAberto}
          onOpenChange={setSalvarAberto}
          initialNome={nome ?? ""}
          initialTelefone={telefone ?? ""}
        />
      </div>
    </div>
  );
}
