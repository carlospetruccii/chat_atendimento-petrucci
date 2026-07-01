# 05 — Dados de exemplo e riscos

Este documento reúne **onde há dados de exemplo/mockados** e os **pontos de atenção**
antes de duas coisas que estão no radar: **(1) limpar os mocks** e **(2) ligar a uazapi**.
Não propõe soluções — só aponta o que precisa de decisão consciente.

> **Aviso de escopo.** Este mapa foi feito lendo o **código e as migrations**. As linhas
> que existem hoje no **banco de verdade** (clientes/atendimentos reais ou de teste que
> alguém digitou) não são visíveis por aqui. Antes de limpar, vale uma passada no banco
> real para separar "dado de teste" de "dado de produção".

## Índice
- [Onde estão os dados de exemplo/mockados](#onde-estão-os-dados-de-exemplomockados)
- [Risco 1 — Z‑API → uazapi (o maior trabalho)](#risco-1--z-api--uazapi-o-maior-trabalho)
- [Risco 2 — `company_id` ausente no backend (bloqueia o multi‑empresa)](#risco-2--company_id-ausente-no-backend-bloqueia-o-multi-empresa)
- [Risco 3 — "Empresa Exemplo" segura os dados reais](#risco-3--empresa-exemplo-segura-os-dados-reais)
- [Outros pontos de atenção](#outros-pontos-de-atenção)
- [Checklist antes de mexer](#checklist-antes-de-mexer)

---

## Onde estão os dados de exemplo/mockados

| O quê | Onde | Observação |
|-------|------|------------|
| **"Empresa Exemplo"** (`11111111‑1111‑…`) | migration `20260630193000_multitenant_base.sql` | **Não é um mock descartável.** É a empresa‑padrão onde **todos os dados atuais** ficam. Ver Risco 3. |
| Constante `EMPRESA_EXEMPLO_ID` | `src/lib/workspaces-queries.ts` | Definida mas **não usada** em nenhuma tela. |
| Departamento **"Administrativo"** | migration `20260508182948_…` | Semente idempotente (não duplica). |
| Templates‑semente (ex.: `triagem_lembrete_sem_resposta`) | migration `20260514144823_…` | Textos padrão do robô. |
| Configurações‑semente (`bot_ativo`, tempos, lembrete…) | várias migrations | Valores iniciais em `system_config`. |
| Usuário‑exemplo **"Luana"** (`2b1fdda2‑…`) | criado em `20260508170921_…`, **apagado** em `20260511121455_…` | Já foi removido. "Luana" hoje é só o **apelido do papel de supervisão**, não um usuário. |
| Atendimento de teste (`11111111‑aaaa‑…`) | **apagado** em `20260508170000_…` | Já foi removido. |
| Usuário fixo **"Operador"** (`OPEN_USER`, `…0001`) | `src/hooks/useCurrentUser.ts` | O "usuário de mentira" do modo aberto. Ver Risco/atenção abaixo. |
| Usuários de sistema `…0001` e `…0002` | `triagem-bot` e crons | IDs internos do robô e das automações. |
| Nomes fixos `["tersiane", "gecica cruz"]` + data 2026‑05‑12 | `cleanup-disparo-acidental-bot` | Restos de uma correção pontual. Ver "outros pontos". |
| Marca **"BPMax"** | `__root.tsx` (título/descrição), `triagem-bot` (`LIST_TITULO = "Atendimento BPMax"`) | O produto interno é da **Almore**, mas o código ainda diz "BPMax". |

---

## Risco 1 — Z‑API → uazapi (o maior trabalho)

**A situação:** 100% do contato com o WhatsApp é **Z‑API**. A palavra "uazapi" **não
existe** no código. Trocar o provedor **não é só renomear** — o formato das mensagens que
chegam (webhook) e os endereços de envio são específicos da Z‑API.

**Todos os lugares que dependem da Z‑API** (o escopo da migração):

1. **O cliente de WhatsApp** — `supabase/functions/_shared/zapi-client.ts`
   (endereço `https://api.z-api.io`, endpoints `/send-text`, `/send-image`,
   `/send-audio`, `/send-video`, `/send-document/{ext}`, `/send-option-list`,
   `DELETE /messages`; cabeçalho `Client-Token`).
2. **A porta de entrada** — `webhook-zapi-receive`: **lê o formato de payload da Z‑API**
   (campos como `image.imageUrl`, `fromMe`, respostas de lista/botão) e valida o
   `Client-Token`. É a parte que mais muda, porque o formato da uazapi é diferente.
3. **Quem envia/usa o cliente** — as funções `send-whatsapp-message`,
   `send-whatsapp-audio`, `send-whatsapp-media`, `triagem-bot`, `cron-notificacao-luana`,
   `cron-retry-mensagens-falha` e `cleanup-disparo-acidental-bot`.
4. **Os segredos** — `ZAPI_INSTANCE_ID`, `ZAPI_TOKEN`, `ZAPI_CLIENT_TOKEN`.
5. **Nomes no banco** (cosméticos, não quebram nada): `companies.zapi_instance_id/zapi_token/zapi_client_token`, `mensagens.zapi_message_id`, `cleanup_log.zapi_message_id/zapi_response`, e `clients.chat_lid`.
6. **Nomes de função/config**: a própria pasta `webhook-zapi-receive` e sua entrada em `supabase/config.toml` (`verify_jwt = false`).

**Ponto de decisão:** como as credenciais do WhatsApp existem em **dois lugares** (nos
segredos `ZAPI_*` e nas colunas de `companies`), decidir qual será a fonte de verdade com
a uazapi — sobretudo se o multi‑empresa voltar (aí faz sentido ficar por empresa, em `companies`).

---

## Risco 2 — `company_id` ausente no backend (bloqueia o multi‑empresa)

**Confirmado:** não há **nenhuma** menção a `company_id` em toda a pasta
`supabase/functions/`, e as consultas do frontend também não filtram por empresa.

O que isso significa na prática:
- O `webhook-zapi-receive` cria **clientes, atendimentos e mensagens sem `company_id`**.
- As telas leem/gravam sem dizer a empresa.
- Tudo, na prática, pertence à **"Empresa Exemplo"**.

**O risco:** se alguém **ligar a trava** (`auth_enforcement_enabled = 'true'`) **antes**
de ajustar backend e frontend para gravar/filtrar `company_id`, o sistema **quebra** —
inserções podem falhar (por causa das ligações compostas com a empresa) e as telas ficam
vazias (o RLS passa a esconder tudo que não tem a empresa certa).

**Regra de ouro:** manter a trava **desligada** enquanto o uso for interno. Ligá‑la é um
projeto que inclui: login de verdade, popular `company_members`, e fazer backend/frontend
conhecerem a empresa.

---

## Risco 3 — "Empresa Exemplo" segura os dados reais

A "Empresa Exemplo" **parece** um dado de teste pelo nome, mas hoje ela é o **contêiner
de todos os dados** (todo cliente, atendimento e mensagem aponta para ela).

**O risco:** numa "limpeza de mocks", apagar a Empresa Exemplo (ou o departamento
"Administrativo" padrão) **apagaria os dados reais junto**.

**Ponto de decisão:** tratar a Empresa Exemplo como **a empresa da Almore** (por exemplo,
renomeá‑la), em vez de apagá‑la. A limpeza de "mock" deve mirar **linhas obviamente
fictícias** (clientes/atendimentos de teste digitados durante o desenvolvimento), não o
contêiner.

---

## Outros pontos de atenção

- **UUID de sistema compartilhado (`…0001`).** O "Operador" do modo aberto e o **usuário
  do robô** (`BOT_USER_ID`) têm **o mesmo id**. Enquanto é modo aberto, ações manuais e
  do bot podem se confundir sob o mesmo id. Ao ligar login real, decidir separá‑los.

- **Dois sistemas de papéis convivendo.** O sistema **antigo** (`is_superadmin` +
  `user_permissions`) é o que as telas usam hoje; o **novo** (`company_role`) está
  dormindo. Além disso, o histórico do projeto já **removeu a tela de permissões
  granulares** — então essas permissões ainda são **checadas**, mas **não há mais tela
  para gerenciá‑las** (no modo aberto, o "Operador" recebe todas fixas no código). Ao
  limpar, não remover o sistema antigo enquanto ele estiver em uso.

- **Função de limpeza pontual (`cleanup-disparo-acidental-bot`).** É código de uso único,
  com **nomes de pessoas e uma data fixa** embutidos, e que **apaga mensagens** no
  WhatsApp. Está protegida por um token (`CLEANUP_CONFIRM_TOKEN`), então o risco acidental
  é baixo, mas é forte candidata a **remoção** depois de confirmado que não é mais
  necessária.

- **Estado do bot (`bot_ativo`).** As automações (triagem, encerramento, avisos, reenvio)
  só rodam com o bot ligado. Antes de contar com elas, **conferir o valor atual** de
  `bot_ativo` no banco (pode ter sido desligado pela aba Operação).

- **Marca "BPMax".** Títulos da página e o cabeçalho do menu de triagem ainda dizem
  "BPMax". Se o produto é da Almore, é um ajuste de marca a considerar.

- **Reconciliação de nome (sem risco).** Um relatório interno citou `specialists_routing`;
  o nome correto da tabela é **`especialista_routing`**. Anotado só para evitar confusão.

---

## Checklist antes de mexer

Um resumo do que **decidir/conferir** antes de limpar mocks e ligar a uazapi:

**Antes de limpar mocks**
- [ ] Conferir no **banco real** quais linhas são de teste (vs produção).
- [ ] Decidir o destino da **"Empresa Exemplo"** (renomear para Almore, não apagar).
- [ ] Confirmar se a função **`cleanup-disparo-acidental-bot`** pode ser removida.
- [ ] Decidir sobre a **marca "BPMax"** nos textos.

**Antes de ligar a uazapi**
- [ ] Mapear o **formato de webhook** e os **endpoints de envio** da uazapi (o payload é
      diferente do da Z‑API — o `webhook-zapi-receive` e o `zapi-client.ts` precisarão de
      trabalho, não só rename).
- [ ] Definir onde ficam as **credenciais** (segredos vs colunas em `companies`).
- [ ] Decidir se os **nomes `zapi_*`** no banco/código serão mantidos ou renomeados.

**Sobre o multi‑empresa (deixar como está por enquanto)**
- [ ] **Manter `auth_enforcement_enabled = 'false'`** enquanto o uso for interno.
- [ ] Lembrar que ligá‑lo exige, antes: login real, `company_members` populada, e
      backend/frontend gravando/filtrando `company_id`.
