# 04 — Multi‑empresa e autenticação

Este é o documento sobre **quem entra, o que cada um pode fazer, e como (não) se separa os
dados por empresa**. É o tema mais importante para entender o "modo interno" atual e o
que precisa acontecer para o SaaS multi‑empresa voltar.

## Índice
- [O quadro em uma tabela](#o-quadro-em-uma-tabela)
- [Como funciona o login hoje (modo aberto)](#como-funciona-o-login-hoje-modo-aberto)
- [Os papéis (permissões)](#os-papéis-permissões)
- [A trava: `auth_enforcement_enabled`](#a-trava-auth_enforcement_enabled)
- [Onde está o isolamento por empresa](#onde-está-o-isolamento-por-empresa)
- [Como a "empresa do usuário" seria descoberta](#como-a-empresa-do-usuário-seria-descoberta)

---

## O quadro em uma tabela

| Aspecto | Como está hoje |
|---------|----------------|
| Login de verdade | **Não existe** (as rotas de login só redirecionam) |
| Sessão do usuário | **Falsa** — todos entram como um "Operador" administrador |
| Proteção de rotas | **Nenhuma** — qualquer rota abre sem login |
| Papéis em uso | O sistema **antigo** (`is_superadmin` + `user_permissions`) |
| Papéis multi‑empresa (`dono`/`administrador`/`colaborador`) | **Existem, mas dormindo** |
| Separação por empresa (RLS) | **Construída, mas desligada** |
| A trava `auth_enforcement_enabled` | **`false`** (desligada) |
| Onde os dados de hoje ficam | Todos na **"Empresa Exemplo"** (`11111111‑…`) |

---

## Como funciona o login hoje (modo aberto)

**Arquivos:** `src/hooks/useAuthSession.ts`, `src/hooks/useCurrentUser.ts`, `src/routes/login.tsx`, `src/integrations/supabase/client.ts`

Hoje o sistema roda em **"modo aberto"**: não há autenticação de verdade.

- `useAuthSession()` **sempre** devolve "sem sessão" — não usa o login do Supabase.
- `useCurrentUser()` tenta achar um usuário ativo no banco; **se não achar (ou der
  erro), assume um usuário fixo** chamado **`OPEN_USER`**: id `00000000‑…‑0001`, nome
  **"Operador"**, `isSuperadmin: true` e **todas as permissões**.
- As rotas `/login` e `/` só **redirecionam para `/inbox`**.
- **Não há proteção de rota**: qualquer pessoa que acesse a URL entra.

Na prática: **todo mundo é um administrador "Operador"** e vê tudo. Isso é adequado para o
uso interno de uma empresa só, mas significa que **ligar o multi‑empresa exige antes
ligar um login de verdade**.

> Detalhe importante: o id do "Operador" (`00000000‑…‑0001`) é **o mesmo** id usado
> internamente como **usuário do robô** (`BOT_USER_ID`) na função `triagem-bot`. Ver
> [Riscos](05-dados-de-exemplo-e-riscos.md).

---

## Os papéis (permissões)

Existem **dois sistemas de papéis convivendo**. É importante não confundir.

### Sistema ANTIGO — em uso hoje
Baseado na tabela `users` + `user_permissions`:
- **`is_superadmin`** (sim/não): o "chefe", pode tudo.
- **Permissões soltas** — cada uma libera uma ação. As que existem:
  `assign_pending`, `force_close`, `manage_business_hours`, `manage_departments`,
  `manage_permissions`, `manage_routing`, `manage_subjects`, `manage_templates`,
  `manage_times`, `manage_users`, `view_all_departments`, `view_audit_log`,
  `view_luana_notifications`.

É esse sistema que **as telas checam hoje** (ex.: só quem tem `view_all_departments` vê o
Dashboard e a Supervisão; só superadmin vê Configurações). No banco, funções como
`has_permission(...)` e `current_user_is_superadmin()` fazem a checagem.

### Sistema NOVO — dormindo
Baseado em `company_members.role`, com três papéis **por empresa**:
- **`dono`** — dono único da empresa; manda em tudo (protegido: não pode ser removido/rebaixado).
- **`administrador`** — gerencia colaboradores e configurações.
- **`colaborador`** — atendente, ligado a um departamento.

Esse sistema só é usado hoje nas **telas internas da Almore** (`/almore`,
`/almore-membros`). A operação normal ainda roda no sistema antigo.

### "Luana" — o papel de supervisão
"Luana" é o **apelido interno da supervisão**: quem enxerga todos os departamentos
(`view_all_departments`) e recebe os avisos de conversas paradas
(`view_luana_notifications`, tabela `notificacoes_luana`, cron `cron-notificacao-luana`,
config `numero_whatsapp_luana`). Já existiu um **usuário de exemplo chamado "Luana"** no
banco, mas ele foi **removido** por uma migration posterior — ver
[Riscos](05-dados-de-exemplo-e-riscos.md).

---

## A trava: `auth_enforcement_enabled`

Esta é **a chave única** que separa o "modo aberto" do "modo multi‑empresa".

- **Onde vive:** na tabela `platform_config`, na linha
  `('auth_enforcement_enabled', 'false')`.
- **Valor hoje:** **`'false'`** (desligada).
- **Quem lê:** a função de banco `auth_enforcement_enabled()`, que todas as regras de
  segurança consultam antes de decidir qualquer coisa.

**O que muda quando liga/desliga.** Todas as funções que decidem acesso
(`is_member_of`, `can_view_all_in`, `can_manage_config_in`, `is_owner_of`,
`current_department_in`) começam com esta lógica:

```
SE a trava está desligada ENTÃO responda "pode" (libera tudo)
SENÃO   verifique de verdade se a pessoa é membro/dono/etc. da empresa
```

Ou seja:
- **Desligada (`false`, hoje):** o "porteiro" deixa tudo passar. O RLS existe mas **não
  separa nada** — todos veem tudo. É o modo interno atual.
- **Ligada (`true`):** o RLS passa a valer de verdade — cada um só vê os dados da sua
  empresa, respeitando papel e departamento.

---

## Onde está o isolamento por empresa

A "trava" de isolamento é a combinação de três coisas, todas **já construídas** no banco:

1. **Coluna `company_id`** em quase todas as tabelas de dados (ver [Banco de dados](02-banco-de-dados.md)).
2. **Ligações compostas com a empresa** — impedem, por exemplo, uma mensagem apontar para
   um atendimento de outra empresa.
3. **Regras de RLS** que dizem, tabela por tabela, quem pode ver/mudar o quê — sempre
   passando pelo "porteiro" `auth_enforcement_enabled()`.

**Situação:** tudo isso está **implementado e dormindo**. Como a trava está desligada, o
isolamento não age. Nada da estrutura multi‑empresa foi desfeito — ela está intacta,
esperando ser ligada.

---

## Como a "empresa do usuário" seria descoberta

Quando o multi‑empresa for ligado, o sistema precisa saber **a qual empresa** cada
usuário pertence. Isso viria da tabela **`company_members`** (a linha que liga o
`user_id` logado a um `company_id`, com papel e departamento). A função de banco
`current_department_in(empresa)` já sabe devolver o departamento do colaborador naquela
empresa.

**O problema de hoje** (e o principal trabalho para o futuro): a operação **não conhece
a empresa**. O frontend não escolhe empresa, e as funções de backend **não gravam nem
filtram por `company_id`**. Tudo cai, na prática, na **"Empresa Exemplo"**. Por isso,
**ligar a trava sem antes ajustar o backend e o frontend quebraria o sistema** — os
detalhes e os pontos exatos estão em [Dados de exemplo e riscos](05-dados-de-exemplo-e-riscos.md).
