# Disponibilizar a chave de IA para a função "ai-texto"

## Situação

A chave de IA (`LOVABLE_API_KEY`) existe neste projeto Lovable — confirmei na listagem de secrets, onde aparece como gerenciada pela plataforma (não editável pelas ferramentas comuns de secret).

O que falta é ela estar presente no ambiente onde a função `ai-texto` roda: o Supabase conectado (projeto externo `hfcfkxozzbrzzrejtbdj`). Por isso a função cai no ramo que responde "IA não configurada (LOVABLE_API_KEY ausente)".

Um detalhe importante: o valor da chave nunca é exibido — nem para mim, nem para você. Então não existe a opção de "copiar e colar" a chave no painel do Supabase. A saída é fazer a plataforma reescrever/sincronizar a chave para o ambiente conectado.

## O que vou fazer

1. **Rotacionar a chave de IA** com a ferramenta própria da plataforma. A rotação gera um valor novo e regrava o secret nos ambientes do projeto — é o caminho suportado para forçar a propagação da chave sem expor o valor. A chave antiga é invalidada; nada mais no projeto depende dela além das funções de IA.
2. **Verificar se chegou** chamando a função de diagnóstico já existente `ai-probe` (ela lista modelos e testa chat/transcrição usando a mesma variável de ambiente).
3. **Confirmar de ponta a ponta** invocando `ai-texto` com um texto curto e conferindo que a resposta volta com `ok: true` e o texto otimizado, além de olhar os logs da função.

## Se a rotação não propagar

Se depois da rotação o `ai-texto` continuar sem enxergar a chave, isso significa que a plataforma não sincroniza secrets gerenciados para um Supabase externo conectado. Nesse caso eu volto para você com as duas únicas alternativas reais, sem tocar em nada antes de você escolher:

- **A)** Você criar uma chave de IA própria (ex.: OpenAI/Google) e salvá-la como secret no Supabase; a função passaria a usar essa variável — isso exigiria uma alteração mínima no `ai-texto`.
- **B)** Mover a chamada de IA para o runtime do próprio Lovable (server function), onde a `LOVABLE_API_KEY` já existe — mudança de código maior, mas sem chave nova.

## Detalhes técnicos

- Ferramenta: `lovable_api_key--rotate_lovable_api_key` (rotação única; não repetir em loop).
- Nenhum arquivo de código, tela ou migration será alterado neste plano.
- Verificação: `ai-probe` (guard por `?k=`) e invocação de `ai-texto`, além de leitura dos logs das edge functions.
