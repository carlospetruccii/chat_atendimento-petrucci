// Testes unitários da leitura da lista de departamentos do corpo da requisição.
// Rodar: deno test supabase/functions/_shared/departamentos.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { lerDepartamentos } from "./departamentos.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

Deno.test("lista nova: mantém a ordem (1º é o principal)", () => {
  assertEquals(lerDepartamentos({ department_ids: [B, A] }), { ok: true, ids: [B, A] });
});

Deno.test("lista nova: ignora repetidos, vazios e espaços", () => {
  assertEquals(
    lerDepartamentos({ department_ids: [` ${A} `, "", A, B, null] }),
    { ok: true, ids: [A, B] },
  );
});

Deno.test("formato antigo: department_id único vira lista de um", () => {
  assertEquals(lerDepartamentos({ department_id: A }), { ok: true, ids: [A] });
});

Deno.test("sem nada (ou null): lista vazia", () => {
  assertEquals(lerDepartamentos({}), { ok: true, ids: [] });
  assertEquals(lerDepartamentos({ department_id: null }), { ok: true, ids: [] });
  assertEquals(lerDepartamentos({ department_ids: [] }), { ok: true, ids: [] });
});

Deno.test("lista nova tem prioridade sobre o campo antigo", () => {
  assertEquals(
    lerDepartamentos({ department_ids: [B], department_id: A }),
    { ok: true, ids: [B] },
  );
});

Deno.test("recusa id que não é uuid", () => {
  assertEquals(lerDepartamentos({ department_ids: [A, "vendas"] }).ok, false);
  assertEquals(lerDepartamentos({ department_id: "x" }).ok, false);
});

Deno.test("recusa department_ids que não é lista", () => {
  assertEquals(lerDepartamentos({ department_ids: A }).ok, false);
});

Deno.test("recusa lista grande demais", () => {
  const muitos = Array.from({ length: 51 }, (_, i) =>
    `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`
  );
  assertEquals(lerDepartamentos({ department_ids: muitos }).ok, false);
});
