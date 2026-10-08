# Bugs do Almore conferidos no chat-carlos — outubro/2026

Em 08/10/2026 lemos as docs do `ChatAtendimento` (Almore) e os 62 commits de correção dele
e conferimos, um por um, como estava o chat-carlos (código, banco e funções publicadas).
Diferenças de propósito em relação ao Almore: ver
[port-chatatendimento-2026-10.md](port-chatatendimento-2026-10.md#o-que-ficou-de-fora-de-propósito).

O bot de triagem continua **desligado** em tudo abaixo — ver [bot-triagem.md](bot-triagem.md).

---

## O que foi corrigido

### Bot e setores (06–08/10)

| # | Problema | Correção | Onde |
|---|---|---|---|
| 1 | Faltava o usuário de sistema **Bot**: toda mensagem do bot falharia e a triagem entraria em loop | seed Bot/Sistema | migration `20261006120500` |
| 2 | Sem setores e sem textos do bot | 4 setores + 5 textos | migration `20261006120500` |
| 3 | Menu em ordem alfabética | coluna `ordem` + setinhas ↑↓ | migration `20261006120000`, `DepartamentosTab.tsx` |
| 4 | Rodapé da lista e telas diziam "Almore" | "Parabrisas Petrucci" | `triagem-bot/logic.ts`, telas |
| 5 | Conversa iniciada pelo celular caía em setor imprevisível | padrão = Vendas | migration `20261008120000` |
| 6 | Bot travaria ao ligar: ~180 `em_triagem` antigos ocupavam as 50 vagas da fila | fila só com mensagem depois da ativação, mais recente primeiro | `triagem-bot/index.ts` (commit `9af4d19`) |
| 7 | "Estou **sem** vidro" ia para "Sem parar" | "sem" ignorado; nome inteiro ainda casa | `triagem-bot/logic.ts` |
| 8 | E-mail/link com nome de setor ("vendas@…") escolhia o setor | matcher do Almore `926c795` | `triagem-bot/logic.ts` |

### Correções do Almore que faltavam (08/10)

| # | Problema | Almore | O que faltava | Feito |
|---|---|---|---|---|
| 9 | Colaborador recebia **403** ao iniciar conversa | `595232f` | publicar `cadastrar-cliente` | publicada |
| 10 | Mensagem **duplicada** quando a uazapi demora | `56133c4` | publicar funções de envio | publicadas |
| 11 | `.rar` e anexo grande viravam "Mídia indisponível" | `e41e39f`, `a55fce8` | publicar webhook e `reprocessar-midia` | publicadas |
| 12 | Mesmo celular com e sem nono dígito virava 2 clientes | `db82a79`, `8861e2e` | publicar webhook e `cadastrar-cliente` | publicadas |
| 13 | Apagar, editar, encaminhar e "Tentar novamente" davam erro | `68e1d1e`, `725fc22`, `e7a909e`, `fdf5695` | publicar `mensagem-acao`, `mensagem-encaminhar`, `reprocessar-midia` | publicadas |
| 14 | **WhatsApp pessoal** do colaborador legível por qualquer usuário logado | `a445bd7` | a trava por coluna não tinha valido no nosso banco | reaplicada (`20260717140000`) |
| 15 | Repasse mostrava "Colaborador destino inválido" quando a conversa já era da pessoa | `fd6e532` | só front | trazido (commit `618562f`) |

Funções publicadas em 08/10: `webhook-zapi-receive`, `cadastrar-cliente`,
`send-whatsapp-message`, `send-whatsapp-media`, `send-whatsapp-audio`, `grupo-enviar`,
`cron-retry-mensagens-falha`, `cron-notificacao-colaboradores`,
`backfill-mensagens-externas`, `importar-conversas`, `mensagem-acao`,
`mensagem-encaminhar`, `reprocessar-midia`, `webhook-historico`, `ai-texto` e
`triagem-bot` (v4). Webhook conferido depois: respostas 200, mensagens chegando, sem erro.
Rollback do webhook: v8.

---

## Já estava OK no chat-carlos

| Bug no Almore | Commit |
|---|---|
| Mensagem de cliente duplicado descartada | `8861e2e` |
| Resposta pelo celular (fromMe) não aparecia | `f626a59`, `7020ac4` |
| Mensagem de outro sistema / eco sumia ou duplicava | `22c05b0` |
| Aviso interno entrava na conversa do colaborador | `ba02b03` |
| Atendimento ativo duplicado (corrida no webhook) | `90d7322` |
| Encerramento manual reaberto sozinho | `742e83a` |
| Não dava pra encerrar atendimento em triagem | `e180c27` |
| Clique na lista interativa não reconhecido | `434f7cd` |
| Texto livre não reconhecido | `f1ed7f5` |
| Chaves de config faltando (`bot_ativo` etc.) | `2b4f996` |
| Bot não avisava quando reservava atendimento | `abcddd8` |
| Reserva automática pra quem saiu do setor | `62cbfbd` (função já está no banco) |
| Mensagem enviada só aparecia depois de recarregar | `17d590f` |
| Contador de não lidas somando atendimentos escondidos | `c62325c` |
| Histórico some depois de trocar de setor | `e53c673` |
| Atribuir/repassar atendimento encerrado | `d2af39a` |
| Anexar certificado digital | `86725ee` |
| Erro 500 no cadastro de cliente (ON CONFLICT) | `9e44840` |
| Usuário virando superadmin sozinho | `e34ec36` |
| Storage de mídia | `8eea313` |

## Não se aplica

- Bloco "Triagem e IA" (`64582d8`, `55a694c`) e aba Docs / número financeiro — deixados
  de fora no port.
- Fotos de perfil do Almore — o chat-carlos tem implementação própria.
- Fluxo de Sessões (`sessao_*`) — nenhum número cadastrado em Sessões.

---

## Pendente

| Item | Por quê | Quando |
|---|---|---|
| Horário comercial | `business_hours` vazio: o lembrete "ainda está aí?" e avisos "só em horário comercial" não saem | o dono cadastra na aba **Horário** |
| Reenvio automático de mensagem com falha | cron `cron-retry-mensagens-falha` inativo; no Almore fica ligado. Ele respeita `bot_ativo` | ligar junto com o bot |
| Textos e número dos avisos internos (`notificacao_admin`, `numero_whatsapp_admin`, `alerta_atendimento_parado`, `notificacao_colaborador`) | o código tem texto de reserva; sem número do admin nada sai | quando forem ligar os avisos |
| `tempo_alerta_atendimento_parado = 10` (Almore: 90) | conferir com o dono | quando forem ligar os avisos |
| Cliente calado fica em triagem pra sempre | timeout de triagem ainda em andamento no Almore (doc 09, não commitado) | trazer quando o Almore terminar |
| Resposta do colaborador a aviso interno | idem (doc 09) | idem |
| Migration `20260902165239` (`62cbfbd`) fora do repo | a função já está no banco; só falta o arquivo | baixo |
| Título "Google — Almore" na página de login do Google | exige publicar `google-contacts` | baixo |
