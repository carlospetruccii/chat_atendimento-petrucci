// Testes unitários da lógica pura de criação de atendimento.
// Há DUAS listas independentes de números liberados:
//   - "Sem Triagem" (numeros_sem_triagem): pula TODA interação com o bot.
//   - "Lista de Sessões" (sessoes_triagem): roda o fluxo interno (setor → pessoa).
// Rodar: deno test supabase/functions/webhook-zapi-receive/logic.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { devePularReabertura, montarNovoAtendimento, resolverModo } from "./logic.ts";

const AGORA = "2026-07-21T12:00:00.000Z";
const CLIENT_ID = "cliente-1";

Deno.test("resolverModo: fora das duas listas é normal", () => {
  assertEquals(resolverModo(false, false), "normal");
});

Deno.test("resolverModo: só na Lista de Sessões é modo sessão", () => {
  assertEquals(resolverModo(false, true), "sessao");
});

Deno.test("resolverModo: na lista Sem Triagem é modo sem_triagem", () => {
  assertEquals(resolverModo(true, false), "sem_triagem");
});

Deno.test("resolverModo: Sem Triagem tem prioridade se estiver nas duas", () => {
  assertEquals(resolverModo(true, true), "sem_triagem");
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
