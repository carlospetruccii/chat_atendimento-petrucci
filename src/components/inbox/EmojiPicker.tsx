import { useMemo, useState } from "react";
import { Search, Smile } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  adicionarRecente,
  buscarEmojis,
  CATEGORIAS_EMOJI,
  lerRecentes,
  salvarRecentes,
  type EmojiItem,
} from "@/lib/emoji";

interface Props {
  disabled?: boolean;
  /** Recebe o caractere escolhido; o composer o insere no cursor. */
  onPick: (char: string) => void;
}

/**
 * Seletor de emoji do composer. Serve as três abas do Inbox (Chat, Grupos,
 * Equipe), porque as três usam o mesmo `RichMessageComposer`.
 *
 * Fica ABERTO ao escolher: mandar "🎉🎉🎉" ou montar uma sequência é comum, e
 * reabrir o popover a cada caractere seria uma briga com o usuário. Fecha só no
 * clique fora, no Esc ou no próprio botão.
 *
 * Para isso o `onFocusOutside` é neutralizado: escolher um emoji chama
 * `insertText`, que devolve o foco ao campo de texto — e o campo está FORA do
 * popover, então o Radix interpretava como "o foco saiu" e fechava sozinho. O
 * clique fora continua fechando, porque quem cuida disso é
 * `onPointerDownOutside`, que segue intacto.
 */
export function EmojiPicker({ disabled, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const [termo, setTermo] = useState("");
  const [categoriaId, setCategoriaId] = useState(CATEGORIAS_EMOJI[0].id);
  // Lido de forma preguiçosa: localStorage não existe no SSR.
  const [recentes, setRecentes] = useState<string[]>(() => lerRecentes());

  const buscando = termo.trim().length > 0;
  const resultados = useMemo(() => (buscando ? buscarEmojis(termo) : []), [termo, buscando]);

  const categoria = CATEGORIAS_EMOJI.find((c) => c.id === categoriaId) ?? CATEGORIAS_EMOJI[0];

  const escolher = (char: string) => {
    onPick(char);
    const novos = adicionarRecente(recentes, char);
    setRecentes(novos);
    salvarRecentes(novos);
  };

  const grade = (itens: readonly EmojiItem[] | readonly string[], chave: string) => (
    <div className="grid grid-cols-8 gap-0.5">
      {itens.map((item, i) => {
        const char = typeof item === "string" ? item : item.char;
        return (
          <button
            key={`${chave}-${char}-${i}`}
            type="button"
            onClick={() => escolher(char)}
            className="flex h-8 w-8 items-center justify-center rounded text-xl leading-none transition-transform hover:scale-110 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            aria-label={typeof item === "string" ? char : (item.termos[0] ?? char)}
          >
            {char}
          </button>
        );
      })}
    </div>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          aria-label="Inserir emoji"
          title="Emoji"
        >
          <Smile className="h-5 w-5" strokeWidth={1.5} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        className="w-[320px] p-2"
        // Sem isto o popover se fecha sozinho no primeiro emoji: `insertText`
        // devolve o foco ao composer, que está fora deste conteúdo.
        onFocusOutside={(event) => event.preventDefault()}
      >
        <div className="relative mb-2">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            strokeWidth={1.8}
          />
          <input
            value={termo}
            onChange={(ev) => setTermo(ev.target.value)}
            type="text"
            placeholder="Buscar emoji..."
            className="w-full rounded-md border border-border bg-card py-1.5 pl-8 pr-2 text-sm outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>

        {!buscando && (
          <div
            role="tablist"
            aria-label="Categorias de emoji"
            className="mb-2 flex gap-0.5 border-b border-border pb-2"
          >
            {CATEGORIAS_EMOJI.map((c) => (
              <button
                key={c.id}
                role="tab"
                aria-selected={c.id === categoriaId}
                onClick={() => setCategoriaId(c.id)}
                title={c.label}
                className={`flex h-7 w-7 items-center justify-center rounded text-base leading-none transition-colors ${
                  c.id === categoriaId ? "bg-muted" : "hover:bg-muted/60"
                }`}
              >
                {c.icone}
              </button>
            ))}
          </div>
        )}

        <div className="max-h-[220px] overflow-y-auto">
          {buscando ? (
            resultados.length > 0 ? (
              grade(resultados, "busca")
            ) : (
              <p className="py-8 text-center text-xs text-muted-foreground">
                Nenhum emoji para “{termo.trim()}”.
              </p>
            )
          ) : (
            <>
              {recentes.length > 0 && categoriaId === CATEGORIAS_EMOJI[0].id && (
                <div className="mb-2">
                  <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                    Recentes
                  </p>
                  {grade(recentes, "recentes")}
                </div>
              )}
              <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                {categoria.label}
              </p>
              {grade(categoria.emojis, categoria.id)}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
