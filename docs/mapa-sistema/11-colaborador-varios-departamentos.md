# 11 — Colaborador em vários departamentos

> Changeset de **16/10/2026**. Pedido da Tayna: cadastrar o Luiz em "Vendas" e
> "Sem Parar" ao mesmo tempo. Migration `20261016193222_colaborador_multiplos_departamentos`.

---

## Como funciona agora

- Cada pessoa tem **0..N departamentos** na tabela nova `public.user_departments`
  (`user_id`, `department_id`).
- `users.department_id` continua existindo como **departamento principal** (o 1º
  da lista). Telas que mostram um nome só (chat interno, Docs) usam ele.
- Colaborador precisa de pelo menos 1. Administrador pode ter 0 (continua vendo tudo;
  os setores marcados só fazem ele receber o aviso de novo pendente deles).

| Onde | Comportamento |
|---|---|
| Configurações → Colaboradores | Campo "Departamentos" com caixas de marcar. O 1º marcado é o principal. O card mostra todos. Setor de administrador: só o dono muda. |
| Visibilidade (RLS) | Vê o atendimento quem é de **qualquer** setor dele. |
| Fila / Pendentes | Aviso de novo pendente (som no app e WhatsApp pessoal) chega para quem tem o setor, entre outros. |
| Atribuir (Pendentes) e Repassar | A pessoa aparece em cada um dos setores dela. No repasse, o grupo clicado é o setor para onde a conversa vai. |
| Pegar / assumir / receber | Se a conversa já está num setor da pessoa, fica lá; senão vai para o principal dela. Para quem tem 1 setor, igual a antes. |
| Iniciar conversa (botão +) | Quem tem mais de um setor escolhe em qual a conversa começa. |
| "Conversar" (Contatos) | Usa o setor principal. |
| Continuidade do bot | O último atendente vale se ainda é de qualquer um dos setores consultados. |

## Banco

- `user_departments`: RLS de leitura para membros da empresa. Ninguém escreve direto.
- `definir_departamentos_usuario(user, ids[])`: escrita pela tela. Admin ou
  `manage_users`; setor de administrador só o dono muda. Valida que o setor é da empresa.
- `alterar_papel_membro(..., ids[])`: troca de papel com a lista (service_role).
  A versão antiga com um `uuid` continua, para compatibilidade.
- Trigger `trg_users_sincronizar_departamentos`: quem grava `users.department_id`
  direto (escritor antigo) troca a lista inteira por ele. Também espelha o principal
  em `company_members.department_id`.
- `protect_superadmin_flag`: passou a barrar quem não é dono de mudar o setor de
  um administrador, também por UPDATE direto.
- Policies `atendimentos_select`, `mensagens_select`, `timeline_events_select` e
  `mensagem_midia_visivel`: `= ANY ((SELECT meus_departamentos())::uuid[])`.
  O Postgres calcula isso uma vez por consulta (InitPlan), não por linha.
  Medido como colaborador: a listagem de mensagens caiu de ~2,9s para ~1,75s.
- `repassar_atendimento` ganhou `p_department_id` (opcional), validado contra os
  setores do destino.

## Testes

- `supabase/tests/colaborador_multiplos_departamentos.test.sql`: roda no banco
  dentro de `BEGIN/ROLLBACK`. Cobre:
  - visibilidade antes e depois do 2º setor;
  - permissões;
  - lista vazia e setor inválido;
  - escritor antigo;
  - troca de papel, incluindo admin sem setor → colaborador;
  - a trava do dono.
- Deno: `_shared/departamentos.test.ts`, `iniciar-atendimento/logic.test.ts`,
  `alterar-papel-colaborador/logic.test.ts`.
- Vitest: `departamentos-usuario.test.ts`, `colaboradores-filter.test.ts`,
  `edge-functions.test.ts`, `repasse-erro.test.ts`.

## Junto nesta mudança

- A tela de colaboradores agora mostra o motivo real do erro, em vez de "Edge
  Function returned a non-2xx status code". E-mail repetido aparece como
  "Já existe um usuário com este e-mail."
- `criar-colaborador`: quem só tem `manage_users` não cadastra administrador.

## Limites conhecidos

- A tela de plataforma `almore-membros` e os convites gravam só
  `company_members.department_id`, então não mexem em `user_departments`. Hoje essa
  tela não é usada no dia a dia (operação single-tenant).
- Chat interno e Docs mostram só o setor principal.
