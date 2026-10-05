import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type Ref,
} from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $convertToMarkdownString } from "@lexical/markdown";
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND,
  PASTE_COMMAND,
  type EditorState,
} from "lexical";
import { useHasSoftKeyboard } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import {
  unescapeWhatsappMarkdown,
  WHATSAPP_TRANSFORMERS,
} from "@/lib/whatsapp-markdown-transformers";

export interface RichMessageComposerHandle {
  getMarkdownText: () => string;
  clear: () => void;
  focus: () => void;
  /** Insere texto na posição do cursor (usado pelo seletor de emoji). */
  insertText: (text: string) => void;
}

export interface RichMessageComposerProps {
  placeholder: string;
  disabled?: boolean;
  onHasContentChange: (hasContent: boolean) => void;
  onPasteImage: (event: ClipboardEvent) => void;
  onEnterSend: () => void;
}

function onError(error: Error): never {
  throw error;
}

function ImperativeHandlePlugin({
  handleRef,
}: {
  handleRef: Ref<RichMessageComposerHandle>;
}): null {
  const [editor] = useLexicalComposerContext();

  useImperativeHandle(
    handleRef,
    () => ({
      getMarkdownText: () => {
        let markdown = "";
        editor.getEditorState().read(() => {
          markdown = unescapeWhatsappMarkdown($convertToMarkdownString(WHATSAPP_TRANSFORMERS));
        });
        return markdown;
      },
      clear: () => {
        editor.update(() => {
          $getRoot().clear();
        });
      },
      focus: () => {
        editor.focus();
      },
      insertText: (text: string) => {
        editor.update(() => {
          let selection = $getSelection();
          // Sem seleção de intervalo (o editor nunca recebeu foco, ou o foco
          // está no botão do seletor): posiciona no fim antes de inserir, senão
          // o emoji seria descartado silenciosamente.
          if (!$isRangeSelection(selection)) {
            $getRoot().selectEnd();
            selection = $getSelection();
          }
          if ($isRangeSelection(selection)) selection.insertText(text);
        });
        // Devolve o cursor ao texto para a pessoa continuar escrevendo.
        editor.focus();
      },
    }),
    [editor],
  );

  return null;
}

function EnterSendPlugin({ onEnterSend }: { onEnterSend: () => void }): null {
  const [editor] = useLexicalComposerContext();
  const hasSoftKeyboard = useHasSoftKeyboard();
  const onEnterSendRef = useRef(onEnterSend);
  onEnterSendRef.current = onEnterSend;

  useEffect(() => {
    // No celular o Enter do teclado de tela é a tecla de pular linha, e não há
    // Shift+Enter: se ele enviasse, ninguém conseguiria escrever um segundo
    // parágrafo. Ali o envio é só pelo botão.
    if (hasSoftKeyboard) return;

    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (event?.shiftKey) return false;
        event?.preventDefault();
        onEnterSendRef.current();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, hasSoftKeyboard]);

  return null;
}

function PasteImagePlugin({
  onPasteImage,
}: {
  onPasteImage: (event: ClipboardEvent) => void;
}): null {
  const [editor] = useLexicalComposerContext();
  const onPasteImageRef = useRef(onPasteImage);
  onPasteImageRef.current = onPasteImage;

  useEffect(() => {
    return editor.registerCommand(
      PASTE_COMMAND,
      (event) => {
        if (!(event instanceof ClipboardEvent) || !event.clipboardData) return false;
        const hasImage = Array.from(event.clipboardData.items).some((item) =>
          item.type.startsWith("image/"),
        );
        if (!hasImage) return false;
        event.preventDefault();
        onPasteImageRef.current(event);
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor]);

  return null;
}

function HasContentPlugin({
  onHasContentChange,
}: {
  onHasContentChange: (hasContent: boolean) => void;
}) {
  const onHasContentChangeRef = useRef(onHasContentChange);
  onHasContentChangeRef.current = onHasContentChange;

  const handleChange = useCallback((editorState: EditorState) => {
    editorState.read(() => {
      onHasContentChangeRef.current($getRoot().getTextContent().trim().length > 0);
    });
  }, []);

  return <OnChangePlugin onChange={handleChange} />;
}

function EditablePlugin({ disabled }: { disabled?: boolean }): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    editor.setEditable(!disabled);
  }, [editor, disabled]);

  return null;
}

export const RichMessageComposer = forwardRef<RichMessageComposerHandle, RichMessageComposerProps>(
  function RichMessageComposer(
    { placeholder, disabled, onHasContentChange, onPasteImage, onEnterSend },
    ref,
  ) {
    const initialConfig = {
      namespace: "InboxComposer",
      onError,
    };

    // Este elemento PRECISA ser memoizado. Recriá-lo a cada render faz o React
    // trocar a identidade do ref interno do ContentEditable, e o Lexical então
    // desconecta e reconecta a raiz no DOM (setRootElement) — perdendo a
    // posição do cursor. O sintoma era a primeira letra digitada ir parar no
    // fim do texto ("porque" virava "orquep"), justamente porque a primeira
    // tecla é a única que muda `hasContent` e re-renderiza o pai.
    const contentEditableEl = useMemo(
      () => (
        <ContentEditable
          // Corretor ortográfico nativo do navegador em pt-BR (sublinha erros
          // e sugere correção no clique direito, como o Gboard).
          spellCheck
          lang="pt-BR"
          // Pede ao teclado de tela a tecla de "pular linha" em vez de
          // "enviar" — o envio mora no botão ao lado.
          enterKeyHint="enter"
          aria-placeholder={placeholder}
          placeholder={
            <div className="pointer-events-none absolute inset-0 text-sm text-muted-foreground">
              {placeholder}
            </div>
          }
          className={cn(
            "max-h-40 min-h-[1.5rem] overflow-y-auto whitespace-pre-wrap break-words text-sm outline-none",
            disabled && "opacity-50",
          )}
        />
      ),
      [placeholder, disabled],
    );

    return (
      <LexicalComposer initialConfig={initialConfig}>
        {/* min-w-0: sem isso colar uma URL longa sem espaços no campo empurra
            a barra do compositor inteira (anexo/emoji/mic/enviar) para fora da
            tela no celular — o item flex se recusa a encolher abaixo do
            "conteúdo mínimo" por padrão, mesmo com `break-words` no editor. */}
        <div className="relative min-w-0 flex-1">
          <PlainTextPlugin
            contentEditable={contentEditableEl}
            ErrorBoundary={LexicalErrorBoundary}
          />
        </div>
        <HistoryPlugin />
        <MarkdownShortcutPlugin transformers={WHATSAPP_TRANSFORMERS} />
        <HasContentPlugin onHasContentChange={onHasContentChange} />
        <EnterSendPlugin onEnterSend={onEnterSend} />
        <PasteImagePlugin onPasteImage={onPasteImage} />
        <EditablePlugin disabled={disabled} />
        <ImperativeHandlePlugin handleRef={ref} />
      </LexicalComposer>
    );
  },
);
