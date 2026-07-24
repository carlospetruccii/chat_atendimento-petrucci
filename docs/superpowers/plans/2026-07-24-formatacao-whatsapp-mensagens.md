# Formatação estilo WhatsApp no Inbox — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bolhas de mensagem (enviada/recebida) renderizam a formatação real do WhatsApp (`*negrito*`, `_itálico_`, `~tachado~`, ```` ```monoespaçado``` ````) em vez do texto cru, e a caixa de digitação do inbox formata ao vivo (WYSIWYG) enquanto o atendente digita.

**Architecture:** Duas peças independentes. (1) `src/lib/whatsapp-format.tsx` — parser puro por regex (sem dependência nova) que troca `linkify.tsx` para renderizar os 4 marcadores + URLs nas bolhas. (2) `src/components/inbox/RichMessageComposer.tsx` — composer baseado em **Lexical** (`lexical` + `@lexical/react` + `@lexical/markdown`) substituindo o `<input>` puro; um array customizado de `Transformer`s (`src/lib/whatsapp-markdown-transformers.ts`) mapeia os 4 marcadores do WhatsApp para os format-flags nativos do Lexical (negrito/itálico/tachado/código).

**Tech Stack:** React 19, TanStack Start/Router, TypeScript 5.8, Vite, Tailwind, shadcn/ui. Testes: Vitest (novo — o projeto não tem infraestrutura de teste no frontend hoje).

## Global Constraints

- As 4 dependências do Lexical (`lexical`, `@lexical/react`, `@lexical/markdown`, `@lexical/headless`) devem ficar todas na **mesma versão exata** (ex.: `0.48.0`, sem `^`) — são um monorepo interligado e versões divergentes entre `lexical` core e os pacotes `@lexical/*` quebram em runtime.
- `@lexical/headless` é `devDependency` (só para testes, roda sem DOM).
- Nenhum arquivo novo deve dangerouslySetInnerHTML ou usar HTML cru — seguir o padrão já existente em `src/lib/linkify.tsx` (React nodes puros).
- Gerenciador de pacotes do projeto é `bun` (`bun.lock` presente) — usar `bun add`/`bun add -D`, não `npm`/`yarn`.
- Rodar `bun run build` (ou `tsc --noEmit` se preferir mais rápido) ao final de cada task que toca `.tsx`/`.ts` para garantir que o projeto ainda compila — não há hook de type-check automático configurado.

---

### Task 1: Parser de formatação WhatsApp para as bolhas + infraestrutura de testes

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json` (scripts + devDependencies)
- Create: `src/lib/whatsapp-format.tsx`
- Test: `src/lib/whatsapp-format.test.ts`
- Delete (ao final da Task 2, não agora): `src/lib/linkify.tsx`

**Interfaces:**
- Produces: `formatWhatsAppText(text: string | null | undefined): ReactNode[]` — exportada de `src/lib/whatsapp-format.tsx`. Task 2 consome essa função.

- [ ] **Step 1: Instalar Vitest**

```bash
bun add -D vitest
```

- [ ] **Step 2: Criar `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
```

- [ ] **Step 3: Adicionar script de teste no `package.json`**

No bloco `"scripts"` do `package.json`, adicionar:

```json
    "test": "vitest run"
```

(mantendo os scripts existentes `dev`, `build`, `build:dev`, `preview`, `lint`, `format` como estão, só acrescentando esta linha.)

- [ ] **Step 4: Escrever os testes (falhando) para `formatWhatsAppText`**

Criar `src/lib/whatsapp-format.test.ts`:

```ts
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { formatWhatsAppText } from "./whatsapp-format";

function renderedText(nodes: ReturnType<typeof formatWhatsAppText>): string {
  // Achata os ReactNode[] pra comparar só o texto visível, ignorando tags.
  return nodes
    .map((node) => {
      if (typeof node === "string") return node;
      if (node && typeof node === "object" && "props" in node) {
        const children = (node as { props: { children?: unknown } }).props.children;
        return typeof children === "string" ? children : "";
      }
      return "";
    })
    .join("");
}

