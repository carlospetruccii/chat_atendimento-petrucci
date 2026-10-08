# 09 — Aba Tempos: "Em uso" ou "Sem efeito", pelo estado real

> Changeset de **08/10/2026** (commit `9e87c75`). Migration aplicada em produção
> (`status_tempos`). Front publicado pelo push na `main`.

---

## O problema

A aba **Configurações → Tempos** mostrava os valores certos e salvava certo, mas não
dizia a verdade sobre **se cada tempo fazia efeito**. O aviso "Sem efeito" era texto
fixo no código do front. Ligar ou desligar o bot, um cron ou um interruptor não mudava
nada na tela. E o navegador não consegue ler `cron.job` para saber se a rotina roda.

Conferência feita antes da mudança:

| Verificação | Resultado |
|---|---|
| Salvar grava em `system_config`? | Sim (testado como admin; atendente é barrado pela RLS) |
| Cada tempo é lido pela função certa? | Sim (ver tabela abaixo) |
| Versão publicada das funções = código local? | `triagem-bot` e `webhook-zapi-receive` iguais; as 3 de cron antigas não puderam ser baixadas |
| Os tempos fazem efeito hoje? | Quase nenhum: bot desligado e crons parados |

---

## Quem usa cada tempo

| Tempo (`system_config.chave`) | Quem lê | Depende de |
|---|---|---|
| `delay_anti_flood_triagem` | `triagem-bot` | `bot_ativo` + cron `triagem-bot` |
| `triagem_max_tentativas` | `triagem-bot` | `bot_ativo` + cron `triagem-bot` |
| `tempo_abandono_triagem` | `triagem-bot` | o de cima + `triagem_abandono_ativo = 'true'` (chave hoje ausente = desligado) |
| `janela_continuidade_apos_encerramento` | `webhook-zapi-receive` | nada (`0` = desligado) |
| `tempo_alerta_atendimento_parado` | `cron-alerta-atendimento-parado` (via `get_atendimentos_parados`) | `bot_ativo` + cron |
| `intervalo_repeticao_alerta_atendimento_parado` | `cron-alerta-atendimento-parado` | `bot_ativo` + cron |
| `tempo_notificacao_admin` | `cron-notificacao-admin` | `numero_whatsapp_admin` preenchido + `bot_ativo` + cron |
| `intervalo_repeticao_notificacao_admin` | `cron-notificacao-admin` | idem |
| `tempo_encerramento_automatico` | `cron-encerramento-automatico` | `encerramento_automatico_ativo` + `bot_ativo` + cron |

`triagem_lembrete_minutos` fica na aba **Operação**, não em Tempos.

---

## A solução

### Banco: `public.status_tempos()`

RPC só de leitura que devolve, para cada tempo da tela:

| Coluna | Significado |
|---|---|
| `chave` | a chave em `system_config` |
| `motivo` | `NULL` = faz efeito hoje; texto = por que não faz |
| `afetados` | só em `tempo_alerta_atendimento_parado`: quantos clientes já passaram desse tempo (teto 500) |

- `SECURITY DEFINER` (o usuário não lê `cron.job`). Só responde para **dono/administrador**
  (`can_manage_config_in`), e sempre sobre a **empresa do próprio usuário**
  (`company_members`), nunca uma qualquer.
- Auxiliar interna `status_tempos_cron_ativo(jobname)`, sem EXECUTE para o cliente.
- Chave `bot_ativo` ausente conta como desligado (igual ao kill switch das edge functions).

### Front

- `src/lib/tempos-queries.ts` (a seção Tempos saiu de `configuracoes-queries.ts`, que
  passava de 800 linhas): `TEMPOS`, `fetchTempos`, `montarTempos`, `textoAfetados`, `updateTempo`.
- Se o RPC falhar, a tela continua mostrando e editando os valores, mas marca
  "Não foi possível confirmar se este tempo está em uso", sem afirmar nada.
- `TemposTab` mostra selo verde **Em uso** ou amarelo **Sem efeito: motivo**, e a frase
  "Hoje N clientes já passaram desse tempo. Se ligar, todos geram aviso."
- Salvar sem permissão agora diz "Só dono ou administrador pode alterar os tempos."
  (antes dizia que a configuração "não existe").

### Regra para tempo novo

Tempo novo em `TEMPOS` precisa de linha em `status_tempos()`. Sem isso, a tela mostra
"Não foi possível confirmar", de propósito, para não mentir "Em uso".

---

## O que a tela mostra hoje (08/10/2026)

- ✅ **Em uso:** só "Continuar no mesmo setor" (72 h).
- ⚠️ **Sem efeito:**
  - os de triagem e os avisos ao responsável (bot desligado);
  - os avisos ao admin (sem número cadastrado);
  - o encerramento automático (desligado em Operação).

**Atenção antes de ligar o aviso ao responsável:** com o tempo em 10 min, 184 clientes
já passaram do prazo. O cron pega 50 por rodada (a cada 5 min) e repete a cada 30 min,
então dispararia muitas mensagens para a responsável.

---

## Testes

- `src/lib/tempos-queries.test.ts` (vitest): junção de valores com status, falha do RPC,
  chave sem regra, texto de afetados, mensagens de erro do salvar.
- `supabase/tests/status_tempos.test.sql`: roda no banco dentro de `BEGIN/ROLLBACK`, como
  um admin real. Confere os nomes dos jobs, as 9 chaves, janela 0/72, bot desligado,
  encerramento desligado, admin sem número, afetados, bloqueio de não membro e de `anon`.
  Não liga bot nem cron.
