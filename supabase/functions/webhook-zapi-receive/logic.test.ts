// Testes unitários da lógica pura de criação de atendimento.
// Há DUAS listas independentes de números liberados:
//   - "Sem Triagem" (numeros_sem_triagem): pula TODA interação com o bot.
//   - "Lista de Sessões" (sessoes_triagem): roda o fluxo interno (setor → pessoa).
// Rodar: deno test supabase/functions/webhook-zapi-receive/logic.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  devePularReabertura,
  montarAtendimentoContinuidade,
  montarNovoAtendimento,
  resolverContinuidade,
  resolverModo,
} from "./logic.ts";

const AGORA = "2026-07-21T12:00:00.000Z";
const CLIENT_ID = "cliente-1";
const DEPT_ID = "dept-1";

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

// =============== Continuidade pós-encerramento ===============
// Cliente que responde depois de um atendimento encerrado volta para o setor
// da conversa anterior, sem passar de novo pelo menu de departamentos do bot.

const anterior = (over: Record<string, unknown> = {}) => ({
  id: "atend-anterior",
  current_department_id: DEPT_ID,
  closed_at: "2026-07-21T00:00:00.000Z", // 12h antes de AGORA
  ...over,
});

Deno.test("resolverContinuidade: dentro da janela herda o setor anterior", () => {
  assertEquals(
    resolverContinuidade({ modo: "normal", anterior: anterior(), janelaHoras: 72, agoraIso: AGORA }),
    { anteriorId: "atend-anterior", departmentId: DEPT_ID, horasDesdeFechamento: 12 },
  );
});

Deno.test("resolverContinuidade: fora da janela cai na triagem normal", () => {
  assertEquals(
    resolverContinuidade({ modo: "normal", anterior: anterior(), janelaHoras: 6, agoraIso: AGORA }),
    null,
  );
});

Deno.test("resolverContinuidade: janela zero desliga a continuidade", () => {
  assertEquals(
    resolverContinuidade({ modo: "normal", anterior: anterior(), janelaHoras: 0, agoraIso: AGORA }),
    null,
  );
});

Deno.test("resolverContinuidade: na borda exata da janela ainda continua", () => {
  assertEquals(
    resolverContinuidade({ modo: "normal", anterior: anterior(), janelaHoras: 12, agoraIso: AGORA })
      ?.departmentId,
    DEPT_ID,
  );
});

Deno.test("resolverContinuidade: sem atendimento anterior não há setor para herdar", () => {
  assertEquals(
    resolverContinuidade({ modo: "normal", anterior: null, janelaHoras: 72, agoraIso: AGORA }),
    null,
  );
});

Deno.test("resolverContinuidade: anterior sem departamento cai na triagem", () => {
  assertEquals(
    resolverContinuidade({
      modo: "normal",
      anterior: anterior({ current_department_id: null }),
      janelaHoras: 72,
      agoraIso: AGORA,
    }),
    null,
  );
});

Deno.test("resolverContinuidade: anterior sem closed_at cai na triagem", () => {
  assertEquals(
    resolverContinuidade({
      modo: "normal",
      anterior: anterior({ closed_at: null }),
      janelaHoras: 72,
      agoraIso: AGORA,
    }),
    null,
  );
});

Deno.test("resolverContinuidade: modo sessão sempre reinicia o fluxo interno", () => {
  assertEquals(
    resolverContinuidade({ modo: "sessao", anterior: anterior(), janelaHoras: 72, agoraIso: AGORA }),
    null,
  );
});

Deno.test("resolverContinuidade: modo sem_triagem já não tem menu, não precisa herdar", () => {
  assertEquals(
    resolverContinuidade({
      modo: "sem_triagem",
      anterior: anterior(),
      janelaHoras: 72,
      agoraIso: AGORA,
    }),
    null,
  );
});

Deno.test("resolverContinuidade: fechamento no futuro (relógio torto) não continua", () => {
  assertEquals(
    resolverContinuidade({
      modo: "normal",
      anterior: anterior({ closed_at: "2026-07-22T00:00:00.000Z" }),
      janelaHoras: 72,
      agoraIso: AGORA,
    }),
    null,
  );
});

Deno.test("montarAtendimentoContinuidade: sem último atendente vai para Pendentes do setor", () => {
  assertEquals(montarAtendimentoContinuidade(CLIENT_ID, DEPT_ID, null, AGORA), {
    client_id: CLIENT_ID,
    status: "pendente",
    current_department_id: DEPT_ID,
    assigned_to: null,
    is_sessao: false,
    triagem_estagio: "concluida",
    triagem_started_at: AGORA,
    triagem_finished_at: AGORA,
  });
});

Deno.test("montarAtendimentoContinuidade: com último atendente reserva para ele", () => {
  assertEquals(montarAtendimentoContinuidade(CLIENT_ID, DEPT_ID, "user-9", AGORA), {
    client_id: CLIENT_ID,
    status: "reservado",
    current_department_id: DEPT_ID,
    assigned_to: "user-9",
    assigned_at: AGORA,
    is_sessao: false,
    triagem_estagio: "concluida",
    triagem_started_at: AGORA,
    triagem_finished_at: AGORA,
  });
});
