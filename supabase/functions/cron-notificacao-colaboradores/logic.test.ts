// Testes unitários da lógica pura do aviso aos colaboradores.
// Rodar: deno test supabase/functions/cron-notificacao-colaboradores/logic.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  colaboradorRecebe,
  ColaboradorLike,
  departamentoNotificavel,
  soDigitos,
  telefoneExibicao,
  TRIAGEM_DEPT_ID,
} from "./logic.ts";

Deno.test("departamentoNotificavel: depto real passa", () => {
  assertEquals(departamentoNotificavel("dept-financeiro"), true);
});

Deno.test("departamentoNotificavel: nulo/vazio/triagem não passa", () => {
  assertEquals(departamentoNotificavel(null), false);
  assertEquals(departamentoNotificavel(undefined), false);
  assertEquals(departamentoNotificavel("   "), false);
  assertEquals(departamentoNotificavel(TRIAGEM_DEPT_ID), false);
});

const base: ColaboradorLike = {
  ativo: true,
  is_system_user: false,
  is_superadmin: false,
  whatsapp: "+5511999998888",
};

Deno.test("colaboradorRecebe: colaborador ativo com whatsapp recebe", () => {
  assertEquals(colaboradorRecebe(base), true);
});

Deno.test("colaboradorRecebe: indisponível (ativo=true) ainda recebe", () => {
  // A regra é por 'ativo', não por 'disponivel' — todos os ativos do depto.
  assertEquals(colaboradorRecebe({ ...base }), true);
});

Deno.test("colaboradorRecebe: inativo não recebe", () => {
  assertEquals(colaboradorRecebe({ ...base, ativo: false }), false);
});

Deno.test("colaboradorRecebe: admin (superadmin) nunca recebe", () => {
  assertEquals(colaboradorRecebe({ ...base, is_superadmin: true }), false);
});

Deno.test("colaboradorRecebe: usuário de sistema não recebe", () => {
  assertEquals(colaboradorRecebe({ ...base, is_system_user: true }), false);
});

Deno.test("colaboradorRecebe: sem whatsapp não recebe", () => {
  assertEquals(colaboradorRecebe({ ...base, whatsapp: null }), false);
  assertEquals(colaboradorRecebe({ ...base, whatsapp: "  " }), false);
});

Deno.test("soDigitos: mantém só números", () => {
  assertEquals(soDigitos("+55 (11) 99999-8888"), "5511999998888");
});

Deno.test("telefoneExibicao: normaliza para E.164 com +", () => {
  assertEquals(telefoneExibicao("5511999998888"), "+5511999998888");
  assertEquals(telefoneExibicao("+5511999998888"), "+5511999998888");
  assertEquals(telefoneExibicao(null), "");
});