describe("formatWhatsAppText", () => {
  it("retorna array vazio para texto nulo, indefinido ou vazio", () => {
    expect(formatWhatsAppText(null)).toEqual([]);
    expect(formatWhatsAppText(undefined)).toEqual([]);
    expect(formatWhatsAppText("")).toEqual([]);
  });

  it("mantém texto plano sem marcadores intacto", () => {
    const result = formatWhatsAppText("mensagem sem formatação nenhuma");
    expect(result).toEqual(["mensagem sem formatação nenhuma"]);
  });

  it("renderiza *negrito* como <strong>", () => {
    const result = formatWhatsAppText("oi *tudo bem*?");
    expect(result[0]).toBe("oi ");
    const strong = result[1] as ReactElement;
    expect(strong.type).toBe("strong");
    expect(strong.props.children).toBe("tudo bem");
    expect(result[2]).toBe("?");
  });

  it("renderiza _itálico_ como <em>", () => {
    const result = formatWhatsAppText("_urgente_");
    const em = result[0] as ReactElement;
    expect(em.type).toBe("em");
    expect(em.props.children).toBe("urgente");
  });

  it("renderiza ~tachado~ como <s>", () => {
    const result = formatWhatsAppText("~cancelado~");
    const s = result[0] as ReactElement;
    expect(s.type).toBe("s");
    expect(s.props.children).toBe("cancelado");
  });

  it("renderiza ```monoespaçado``` como <code>", () => {
    const result = formatWhatsAppText("```codigo_com_underscore```");
    const code = result[0] as ReactElement;
    expect(code.type).toBe("code");
    expect(code.props.children).toBe("codigo_com_underscore");
  });

  it("não formata quando há espaço colado ao marcador", () => {
    const result = formatWhatsAppText("* não bold *");
    expect(result).toEqual(["* não bold *"]);
  });

  it("marcador sem par de fechamento fica literal", () => {
    const result = formatWhatsAppText("preço: R$ 10 * 2 = R$ 20");
    expect(result).toEqual(["preço: R$ 10 * 2 = R$ 20"]);
  });

  it("combina múltiplos marcadores na mesma mensagem", () => {
    const result = formatWhatsAppText("oi *bold* e _italico_ e ~tachado~ tudo junto");
    expect(renderedText(result)).toBe("oi bold e italico e tachado tudo junto");
    expect((result[1] as ReactElement).type).toBe("strong");
    expect((result[3] as ReactElement).type).toBe("em");
    expect((result[5] as ReactElement).type).toBe("s");
  });

  it("linkifica URL e preserva formatação junto", () => {
    const result = formatWhatsAppText("olha isso: https://exemplo.com/pagina, *importante*");
    const link = result.find(
      (node) => typeof node === "object" && node !== null && (node as ReactElement).type === "a",
    ) as ReactElement;
    expect(link.props.href).toBe("https://exemplo.com/pagina");
  });

  it("remove pontuação final da URL mas mantém formatação depois", () => {
    const result = formatWhatsAppText("veja https://exemplo.com.");
    const link = result.find(
      (node) => typeof node === "object" && node !== null && (node as ReactElement).type === "a",
    ) as ReactElement;
    expect(link.props.href).toBe("https://exemplo.com");
    expect(result[result.length - 1]).toBe(".");
  });
});
```

- [ ] **Step 5: Rodar os testes e confirmar que falham**

Run: `bunx vitest run src/lib/whatsapp-format.test.ts`
Expected: FAIL — `Cannot find module './whatsapp-format'` (o arquivo ainda não existe).

- [ ] **Step 6: Implementar `src/lib/whatsapp-format.tsx`**

```tsx
import type { ReactNode } from "react";

