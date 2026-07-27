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
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND,
  PASTE_COMMAND,
  type EditorState,
} from "lexical";
import { cn } from "@/lib/utils";
import { unescapeWhatsappMarkdown, WHATSAPP_TRANSFORMERS } from "@/lib/whatsapp-markdown-transformers";

export interface RichMessageComposerHandle {
  getMarkdownText: () => string;
  clear: () => void;
  focus: () => void;
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
    }),
    [editor],
  );

  return null;
}

function EnterSendPlugin({ onEnterSend }: { onEnterSend: () => void }): null {
  const [editor] = useLexicalComposerContext();
  const onEnterSendRef = useRef(onEnterSend);
  onEnterSendRef.current = onEnterSend;

  useEffect(() => {
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
  }, [editor]);

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
        <div className="relative flex-1">
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
