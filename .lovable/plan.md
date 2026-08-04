# Transcrição fiel: modelos melhores, glossário e revisão que ouve o áudio

## O que muda na prática

O atendente continua fazendo exatamente o mesmo: grava e aperta "Transcrever". O que muda é o que acontece por baixo:

1. Passa a usar os modelos mais fortes disponíveis.
2. Quem ouve o áudio recebe antes a lista de siglas e termos da contabilidade (e o nome do cliente, quando a conversa é com cliente), então para de trocar "DAS" por palavra parecida.
3. Quem escreve o texto final passa a **ouvir o áudio junto** com o texto cru, em vez de adivinhar a partir do texto. É isso que corrige o problema de "sai bonito mas diz outra coisa".
4. Se algo falhar, o resultado degrada em etapas e nunca fica pior do que hoje.

## Arquivos que serão alterados

| Arquivo | Mudança |
| --- | --- |
| `supabase/functions/ai-texto/index.ts` | Modelos novos; campo `prompt` com o glossário; revisão passa a receber áudio + texto cru; fallbacks em etapas; retorno passa a incluir o texto cru |
| `src/lib/ai-texto.ts` | Envia o nome do cliente (opcional) junto com o áudio; devolve `{ texto, textoBruto }` |
| `src/routes/_app.inbox.tsx` | Passa `current.clientNome` na chamada da transcrição (1 linha) |
| `src/components/inbox-grupos/GrupoChatPanel.tsx` | Ajuste da chamada ao novo retorno (sem nome de cliente) |
| `src/components/inbox-equipe/EquipeChatPanel.tsx` | Ajuste da chamada ao novo retorno (sem nome de cliente) |

Nenhum arquivo de UI/visual, nenhum botão, nenhum texto de tela, nada do envio de áudio como mensagem de voz.

## Detalhes técnicos

**Modelos**
- `MODELO_TRANSCRICAO`: `openai/gpt-4o-mini-transcribe` → `openai/gpt-4o-transcribe`
- `MODELO_CHAT`: `google/gemini-2.5-flash` → `google/gemini-3.6-flash` (vale para transcrição e para a revisão do texto digitado)

**Glossário na transcrição**
- Nova constante com a lista fixa de siglas/termos, enviada no campo `prompt` do form de `/v1/audio/transcriptions`.
- O frontend pode mandar um campo opcional `cliente` no `FormData`; quando presente, o nome é anexado ao final do `prompt`. Ausente em grupo/equipe — comportamento idêntico ao de hoje, sem quebrar nada.

**Revisão ouvindo o áudio**
- O segundo passo passa a montar uma mensagem `user` multimodal em `/v1/chat/completions`:
  - bloco `input_audio` com o áudio em base64 e `format` derivado do MIME (`webm`, `ogg`, `mp4`/`m4a`, `mp3`, `wav`)
  - bloco `text` com a transcrição crua como referência de números e siglas
- O prompt do sistema passa a instruir: o áudio é a verdade; o texto cru serve só para grafia de siglas/valores; respeitar autocorreção e hesitação; não reinterpretar.
- Áudio de até 2 minutos cabe folgado no limite atual de 24 MB já validado na função.

**Degradação em etapas** (nunca pior que hoje)
1. áudio + texto cru → texto final
2. se o gateway recusar o áudio (400/415/erro do bloco) → repete só com o texto cru (comportamento atual)
3. se ainda falhar → devolve a transcrição crua
4. se a transcrição falhar → erro atual, sem mudança

**Retorno**
- A função passa a responder `{ ok, texto, textoBruto?, erro? }`; `src/lib/ai-texto.ts` devolve `{ texto, textoBruto }`.
- Os três pontos de chamada passam a usar `.texto`; o `textoBruto` fica disponível, sem uso na tela por enquanto.

**Verificação**
- Chamada real à função com um áudio de teste, conferindo `ok: true`, o texto final e o texto cru, além dos logs da edge function.

## Correção pendente que vem junto

O build está quebrado hoje por um erro de tipo pré-existente em `src/routes/_app.inbox.tsx` (linha 168, parâmetro `prev` sem tipo na navegação de abas), sem relação com a IA. Como preciso tocar nesse arquivo mesmo assim, tipo esse parâmetro na mesma passada para o build voltar a passar.
