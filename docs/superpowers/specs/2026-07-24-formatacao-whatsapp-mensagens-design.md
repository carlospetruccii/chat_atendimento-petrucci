# Formatação de texto estilo WhatsApp (negrito, itálico, etc.)

**Data:** 2026-07-24
**Status:** aprovado

## Problema

O sistema hoje não interpreta a sintaxe de formatação do WhatsApp
(`*negrito*`, `_itálico_`, `~tachado~`, ```` ```monoespaçado``` ````). O texto
aparece cru — com os asteriscos/sublinhados literais — tanto na caixa de
digitação quanto nas bolhas de mensagem (enviadas e recebidas). O WhatsApp
oficial renderiza essa sintaxe visualmente; queremos a mesma experiência aqui,
tanto para quem atende quanto para o histórico exibido.

## Objetivo

1. As bolhas de mensagem (enviada e recebida) devem renderizar a formatação
   real (negrito, itálico, tachado, monoespaçado), não os caracteres crus.
2. A caixa de digitação do inbox deve formatar **ao vivo**, estilo WYSIWYG:
   ao fechar `*texto*`, os asteriscos somem e o texto vira negrito
   imediatamente (mesma ideia para os outros 3 marcadores). O texto puro
   enviado para a API do WhatsApp continua sendo a sintaxe crua
   (`*texto*`), pois é isso que o destinatário espera.

## Decisões (confirmadas com o usuário)

- WYSIWYG completo na digitação (marcadores somem), não apenas destacar os
  asteriscos. Optamos por usar uma lib de rich-text (Lexical) em vez de
  contentEditable feito à mão — cursor, undo/redo e composição de IME
  (acentos do pt-BR) são fáceis de quebrar numa implementação artesanal e
  difíceis de notar até estarem em produção.
- Sem toolbar de formatação — o único jeito de aplicar formatação é digitando
  os marcadores, igual ao app oficial do WhatsApp.
- Colar texto rico (Word/Google Docs) é convertido para texto plano — não
  queremos herdar formatação/HTML de fora.

## Arquitetura

### Parte 1 — Renderização nas bolhas (sem dependência nova)

Novo `src/lib/whatsapp-format.tsx`, substituindo `src/lib/linkify.tsx`:

- Parser único (regex, sem `dangerouslySetInnerHTML`) que reconhece os 4
  marcadores do WhatsApp **e** URLs na mesma passada, para não haver conflito
  entre um marcador e uma URL adjacente/dentro dele.
- Marcador sem par de fechamento (ex.: um `*` solto) renderiza como caractere
  literal — mesmo comportamento do WhatsApp real.
- Usado em `src/routes/_app.inbox.tsx` (bolha do chat) e
  `src/routes/_app.pendentes.tsx` (visão de supervisão), no lugar das
  chamadas atuais a `linkifyText(m.content)`.

### Parte 2 — Composer WYSIWYG (nova dependência: `lexical` + `@lexical/react`)

Novo componente `src/components/inbox/RichMessageComposer.tsx`, substituindo o
`<input type="text">` hoje em `src/routes/_app.inbox.tsx:875`.

- Os `TextNode` do Lexical já têm flags nativas de negrito/itálico/
  tachado/código — os 4 marcadores do WhatsApp mapeiam 1:1, sem precisar de
  node customizado.
- Um plugin pequeno observa o marcador de fechamento (`*`, `_`, `~` ou
  `` ` ``) digitado e converte o trecho recém-digitado num `TextNode`
  formatado, removendo os caracteres do marcador da visualização.
- No envio, um serializer percorre os nós de texto do editor e remonta a
  string crua em sintaxe WhatsApp (`*negrito*`, `_itálico_`, ...) — é essa
  string que vai para `sendInboxMessage`, igual hoje.
- Comportamentos atuais preservados: Enter envia / Shift+Enter quebra linha,
  interceptação de colar imagem (`handlePasteImage`, roda antes do paste
  handler do Lexical), estado `disabled` durante envio, placeholder, limpar e
  focar após enviar.
- Colar conteúdo rico é normalizado para texto plano antes de entrar no
  editor.

## Fora de escopo

- Toolbar de formatação (negrito/itálico via botão ou seleção de texto).
- Marcações aninhadas além do que o próprio WhatsApp suporta.
- Emoji picker, menções, ou qualquer outro recurso de composer não pedido.
- Alterar o formato armazenado no banco (`content` continua sendo a string
  crua com a sintaxe do WhatsApp — só a exibição muda).
