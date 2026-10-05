# Port do ChatAtendimento (Almore) — outubro/2026

O chat-carlos nasceu como fork do `ChatAtendimento` da Almore no commit `021907a`
(05/08/2026). Em 05/10/2026 trouxemos para cá o que o Almore ganhou depois disso
(até o `f884fa9`, só o que estava **commitado** lá).

Commits na `main`:

| Commit | O que é |
|---|---|
| `0fdff12` | Traz as melhorias do Almore |
| `80cc8ed` | Remove a aba Docs (número financeiro) |

## Como foi feito

1. Base = `src`, `supabase/functions`, `supabase/tests` e `supabase/migrations` do Almore.
2. Desfeitos os commits que ficaram de fora (lista abaixo).
3. Reaplicado por cima o que é só do chat-carlos (`git diff 021907a fee8ba1`):
   fotos de perfil próprias, `importar-conversas`, `atualizar-fotos`, saída do Lovable,
   troca do projeto Supabase.
4. Ajustes de revisão (código, segurança e pré-deploy).

## O que entrou

**Dashboard**
- Filtro por departamento e por pessoa (quem deu a 1ª resposta).
- 1ª resposta medida pela 1ª mensagem humana de verdade, só em conversa que o cliente puxou.
- Histograma em 7 faixas; KPI do topo e card na mesma conta.
- Saíram os cards "Engajamento em queda" e "Contas em que só o cliente puxa".

**Mensagens**
- Apagar para todos e editar (uazapi), inclusive mensagem mandada pelo celular da empresa.
- Encaminhar mensagem para outra conversa.
- Seleção de várias mensagens (no celular, segurando o dedo).
- Transcrever áudio recebido pelo menu da mensagem.
- Cartão de contato recebido com "Conversar" e "Salvar contato".
- Botão de baixar no visualizador de imagem.

**Inbox**
- Filtro por status na lista.
- Atribuir e repassar durante a triagem (o bot para de mexer na conversa).
- Visual: abas e barra de digitação arredondadas, cabeçalho como cartão flutuante.
- Histórico preservado depois de troca de setor (leitura por participação, ver migration abaixo).

**Contatos**
- Cadastro interno de contatos (botão "Adicionar contato" liberado para colaboradores).
- Mesmo celular com e sem o nono dígito vira um cliente só.

**Mídia**
- `.rar`, certificado digital (`.pfx/.p12/.cer`) e anexos grandes param de cair como
  "Mídia indisponível". Botão "Tentar novamente" (`reprocessar-midia`).

**Celular** — app inteiro adaptado (barra inferior, uma tela por vez, filtros em gaveta,
alvos de toque de 44px, Enter pula linha).

**Correções** — sem envio duplicado quando a uazapi demora, sem descartar mensagem de
cliente duplicado, mensagem enviada aparece na hora, aviso ao colaborador quando o bot
reserva atendimento para ele, filtro de colaboradores inativos.

**IA** — `ai-texto` fala direto com a OpenAI (`gpt-transcribe` e `gpt-5-nano`), sem Lovable.

## O que ficou de fora (de propósito)

| Item | Commit no Almore | Motivo |
|---|---|---|
| Aba Docs (número financeiro) | `b226853`, `1bdea5a`, `16688ca`, `d685c88` | Não vamos usar o segundo número |
| Fotos de perfil do Almore | `4213c72`, `9be2138` | O chat-carlos tem implementação própria (`FotoPerfil`, `atualizar-fotos`) |
| Reserva automática só para quem está no setor | `62cbfbd` | Bloco "Triagem e IA" excluído |
| Triagem ignora texto com credenciais | `926c795` | Bloco "Triagem e IA" excluído |
| Sugestão de IA não envia sozinha sem crédito | `64582d8` | Bloco "Triagem e IA" excluído |
| Aviso "IA não achou nada a melhorar" | `55a694c` | Bloco "Triagem e IA" excluído |
| Triagem com timeout e resposta a aviso interno | não commitado no Almore | Trabalho em andamento lá |

Observações:
- O banco do chat-carlos foi criado a partir do schema do Almore, então já tem a função de
  `62cbfbd` e as tabelas `docs_*`. Elas ficam lá sem uso.
- O código compartilhado de mídia e reenvio (`_shared/midia-mensagem.ts`,
  `cron-retry-mensagens-falha`) ainda aceita a tabela `docs_mensagens`. Como nada escreve
  nela, esse caminho não roda.

## Diferenças em relação ao Almore