// Ordem importa: monoespaçado primeiro (conteúdo não deve ser re-processado
// pelos outros marcadores), URL por último. `[^\s*]`/etc. no início e fim do
// grupo impedem que `* fica *` (espaço colado ao marcador) formate — mesma
// regra do WhatsApp real.
const TOKEN_REGEX =
  /```([^`]+)```|\*([^\s*](?:[^*]*[^\s*])?)\*|_([^\s_](?:[^_]*[^\s_])?)_|~([^\s~](?:[^~]*[^\s~])?)~|(https?:\/\/[^\s<>"']+)/g;
const TRAILING_PUNCTUATION_REGEX = /[.,;:!?)\]}'"]+$/;

function stripTrailingPunctuation(url: string): { url: string; trailing: string } {
  const match = url.match(TRAILING_PUNCTUATION_REGEX);
  if (!match) return { url, trailing: "" };
  return { url: url.slice(0, -match[0].length), trailing: match[0] };
}

/**
 * Renderiza texto com a formatação do WhatsApp (negrito/itálico/tachado/
 * monoespaçado) e URLs viráveis em link — sem dangerouslySetInnerHTML, sem
 * suporte a esquemas não-http. Marcador sem par de fechamento (ou com espaço
 * colado) fica literal, igual ao WhatsApp real.
 */
export function formatWhatsAppText(text: string | null | undefined): ReactNode[] {
  if (!text) return [];

  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  TOKEN_REGEX.lastIndex = 0;
  while ((match = TOKEN_REGEX.exec(text)) !== null) {
    const [full, mono, bold, italic, strike, url] = match;

    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    if (mono !== undefined) {
      parts.push(
        <code key={key++} className="rounded bg-black/10 px-1 py-0.5 font-mono text-[0.9em]">
          {mono}
        </code>,
      );
    } else if (bold !== undefined) {
      parts.push(<strong key={key++}>{bold}</strong>);
    } else if (italic !== undefined) {
      parts.push(<em key={key++}>{italic}</em>);
    } else if (strike !== undefined) {
      parts.push(<s key={key++}>{strike}</s>);
    } else if (url !== undefined) {
      const { url: cleanUrl, trailing } = stripTrailingPunctuation(url);
      if (cleanUrl) {
        parts.push(
          <a
            key={key++}
            href={cleanUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 break-all hover:opacity-80"
            onClick={(e) => e.stopPropagation()}
          >
            {cleanUrl}
          </a>,
        );
        if (trailing) parts.push(trailing);
      } else {
        parts.push(url);
      }
    }

    lastIndex = match.index + full.length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}
```

- [ ] **Step 7: Rodar os testes de novo e confirmar que passam**

Run: `bunx vitest run src/lib/whatsapp-format.test.ts`
Expected: PASS (12 testes).

- [ ] **Step 8: Commit**

```bash
git add vitest.config.ts package.json src/lib/whatsapp-format.tsx src/lib/whatsapp-format.test.ts
git commit -m "feat(inbox): adiciona parser de formatação WhatsApp para as bolhas de mensagem"
```

---

### Task 2: Ligar o parser nas bolhas de mensagem (inbox + supervisão)

**Files:**
- Modify: `src/routes/_app.inbox.tsx:19` (import), `src/routes/_app.inbox.tsx:775` (uso)
- Modify: `src/routes/_app.pendentes.tsx` (import + uso de `linkifyText`)
- Delete: `src/lib/linkify.tsx`

**Interfaces:**
- Consumes: `formatWhatsAppText(text: string | null | undefined): ReactNode[]` de `src/lib/whatsapp-format.tsx` (Task 1).

- [ ] **Step 1: Trocar o import em `_app.inbox.tsx`**

Em `src/routes/_app.inbox.tsx:19`, trocar:

```ts
import { linkifyText } from "@/lib/linkify";
```

por:

```ts
import { formatWhatsAppText } from "@/lib/whatsapp-format";
```

- [ ] **Step 2: Trocar o uso na bolha de mensagem**

Em `src/routes/_app.inbox.tsx:774-776`, trocar:

```tsx
                                <p className="whitespace-pre-wrap break-words">
                                  {linkifyText(m.content)}
                                </p>
```

