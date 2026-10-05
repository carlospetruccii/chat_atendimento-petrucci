// Testes unitários da lógica pura do aviso aos colaboradores.
// Rodar: deno test supabase/functions/cron-notificacao-colaboradores/logic.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  alvoDoAviso,
  colaboradorRecebe,
  ColaboradorLike,
  departamentoNotificavel,
  indexarReservasHumanas,
  reservaFeitaPeloBot,
  soDigitos,
  telefoneExibicao,
  TRIAGEM_DEPT_ID,
} from "./logic.ts";

const USER = "2147272d-3bc5-4d40-abe6-d42372616d21";

Deno.test("alvoDoAviso: pendente avisa o setor inteiro", () => {
  assertEquals(alvoDoAviso("pendente", null), { modo: "setor" });
  // Pendente ignora assigned_to residual — quem manda é o status.
  assertEquals(alvoDoAviso("pendente", USER), { modo: "setor" });
});

Deno.test("alvoDoAviso: reservado avisa só o dono da reserva", () => {
  assertEquals(alvoDoAviso("reservado", USER), { modo: "reservado", userId: USER });
});

Deno.test("alvoDoAviso: reservado sem dono não avisa ninguém", () => {
  assertEquals(alvoDoAviso("reservado", null), null);
  assertEquals(alvoDoAviso("reservado", "   "), null);
});

// ── Reserva do bot vs. reserva humana ───────────────────────────────────────
const AT = "7d9ef095-59cd-42e9-91bc-fa51f3b94e6a";
const OUTRO = "15d58f66-c8d5-422c-a618-d2712b9029ed";

Deno.test("reservaFeitaPeloBot: sem nenhum evento é reserva do bot", () => {
  const idx = indexarReservasHumanas([]);
  assertEquals(reservaFeitaPeloBot(idx, AT, USER), true);
});

Deno.test("reservaFeitaPeloBot: repasse humano NÃO é do bot (notificar-repasse já avisou)", () => {
  const idx = indexarReservasHumanas([
    { atendimento_id: AT, target_user_id: USER, actor_user_id: OUTRO },
  ]);
  assertEquals(reservaFeitaPeloBot(idx, AT, USER), false);
});

Deno.test("reservaFeitaPeloBot: claim_pendente (ator = destino) NÃO é do bot", () => {
  // Colaborador clicou "atender" pra si — avisá-lo seria spam.
  const idx = indexarReservasHumanas([
    { atendimento_id: AT, target_user_id: USER, actor_user_id: USER },
  ]);
  assertEquals(reservaFeitaPeloBot(idx, AT, USER), false);
});

Deno.test("reservaFeitaPeloBot: evento sem ator (continuidade/reabertura do bot) segue notificável", () => {
  const idx = indexarReservasHumanas([
    { atendimento_id: AT, target_user_id: USER, actor_user_id: null },
  ]);
  assertEquals(reservaFeitaPeloBot(idx, AT, USER), true);
});

Deno.test("reservaFeitaPeloBot: evento humano de OUTRO dono não suprime este", () => {
  const idx = indexarReservasHumanas([
    { atendimento_id: AT, target_user_id: OUTRO, actor_user_id: OUTRO },
  ]);
  assertEquals(reservaFeitaPeloBot(idx, AT, USER), true);
});

Deno.test("reservaFeitaPeloBot: evento de OUTRO atendimento não suprime este", () => {
  const idx = indexarReservasHumanas([
    { atendimento_id: "outro-atendimento", target_user_id: USER, actor_user_id: OUTRO },
  ]);
  assertEquals(reservaFeitaPeloBot(idx, AT, USER), true);
});

Deno.test("indexarReservasHumanas: ignora evento sem destino", () => {
  // Repasse para DEPARTAMENTO (sem dono) não reserva ninguém.
  const idx = indexarReservasHumanas([
    { atendimento_id: AT, target_user_id: null, actor_user_id: OUTRO },
  ]);
  assertEquals(idx.size, 0);
});

Deno.test("alvoDoAviso: outros status não avisam", () => {
  assertEquals(alvoDoAviso("em_triagem", null), null);
  assertEquals(alvoDoAviso("em_atendimento", USER), null);
  assertEquals(alvoDoAviso("encerrado", USER), null);
  assertEquals(alvoDoAviso(null, null), null);
});

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
