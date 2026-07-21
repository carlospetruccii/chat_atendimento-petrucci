// Testes unitários da lógica pura de criação de atendimento a partir da
// Lista de Sessões (normal / sessão / sem triagem).
// Rodar: deno test supabase/functions/webhook-zapi-receive/logic.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { devePularReabertura, montarNovoAtendimento, resolverModoSessao } from "./logic.ts";

const AGORA = "2026-07-21T12:00:00.000Z";
const CLIENT_ID = "cliente-1";

Deno.test("resolverModoSessao: número fora da lista é normal", () => {
  assertEquals(resolverModoSessao(null), "normal");
});

Deno.test("resolverModoSessao: número na lista sem sem_triagem é modo sessão", () => {
  assertEquals(resolverModoSessao({ sem_triagem: false }), "sessao");
});

Deno.test("resolverModoSessao: número marcado sem_triagem é modo sem_triagem", () => {
  assertEquals(resolverModoSessao({ sem_triagem: true }), "sem_triagem");
});

Deno.test("montarNovoAtendimento: modo normal não é sessão nem vem concluído", () => {
  const r = montarNovoAtendimento(CLIENT_ID, "normal", AGORA);
  assertEquals(r, {
    client_id: CLIENT_ID,
    status: "em_triagem",
    current_department_id: null,
    assigned_to: null,
    triagem_started_at: AGORA,
    is_sessao: false,
  });
});

Deno.test("montarNovoAtendimento: modo sessao marca is_sessao", () => {
  const r = montarNovoAtendimento(CLIENT_ID, "sessao", AGORA);
  assertEquals(r, {
    client_id: CLIENT_ID,
    status: "em_triagem",
    current_department_id: null,
    assigned_to: null,
    triagem_started_at: AGORA,
    is_sessao: true,
  });
});

Deno.test("montarNovoAtendimento: modo sem_triagem já nasce concluído, sem is_sessao", () => {
  const r = montarNovoAtendimento(CLIENT_ID, "sem_triagem", AGORA);
  assertEquals(r, {
    client_id: CLIENT_ID,
    status: "em_triagem",
    current_department_id: null,
    assigned_to: null,
    triagem_started_at: AGORA,
    is_sessao: false,
    triagem_estagio: "concluida",
    triagem_finished_at: AGORA,
  });
});

Deno.test("devePularReabertura: modo sessão pula (pode querer falar com outra pessoa)", () => {
  assertEquals(devePularReabertura("sessao"), true);
});

Deno.test("devePularReabertura: modo normal não pula", () => {
  assertEquals(devePularReabertura("normal"), false);
});

Deno.test("devePularReabertura: modo sem_triagem não pula (mantém continuidade da conversa)", () => {
  assertEquals(devePularReabertura("sem_triagem"), false);
});