por:

```tsx
                                <p className="whitespace-pre-wrap break-words">
                                  {formatWhatsAppText(m.content)}
                                </p>
```

- [ ] **Step 3: Trocar import e uso em `_app.pendentes.tsx`**

Localizar (via `grep -n "linkifyText" src/routes/_app.pendentes.tsx`) o import (linha 16) e o uso (linha 576) e aplicar a mesma troca:

```ts
import { formatWhatsAppText } from "@/lib/whatsapp-format";
```

```tsx
<p className="whitespace-pre-wrap break-words">{formatWhatsAppText(m.content)}</p>
```

- [ ] **Step 4: Confirmar que não sobrou nenhuma referência a `linkifyText`/`linkify`**

Run: `grep -rn "linkifyText\|from \"@/lib/linkify\"" src --include="*.tsx" --include="*.ts"`
Expected: nenhum resultado (0 linhas).

- [ ] **Step 5: Apagar o arquivo antigo**

```bash
rm src/lib/linkify.tsx
```

- [ ] **Step 6: Checar que o projeto compila**

Run: `bunx tsc --noEmit`
Expected: sem erros novos relacionados a `linkify`/`whatsapp-format`.

- [ ] **Step 7: QA manual (sem teste automatizado — é a página de rota completa)**

Rodar `bun run dev`, abrir o Inbox, abrir uma conversa com mensagens e confirmar visualmente:
- Uma mensagem antiga com `*algo*` no texto agora aparece em negrito (tanto enviada quanto recebida).
- Link ainda clica e abre em nova aba.
- Repetir na tela de supervisão/pendentes (rota `_app.pendentes`).

- [ ] **Step 8: Commit**

```bash
git add src/routes/_app.inbox.tsx src/routes/_app.pendentes.tsx
git rm src/lib/linkify.tsx
git commit -m "feat(inbox): renderiza formatação WhatsApp (negrito/itálico/etc.) nas bolhas de mensagem"
```

---

### Task 3: Transformers customizados do Lexical (mapeamento WhatsApp ↔ Lexical)

**Files:**
- Modify: `package.json` (dependencies + devDependencies)
- Create: `src/lib/whatsapp-markdown-transformers.ts`
- Test: `src/lib/whatsapp-markdown-transformers.test.ts`

**Interfaces:**
- Produces: `WHATSAPP_TRANSFORMERS: Transformer[]` e `unescapeWhatsappMarkdown(markdown: string): string`, ambos exportados de `src/lib/whatsapp-markdown-transformers.ts`. Task 4 (`RichMessageComposer.tsx`) consome os dois.

