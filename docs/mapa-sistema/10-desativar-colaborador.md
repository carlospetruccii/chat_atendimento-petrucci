# 10 — Desativar colaborador corta o acesso de verdade

> Changeset de **08/10/2026** (commit `a637252`). Migration aplicada em produção
> (`desativar_colaborador_corta_acesso`). Front publicado pelo push na `main`.

---

## O problema

O botão **Desativar** (Configurações → Colaboradores) só gravava `users.ativo = false`.
Nada conferia isso. Simulação no banco (transação desfeita), com o Carlos desativando a Tayna:

| O que aconteceu | Antes |
|---|---|
| Carlos consegue desativar? | Sim |
| Conversas dela voltam pra pendentes? | Sim (trigger `release_atendimentos_on_user_inactive`) |
| Tayna desativada ainda entra e vê tudo? | **Sim, viu os 339 atendimentos** |
| Continua administradora? | **Sim** |
| Consegue se reativar sozinha? | **Sim** |

Por quê:
- O login não olha `users.ativo`.
- `current_user_is_superadmin()`, `current_user_can_view_all()` e `has_permission()`
  ignoravam o ativo.
- `company_members.ativo` continuava `true`, então `is_member_of` e `can_manage_config_in`
  liberavam tudo.

Ninguém tinha sido desativado até então, por isso ninguém percebeu.

**Cadastrar colaborador** já funcionava: Carlos e Tayna são administradores
(`is_superadmin`), e a edge function `criar-colaborador` libera administrador. Os dois
foram cadastrados por essa tela em 05/10.

---

## O que mudou

### Banco (`20261008180000_desativar_colaborador_corta_acesso.sql`)

**Trigger `trg_users_aplicar_ativo`** (AFTER UPDATE OF ativo em `users`):

| Ao desativar | Ao reativar |
|---|---|
| `company_members.ativo = false` | `company_members.ativo = true` |
| `auth.users.banned_until` = agora + 100 anos (login recusado) | `banned_until = NULL` |
| apaga `auth.sessions` (os refresh tokens caem em cascata) | — |

Vale para qualquer caminho que mude `users.ativo`: o botão, o Switch na edição ou um
UPDATE direto.

**Funções de permissão passam a exigir pessoa ativa:**
`current_user_is_superadmin()`, `current_user_can_view_all()` e `has_permission()`.

**Novas travas em `protect_superadmin_flag`** (só para chamadas com usuário logado;
`service_role` e SQL direto passam, como saída de emergência):
- ninguém ativa ou desativa o **próprio** acesso;
- o **dono** da empresa não pode ser desativado pela tela;
- só um **administrador** desativa outro administrador (quem tem só `manage_users`, não);
- não dá para desativar o **último administrador ativo**.

### Front

- `src/lib/acesso.ts`: `mensagemErroLogin` e `perfilDesativado`.
- `src/routes/login.tsx`: login recusado por bloqueio mostra "Seu acesso foi desativado.
  Fale com o administrador."
- `src/routes/_app.tsx`: quem já estava logado e foi desativado é deslogado com o mesmo
  aviso. O perfil sai do cache do react-query, senão a pessoa reativada seria expulsa de
  novo ao logar na mesma aba.
- `src/hooks/useCurrentUser.ts`: o perfil ganhou `ativo`.
- `src/components/ColaboradoresTab.tsx`: o botão Desativar e o Switch "Ativo" ficam
  travados na **própria** ficha, para qualquer pessoa (antes, só para superadmin).
- `fetchColaboradores` lê `company_members` sem filtrar ativo, para o papel do inativo
  continuar aparecendo.

---

## Quanto tempo leva para cortar

| Caminho | Corte |
|---|---|
| Dados pelo app (RLS, RPCs) | Na hora: as funções de permissão já negam |
| Edge functions (validam por `auth.getUser()`) | Na hora: a sessão do JWT foi apagada |
| Login novo e renovação de token | Na hora: bloqueio no Auth |
| Token já emitido usado direto no PostgREST | Até 1 h (tempo de vida do JWT), mas o banco já nega os dados |

---

## Limites conhecidos

- **Reativar religa todos os vínculos da pessoa com todas as empresas.** Hoje só existe
  uma empresa, então não afeta.
- **O bloqueio de login é do Auth do Supabase.** O teste no banco confere o
  `banned_until`, mas não o GoTrue em si. Vale testar uma vez com um usuário de teste:
  desativar e tentar entrar.
- **Mensagens de erro:** as antigas de `protect_superadmin_flag` continuam sem acento,
  como estavam em produção.

---

## Testes

- `src/lib/acesso.test.ts` (vitest): mensagem do login bloqueado e regra de expulsão.
- `supabase/tests/desativar_colaborador.test.sql`: roda no banco dentro de `BEGIN/ROLLBACK`,
  com dois administradores que não são donos (A desativa B). Confere:
  - vínculo desligado, login bloqueado e sessões apagadas;
  - desativado perde admin, membro, atendimentos, configs e permissões avulsas;
  - não se reativa sozinho, e admin não se desativa;
  - ninguém desativa o dono;
  - reativar devolve tudo.

  Rodado em produção em 08/10/2026: todos os casos OK, e ninguém ficou afetado
  (os 3 usuários seguem ativos, sem bloqueio e com sessões intactas).
