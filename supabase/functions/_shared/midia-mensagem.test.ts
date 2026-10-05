// Testes do roteamento por escopo da mídia: tabela, pasta no bucket e número.
// Rodar: deno test --allow-env supabase/functions/_shared/midia-mensagem.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { instanciaDe, pastaDe, tabelaDe } from "./midia-mensagem.ts";

Deno.test("docs: tabela própria, pasta docs/ e número financeiro", () => {
  assertEquals(tabelaDe("docs"), "docs_mensagens");
  assertEquals(pastaDe("docs", "c1"), "docs/c1");
  assertEquals(instanciaDe("docs"), "financeiro");
});

Deno.test("individual e grupo continuam como antes, no número principal", () => {
  assertEquals(tabelaDe("individual"), "mensagens");
  assertEquals(pastaDe("individual", "a1"), "a1");
  assertEquals(tabelaDe("grupo"), "grupo_mensagens");
  assertEquals(pastaDe("grupo", "g1"), "grupos/g1");
  assertEquals(instanciaDe("individual"), "principal");
  assertEquals(instanciaDe("grupo"), "principal");
});