**Contexto importante (verificado direto no código-fonte do `@lexical/markdown@0.48.0`, não é suposição):**
- `TextFormatTransformer` = `{ format: TextFormatType[]; tag: string; intraword?: boolean; type: 'text-format' }`.
- No **export**, `exportTextFormat` (`MarkdownExport.ts`) trata `format: 'code'` como caso especial hardcoded: sempre usa cerca CommonMark de crase simples (`` ` ``), **ignorando** o campo `tag` do transformer. Não dá pra configurar isso para sair com crase tripla — por isso o monoespaçado do WhatsApp precisa de um `TextMatchTransformer` customizado que intercepta a exportação antes desse caminho.
- Ainda no export, `exportTextFormat` **escapa com barra invertida** qualquer `*`, `_`, `~`, `` ` ``, `\` que apareça como texto plano não-formatado (para não virar markdown sem querer num reimport). O WhatsApp não tem escape com barra invertida — se não desfizermos isso, uma mensagem como `"R$ 10 * 2"` sairia como `"R$ 10 \* 2"` de verdade pro cliente. Por isso `unescapeWhatsappMarkdown` existe e **é obrigatório** rodar depois de todo `$convertToMarkdownString`.
- No **import/digitação ao vivo**, `scanCodeSpans` (`importTextFormatTransformer.ts`) já trata qualquer corrida de crases de tamanho igual (1, 2, 3...) como cerca de código — não precisa de tag customizada pro lado da digitação, só precisa que **algum** transformer com tag `` ` `` (o `INLINE_CODE` embutido) esteja registrado pra "ligar" essa checagem.

- [ ] **Step 1: Instalar as dependências do Lexical**

```bash
bun add lexical@0.48.0 @lexical/react@0.48.0 @lexical/markdown@0.48.0
bun add -D @lexical/headless@0.48.0
```

- [ ] **Step 2: Escrever os testes (falhando)**

Criar `src/lib/whatsapp-markdown-transformers.test.ts`:

```ts
import { createHeadlessEditor } from "@lexical/headless";
import { $convertFromMarkdownString, $convertToMarkdownString } from "@lexical/markdown";
import { describe, expect, it } from "vitest";
import { unescapeWhatsappMarkdown, WHATSAPP_TRANSFORMERS } from "./whatsapp-markdown-transformers";

function roundTrip(markdown: string): string {
  const editor = createHeadlessEditor({
    onError: (error) => {
      throw error;
    },
  });

  editor.update(
    () => {
      $convertFromMarkdownString(markdown, WHATSAPP_TRANSFORMERS);
    },
    { discrete: true },
  );

  let result = "";
  editor.getEditorState().read(() => {
    result = unescapeWhatsappMarkdown($convertToMarkdownString(WHATSAPP_TRANSFORMERS));
  });
  return result;
}

describe("WHATSAPP_TRANSFORMERS", () => {
  it("mantém texto plano sem marcadores intacto", () => {
    expect(roundTrip("mensagem sem formatação nenhuma")).toBe("mensagem sem formatação nenhuma");
  });

  it("faz round-trip de *negrito*", () => {
    expect(roundTrip("oi *tudo bem*?")).toBe("oi *tudo bem*?");
  });

  it("faz round-trip de _itálico_", () => {
    expect(roundTrip("_urgente_")).toBe("_urgente_");
  });

  it("faz round-trip de ~tachado~", () => {
    expect(roundTrip("~cancelado~")).toBe("~cancelado~");
  });

  it("faz round-trip de monoespaçado com crase tripla", () => {
    expect(roundTrip("```codigo aqui```")).toBe("```codigo aqui```");
  });

  it("faz round-trip de uma frase combinando os 4 marcadores", () => {
    const input = "oi *bold* e _italico_ e ~tachado~ e ```mono``` tudo junto";
    expect(roundTrip(input)).toBe(input);
  });

  it("não formata (e não escapa de volta) marcador colado a espaço", () => {
    expect(roundTrip("* não bold *")).toBe("* não bold *");
  });

  it("não injeta barra invertida em preço com asterisco solto", () => {
    expect(roundTrip("preço: R$ 10 * 2 = R$ 20")).toBe("preço: R$ 10 * 2 = R$ 20");
  });

  it("não injeta barra invertida em texto com underscore solto", () => {
    expect(roundTrip("acesse nome_sobrenome@empresa.com")).toBe("acesse nome_sobrenome@empresa.com");
  });
});

describe("unescapeWhatsappMarkdown", () => {
  it("remove barra invertida de escape dos 4 caracteres marcadores e da própria barra", () => {
    expect(unescapeWhatsappMarkdown("preço: R\\$ 10 \\* 2")).toBe("preço: R\\$ 10 * 2");
    expect(unescapeWhatsappMarkdown("a\\_b")).toBe("a_b");
    expect(unescapeWhatsappMarkdown("a\\~b")).toBe("a~b");
    expect(unescapeWhatsappMarkdown("a\\`b")).toBe("a`b");
    expect(unescapeWhatsappMarkdown("a\\\\b")).toBe("a\\b");
  });

  it("não mexe em texto sem barra invertida", () => {
    expect(unescapeWhatsappMarkdown("texto normal")).toBe("texto normal");
  });
});
```

- [ ] **Step 3: Rodar os testes e confirmar que falham**

Run: `bunx vitest run src/lib/whatsapp-markdown-transformers.test.ts`
Expected: FAIL — `Cannot find module './whatsapp-markdown-transformers'`.

- [ ] **Step 4: Implementar `src/lib/whatsapp-markdown-transformers.ts`**

```ts
import { $isTextNode } from "lexical";
import {
  INLINE_CODE,
  type TextFormatTransformer,
  type TextMatchTransformer,
  type Transformer,
} from "@lexical/markdown";

const BOLD: TextFormatTransformer = {
  format: ["bold"],
  tag: "*",
  type: "text-format",
};

const ITALIC: TextFormatTransformer = {
  format: ["italic"],
  tag: "_",
  type: "text-format",
};

const STRIKETHROUGH: TextFormatTransformer = {
  format: ["strikethrough"],
  tag: "~",
  type: "text-format",
};

/**
 * `@lexical/markdown` exporta qualquer nó com format 'code' usando cerca
 * CommonMark de crase simples, hardcoded (ver exportTextFormat em
 * MarkdownExport.ts) — ignora o campo `tag` do transformer. Este
 * text-match transformer intercepta a exportação de nós com format 'code'
 * antes desse caminho, pra sair com a cerca tripla que o WhatsApp espera.
 * `regExp` nunca casa de propósito: este transformer não participa da
 * digitação ao vivo, só da exportação — quem trata a digitação é o
 * INLINE_CODE embutido (tag simples de crase), incluído abaixo.
 */
const MONOSPACE_EXPORT: TextMatchTransformer = {
  dependencies: [],
  export: (node) => {
    if (!$isTextNode(node) || !node.hasFormat("code")) return null;
    return "```" + node.getTextContent() + "```";
  },
  regExp: /(?!)/,
  type: "text-match",
};

export const WHATSAPP_TRANSFORMERS: Transformer[] = [
  MONOSPACE_EXPORT,
  INLINE_CODE,
  BOLD,
  ITALIC,
  STRIKETHROUGH,
];

/**
 * `$convertToMarkdownString` escapa `*_~\`\\` com barra invertida em texto
 * plano não-formatado, pra um reimport não interpretar sem querer. O
 * WhatsApp não tem esse escape — sem desfazer isso, um preço como
 * "R$ 10 * 2" sairia com barra invertida de verdade pro cliente.
 */
export function unescapeWhatsappMarkdown(markdown: string): string {
  return markdown.replace(/\\([*_~`\\])/g, "$1");
}
```

- [ ] **Step 5: Rodar os testes de novo e confirmar que passam**

Run: `bunx vitest run src/lib/whatsapp-markdown-transformers.test.ts`
Expected: PASS (11 testes).

- [ ] **Step 6: Rodar a suíte inteira**

Run: `bun run test`
Expected: todos os testes (Task 1 + Task 3) passam.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock src/lib/whatsapp-markdown-transformers.ts src/lib/whatsapp-markdown-transformers.test.ts
git commit -m "feat(inbox): adiciona transformers Lexical customizados para sintaxe WhatsApp"
```

---

### Task 4: Componente `RichMessageComposer`

**Files:**
- Create: `src/components/inbox/RichMessageComposer.tsx`

**Interfaces:**
- Consumes: `WHATSAPP_TRANSFORMERS`, `unescapeWhatsappMarkdown` de `src/lib/whatsapp-markdown-transformers.ts` (Task 3). `cn` de `@/lib/utils`.
- Produces:
  ```ts
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

  export const RichMessageComposer: React.ForwardRefExoticComponent<
    RichMessageComposerProps & React.RefAttributes<RichMessageComposerHandle>
  >;
  ```
  Task 5 consome esse componente e o tipo `RichMessageComposerHandle` via `useRef`.

Este componente é a camada fina de integração com o Lexical (a lógica de fato — parsing/serialização — já foi testada na Task 3). Não tem teste automatizado próprio: testar digitação real num `contentEditable` via jsdom é frágil e de baixo valor comparado ao QA manual da Task 5, que exercita o componente de verdade num browser real.

- [ ] **Step 1: Implementar `src/components/inbox/RichMessageComposer.tsx`**

```tsx
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
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
  function handleChange(editorState: EditorState) {
    editorState.read(() => {
      onHasContentChange($getRoot().getTextContent().trim().length > 0);
    });
  }

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

    return (
      <LexicalComposer initialConfig={initialConfig}>
        <div className="relative flex-1">
          <PlainTextPlugin
            contentEditable={
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
            }
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
```

- [ ] **Step 2: Checar que o projeto compila**

Run: `bunx tsc --noEmit`
Expected: sem erros em `RichMessageComposer.tsx`. Se der erro de tipo em algum import do Lexical (ex.: nome de export diferente), abrir o `.d.ts` correspondente em `node_modules/@lexical/react/dist/` ou `node_modules/lexical/dist/` pra confirmar o nome exato antes de ajustar.

- [ ] **Step 3: Commit**

```bash
git add src/components/inbox/RichMessageComposer.tsx
git commit -m "feat(inbox): adiciona RichMessageComposer com formatação WhatsApp ao vivo"
```

---

### Task 5: Ligar o `RichMessageComposer` no Inbox

**Files:**
- Modify: `src/routes/_app.inbox.tsx` (import, estado, `handleSend`, `handlePasteImage`, JSX da barra de digitação)

**Interfaces:**
- Consumes: `RichMessageComposer`, `RichMessageComposerHandle` de `src/components/inbox/RichMessageComposer.tsx` (Task 4).

- [ ] **Step 1: Trocar o import do `linkify`/adicionar o do composer**

Em `src/routes/_app.inbox.tsx`, no bloco de imports perto da linha 58, adicionar:

```ts
import {
  RichMessageComposer,
  type RichMessageComposerHandle,
} from "@/components/inbox/RichMessageComposer";
```

- [ ] **Step 2: Trocar o estado `draft` por `hasDraft` + ref do composer**

Em `src/routes/_app.inbox.tsx:115`, trocar:

```tsx
  const [draft, setDraft] = useState("");
```

por:

```tsx
  const [hasDraft, setHasDraft] = useState(false);
  const composerRef = useRef<RichMessageComposerHandle>(null);
```

- [ ] **Step 3: Reescrever `handleSend`**

Em `src/routes/_app.inbox.tsx:337-359`, trocar o corpo de `handleSend` inteiro por:

```tsx
  const handleSend = async () => {
    const content = composerRef.current?.getMarkdownText().trim() ?? "";
    if (!current || !content) return;
    setSending(true);
    try {
      await sendInboxMessage({
        atendimentoId: current.id,
        clientId: current.clientId,
        departmentId: current.departmentId,
        userId: user.id,
        content,
        replyToMessageId: replyTo?.id ?? null,
      });
      composerRef.current?.clear();
      setHasDraft(false);
      setReplyTo(null);
      requestAnimationFrame(() => {
        chat.scrollToBottom(true);
        composerRef.current?.focus();
      });
    } catch (e) {
      toast.error("Não foi possível enviar a mensagem.");
      console.error(e);
    } finally {
      setSending(false);
    }
  };
```

- [ ] **Step 4: Ajustar `handlePasteImage` para `ClipboardEvent` nativo**

Em `src/routes/_app.inbox.tsx:419-433`, trocar:

```tsx
  const handlePasteImage = (e: React.ClipboardEvent<HTMLInputElement>) => {
    if (sending) return;
    const item = Array.from(e.clipboardData.items).find((it) =>
      it.type.startsWith("image/"),
    );
    if (!item) return;
    const file = item.getAsFile();
    if (!file) return;
    e.preventDefault();
    if (file.size > MAX_ATTACHMENT_BYTES) {
      toast.error("Arquivo muito grande (máx 16 MB).");
      return;
    }
    handleAttachPick({ file, kind: "media" });
  };
```

por:

```tsx
  const handlePasteImage = (event: ClipboardEvent) => {
    if (sending) return;
    const item = Array.from(event.clipboardData?.items ?? []).find((it) =>
      it.type.startsWith("image/"),
    );
    if (!item) return;
    const file = item.getAsFile();
    if (!file) return;
    if (file.size > MAX_ATTACHMENT_BYTES) {
      toast.error("Arquivo muito grande (máx 16 MB).");
      return;
    }
    handleAttachPick({ file, kind: "media" });
  };
```

(`RichMessageComposer`'s `PasteImagePlugin` já confirma que há imagem e já chama `preventDefault` antes de invocar este callback — por isso não precisa mais fazer isso aqui.)

- [ ] **Step 5: Trocar o `<input>` pelo `<RichMessageComposer>`**

Em `src/routes/_app.inbox.tsx:875-889`, trocar:

```tsx
                      <input
                        type="text"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            handleSend();
                          }
                        }}
                        onPaste={handlePasteImage}
                        placeholder="Digite uma mensagem..."
                        className="flex-1 bg-transparent text-sm outline-none disabled:opacity-50"
                        disabled={sending}
                      />
```

por:

```tsx
                      <RichMessageComposer
                        ref={composerRef}
                        placeholder="Digite uma mensagem..."
                        disabled={sending}
                        onHasContentChange={setHasDraft}
                        onPasteImage={handlePasteImage}
                        onEnterSend={handleSend}
                      />
```

- [ ] **Step 6: Atualizar a condição de desabilitar o botão de enviar**

Em `src/routes/_app.inbox.tsx:900-901`, trocar:

```tsx
                        onClick={handleSend}
                        disabled={sending || !draft.trim()}
```

por:

```tsx
                        onClick={handleSend}
                        disabled={sending || !hasDraft}
```

- [ ] **Step 7: Confirmar que não sobrou nenhuma referência a `draft`**

Run: `grep -n "\bdraft\b" src/routes/_app.inbox.tsx`
Expected: nenhum resultado (0 linhas) — tudo virou `hasDraft`/`composerRef`.

- [ ] **Step 8: Checar que o projeto compila**

Run: `bunx tsc --noEmit`
Expected: sem erros.

- [ ] **Step 9: QA manual completo**

Rodar `bun run dev`, abrir o Inbox numa conversa atribuída, e verificar:
- Digitar `*negrito*` → os asteriscos somem e o texto vira negrito ao terminar de digitar o segundo `*`. Repetir para `_itálico_`, `~tachado~`, ```` ```mono``` ````.
- Enter (sem Shift) envia a mensagem; Shift+Enter quebra linha sem enviar.
- Mensagem enviada aparece na bolha com a formatação real (não com asteriscos).
- Colar uma imagem da área de transferência ainda abre o preview de mídia (não digita nada no composer).
- Colar texto copiado de um Google Doc/Word (com negrito/cor) cola só como texto plano, sem herdar formatação visual do documento de origem.
- Botão de enviar fica desabilitado com o composer vazio e habilita ao digitar.
- Responder mensagem (reply) continua funcionando, composer limpa e foca de volta após enviar.
- Testar com um atendimento em que o usuário não pode enviar (área desabilitada) — a barra de digitação nem aparece, sem regressão.

- [ ] **Step 10: Commit**

```bash
git add src/routes/_app.inbox.tsx
git commit -m "feat(inbox): liga o RichMessageComposer no lugar do input plano do composer"
```

---

## Notas finais / fora de escopo

- Não há harness de E2E (Playwright) neste projeto — o QA das Tasks 2 e 5 é manual, via `bun run dev`. Se o usuário quiser formalizar isso depois, é um passo separado (setup de Playwright + `e2e-runner` agent), não incluído aqui.
- Marcações aninhadas (`*_negrito e itálico_*`) não têm teste dedicado — o mecanismo do `@lexical/markdown` suporta aninhamento nativamente (é CommonMark padrão), mas não foi exercitado nos testes automatizados desta plan por estar fora do escopo combinado no spec.