- **Teto de mídia baixada: 50 MiB** (`_shared/midia-download.ts`). O projeto Supabase está
  no plano **Free**, que não aceita arquivo maior. No Almore é 300 MB. Se mudar de plano e
  aumentar o limite do Storage, suba o `MAX_BYTES` junto.
- **Plano Free = função com no máximo 150 s.** Download grande em link lento pode não
  terminar; a bolha fica em "carregando".
- `_shared/uazapi-client.ts`: `listarChats` (do Almore, formato cru) e `listarChatsPaginado`
  (do chat-carlos, usada por `importar-conversas`).

## Ajustes feitos na revisão

- Leitura por participação exige colaborador ativo em `company_members` **e** em `users`
  (desativar na tela só mexe em `users.ativo`). Teste em
  `supabase/tests/historico_participante.test.sql`.
- Motivo de erro de envio gravado no banco sem URL (`semUrls` é o padrão em
  `atualizacaoAposErroEnvio`).
- Colaborador comum não renomeia cliente que já existe (`cadastrar-cliente`).
- `importar-conversas` reconhece o nono dígito.
- `company_id` nas escritas de `mensagem-acao` e `mensagem-encaminhar`.
- O webhook guarda `conteudo_anterior` quando o cliente apaga uma mensagem.
- "Pular para o atendimento" e barra de seleção respeitam o cabeçalho flutuante.

## Banco

A única migration que faltava no projeto `kxssjlvrbkkdicgevwtl` era
`20260901152202_historico_participante_entre_setores.sql` (schema `private`, policies de
SELECT por participação, `REVOKE INSERT` em `timeline_events`). **Aplicada em 05/10/2026**
pelo MCP do Supabase.

As outras migrations novas em `supabase/migrations/` (20260806… a 20260930…) já estavam no
banco, que foi criado a partir do schema do Almore. Por isso **não use `supabase db push` às
cegas**: ele tentaria reaplicar e várias não são idempotentes. Para registrar no histórico:
`supabase migration repair --status applied <versões>`.

## Edge Functions

Publicar (o `verify_jwt` vem do `supabase/config.toml`):

```bash
supabase functions deploy webhook-zapi-receive triagem-bot cron-notificacao-colaboradores \
  send-whatsapp-message send-whatsapp-media send-whatsapp-audio grupo-enviar \
  cron-retry-mensagens-falha cadastrar-cliente backfill-mensagens-externas \
  importar-conversas mensagem-acao mensagem-encaminhar reprocessar-midia \
  webhook-historico ai-texto --project-ref kxssjlvrbkkdicgevwtl
```

- Novas: `mensagem-acao`, `mensagem-encaminhar`, `reprocessar-midia`.
- `webhook-zapi-receive` e `webhook-historico` são `verify_jwt = false` (validam token no corpo).
- Rollback do webhook: a versão anterior publicada é a v8.
- Opcionais (só importam o `uazapi-client.ts` alterado, comportamento igual):
  `cron-alerta-atendimento-parado`, `cron-notificacao-admin`, `notificar-repasse`,
  `mark-chat-read`, `grupo-participantes`, `historico-solicitar`, `whatsapp-connection`,
  `sincronizar-grupos`, `atualizar-fotos`.

Enquanto as funções novas não estiverem publicadas, apagar, editar, encaminhar e
"tentar novamente" na mídia dão erro na tela.

## Secrets

| Secret | Para quê | Situação |
|---|---|---|
| `API_KEY_OPENAI_TRANSCRIBE` | `ai-texto` (transcrição, correção, sugestão) | **Falta cadastrar** |
| `UAZAPI_TOKEN`, `UAZAPI_URL` | WhatsApp principal | OK |

```bash
supabase secrets set API_KEY_OPENAI_TRANSCRIBE=<chave> --project-ref kxssjlvrbkkdicgevwtl
```

Sem a chave, a IA responde "IA não configurada" e o resto funciona.

## Pendências conhecidas (baixo risco)

- `repassar_atendimento` não confere se quem chama é da mesma empresa do atendimento.
  Já estava assim; não é explorável com uma empresa só.
- Download de mídia valida o destino só pelo nome do host (sem checar IP interno).
- `importar-conversas` e `backfill-mensagens-externas` baixam mídia dentro do loop; um
  arquivo grande pode estourar o tempo da função. Rode em lotes pequenos.
- Erros de typecheck antigos, sem relação com o port: `src/router.tsx`,
  `src/routes/__root.tsx` e `supabase/functions/iniciar-atendimento` (TS2352).
