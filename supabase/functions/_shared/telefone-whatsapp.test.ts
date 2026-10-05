// Rodar: deno test supabase/functions/_shared/telefone-whatsapp.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  conflitoDeIdentidadeCliente,
  numeroCanonicoWhatsapp,
  numerosWhatsappEquivalentes,
  selecionarRegistroPorNumeroWhatsapp,
  variantesNumeroWhatsappBR,
} from "./telefone-whatsapp.ts";

Deno.test(
  "variantesNumeroWhatsappBR: celular BR com 9 retorna o exato primeiro e a variante sem 9",
  () => {
    assertEquals(variantesNumeroWhatsappBR("+5545999467847"), ["+5545999467847", "+554599467847"]);
  },
);

Deno.test(
  "variantesNumeroWhatsappBR: celular BR sem 9 retorna o exato primeiro e a variante com 9",
  () => {
    assertEquals(variantesNumeroWhatsappBR("+554599467847"), ["+554599467847", "+5545999467847"]);
  },
);

Deno.test("variantesNumeroWhatsappBR: telefone fixo BR não ganha o nono dígito", () => {
  assertEquals(variantesNumeroWhatsappBR("+554532345678"), ["+554532345678"]);
});

Deno.test("variantesNumeroWhatsappBR: número não-BR fica apenas com a forma exata", () => {
  assertEquals(variantesNumeroWhatsappBR("+14155552671"), ["+14155552671"]);
});

Deno.test("variantesNumeroWhatsappBR: entrada inválida não produz variantes", () => {
  assertEquals(variantesNumeroWhatsappBR("não-é-telefone"), []);
});

Deno.test("numeroCanonicoWhatsapp: as duas formas móveis BR usam a forma com 9", () => {
  assertEquals(numeroCanonicoWhatsapp("+5545999467847"), "+5545999467847");
  assertEquals(numeroCanonicoWhatsapp("+554599467847"), "+5545999467847");
});

Deno.test("numerosWhatsappEquivalentes: aceita apenas o mesmo telefone ou sua variante BR", () => {
  assertEquals(numerosWhatsappEquivalentes("+5545999467847", "+554599467847"), true);
  assertEquals(numerosWhatsappEquivalentes("+5545999467847", "+5545988887777"), false);
});

Deno.test(
  "selecionarRegistroPorNumeroWhatsapp: reaproveita o cliente da variante existente",
  () => {
    const giovana = { id: "cliente-giovana", numero_whatsapp: "+554599467847" };

    assertEquals(selecionarRegistroPorNumeroWhatsapp([giovana], "+5545999467847"), giovana);
  },
);

Deno.test(
  "selecionarRegistroPorNumeroWhatsapp: usa a forma canônica entre duplicados legados",
  () => {
    const semNove = { id: "sem-9", numero_whatsapp: "+554599467847" };
    const comNove = { id: "com-9", numero_whatsapp: "+5545999467847" };

    assertEquals(selecionarRegistroPorNumeroWhatsapp([semNove, comNove], "+554599467847"), comNove);
  },
);

Deno.test(
  "conflitoDeIdentidadeCliente: duplicado legado sem LID não é conflito — o LID vence",
  () => {
    // Caso real do LabAGrill: o mesmo número gravado nas duas formas BR, só a
    // linha sem o nono dígito carregando o LID do chat.
    const porLid = { id: "sem-9", numero_whatsapp: "+553172686554" };
    const porNumero = { id: "com-9", chat_lid: null };

    assertEquals(
      conflitoDeIdentidadeCliente(porLid, porNumero, "+553172686554", "201623682961562"),
      false,
    );
  },
);

Deno.test(
  "conflitoDeIdentidadeCliente: outra linha com LID próprio é conflito de verdade",
  () => {
    const porLid = { id: "sem-9", numero_whatsapp: "+553172686554" };
    const porNumero = { id: "com-9", chat_lid: "999999999999" };

    assertEquals(
      conflitoDeIdentidadeCliente(porLid, porNumero, "+553172686554", "201623682961562"),
      true,
    );
  },
);

Deno.test("conflitoDeIdentidadeCliente: número não equivalente é conflito", () => {
  const porLid = { id: "outro", numero_whatsapp: "+5511988887777" };

  assertEquals(
    conflitoDeIdentidadeCliente(porLid, null, "+553172686554", "201623682961562"),
    true,
  );
});

Deno.test("conflitoDeIdentidadeCliente: mesma linha achada pelos dois caminhos não é conflito", () => {
  const porLid = { id: "mesma", numero_whatsapp: "+553172686554" };
  const porNumero = { id: "mesma", chat_lid: "201623682961562" };

  assertEquals(
    conflitoDeIdentidadeCliente(porLid, porNumero, "+5531972686554", "201623682961562"),
    false,
  );
});
