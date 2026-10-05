// Rodar: deno test --allow-env supabase/functions/_shared/docs-aviso.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  cortePorIntervalo,
  deveAvisar,
  escolherVersao,
  INTERVALO_AVISO_MS,
  travaAposFalha,
} from "./docs-aviso.ts";

Deno.test("intervalo é de 3 horas", () => {
  assertEquals(INTERVALO_AVISO_MS, 3 * 60 * 60 * 1000);
});

Deno.test("corte = agora menos 3h, em ISO", () => {
  const agora = Date.parse("2026-09-30T15:00:00.000Z");
  assertEquals(cortePorIntervalo(agora), "2026-09-30T12:00:00.000Z");
});

Deno.test("só avisa conversa sem dono (quem tem dono já está sendo atendido)", () => {
  assertEquals(deveAvisar("sem_dono"), true);
  assertEquals(deveAvisar("so_envio"), true);
  assertEquals(deveAvisar("encerrada"), true);
  assertEquals(deveAvisar("em_andamento"), false);
});

Deno.test("versão: só texto principal quando não há variações; ignora vazias", () => {
  assertEquals(escolherVersao("principal", [], () => 0.9), "principal");
  assertEquals(escolherVersao("principal", ["  ", ""], () => 0.9), "principal");
  assertEquals(escolherVersao("a", ["b", "c"], () => 0), "a");
  assertEquals(escolherVersao("a", ["b", "c"], () => 0.99), "c");
  assertEquals(escolherVersao("   ", [], () => 0), null);
});

Deno.test("depois de falha, a trava vence em 10 min (não a cada mensagem)", () => {
  const agora = Date.parse("2026-09-30T15:00:00.000Z");
  const trava = Date.parse(travaAposFalha(agora));
  // ainda bloqueia agora...
  assertEquals(trava > Date.parse(cortePorIntervalo(agora)), true);
  // ...e libera 10 min depois
  assertEquals(trava < Date.parse(cortePorIntervalo(agora + 10 * 60 * 1000 + 1)), true);
});
