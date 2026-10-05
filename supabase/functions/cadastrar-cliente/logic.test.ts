import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { podeCadastrarCliente, podeRenomearClienteExistente } from "./logic.ts";

// Modo single: é o primeiro passo do botão "Conversar" na tela de Contatos.
// Qualquer membro ativo precisa poder criar o cliente para abrir a conversa.

Deno.test("colaborador sem permissão administrativa pode cadastrar um contato avulso", () => {
  assertEquals(
    podeCadastrarCliente({ isSuperadmin: false, hasViewAllDepartments: false, modo: "single" }),
    true,
  );
});

Deno.test("superadmin pode cadastrar um contato avulso", () => {
  assertEquals(
    podeCadastrarCliente({ isSuperadmin: true, hasViewAllDepartments: false, modo: "single" }),
    true,
  );
});

// Modo csv_batch: importar base inteira continua sendo ação administrativa.

Deno.test("superadmin pode importar em lote", () => {
  assertEquals(
    podeCadastrarCliente({ isSuperadmin: true, hasViewAllDepartments: false, modo: "csv_batch" }),
    true,
  );
});

Deno.test("usuário com view_all_departments pode importar em lote", () => {
  assertEquals(
    podeCadastrarCliente({ isSuperadmin: false, hasViewAllDepartments: true, modo: "csv_batch" }),
    true,
  );
});

Deno.test("colaborador sem permissão administrativa não pode importar em lote", () => {
  assertEquals(
    podeCadastrarCliente({ isSuperadmin: false, hasViewAllDepartments: false, modo: "csv_batch" }),
    false,
  );
});

// Renomear quem já existe muda o nome que a equipe inteira vê: fica com admin.

Deno.test("colaborador sem permissão administrativa não renomeia cliente existente", () => {
  assertEquals(
    podeRenomearClienteExistente({ isSuperadmin: false, hasViewAllDepartments: false }),
    false,
  );
});

Deno.test("superadmin renomeia cliente existente", () => {
  assertEquals(
    podeRenomearClienteExistente({ isSuperadmin: true, hasViewAllDepartments: false }),
    true,
  );
});

Deno.test("usuário com view_all_departments renomeia cliente existente", () => {
  assertEquals(
    podeRenomearClienteExistente({ isSuperadmin: false, hasViewAllDepartments: true }),
    true,
  );
});
