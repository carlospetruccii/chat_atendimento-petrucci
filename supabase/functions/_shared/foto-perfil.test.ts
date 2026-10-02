// Rodar: deno test supabase/functions/_shared/foto-perfil.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ESPERA_APOS_FALHA_MS,
  FOTO_TTL_MS,
  fotoDoChat,
  fotoVencida,
  instanteDeNovaTentativa,
  lerFotoGrupo,
} from "./foto-perfil.ts";

Deno.test("fotoDoChat: prefere a miniatura e aceita só https", () => {
  assertEquals(
    fotoDoChat({ imagePreview: "https://pps.whatsapp.net/p.jpg", image: "https://pps.whatsapp.net/f.jpg" }),
    "https://pps.whatsapp.net/p.jpg",
  );
  assertEquals(fotoDoChat({ image: "https://pps.whatsapp.net/f.jpg" }), "https://pps.whatsapp.net/f.jpg");
  assertEquals(fotoDoChat({ imgUrl: "https://x.net/g.jpg" }), "https://x.net/g.jpg");
});

Deno.test("fotoDoChat: ignora vazio, http, javascript: e não-objeto", () => {
  assertEquals(fotoDoChat({ image: "" }), null);
  assertEquals(fotoDoChat({ image: "http://x.net/a.jpg" }), null);
  assertEquals(fotoDoChat({ image: "javascript:alert(1)" }), null);
  assertEquals(fotoDoChat({ image: "data:image/png;base64,AAA" }), null);
  assertEquals(fotoDoChat(null), null);
  assertEquals(fotoDoChat("https://x.net/a.jpg"), null);
});

Deno.test("fotoVencida: nunca buscada ou mais velha que o TTL", () => {
  const agora = Date.parse("2026-10-02T12:00:00Z");
  assertEquals(fotoVencida(null, agora), true);
  assertEquals(fotoVencida("lixo", agora), true);
  assertEquals(fotoVencida(new Date(agora - FOTO_TTL_MS - 1).toISOString(), agora), true);
  assertEquals(fotoVencida(new Date(agora - 60_000).toISOString(), agora), false);
});

Deno.test("instanteDeNovaTentativa: segura a foto até a espera pós-falha passar", () => {
  const agora = Date.parse("2026-10-02T12:00:00Z");
  const marcado = instanteDeNovaTentativa(agora);
  assertEquals(fotoVencida(marcado, agora), false);
  assertEquals(fotoVencida(marcado, agora + ESPERA_APOS_FALHA_MS - 60_000), false);
  assertEquals(fotoVencida(marcado, agora + ESPERA_APOS_FALHA_MS + 60_000), true);
});

Deno.test("fotoDoChat: aceita os campos persistidos de grupo", () => {
  assertEquals(fotoDoChat({ image_preview_url: "https://u.example/p.jpg" }), "https://u.example/p.jpg");
  assertEquals(fotoDoChat({ image_url: "https://u.example/f.jpg" }), "https://u.example/f.jpg");
});

Deno.test("lerFotoGrupo: foto persistida, grupo sem foto, ou ainda não consultado", () => {
  assertEquals(lerFotoGrupo({ image_preview_url: "https://u.example/p.jpg" }), {
    url: "https://u.example/p.jpg",
    semFoto: false,
  });
  assertEquals(lerFotoGrupo({ picture_empty_at: "2026-10-02T18:00:00Z" }), { url: null, semFoto: true });
  assertEquals(lerFotoGrupo({ Name: "Grupo" }), { url: null, semFoto: false });
  // Envelope { group: {...} } também vale.
  assertEquals(lerFotoGrupo({ group: { picture_empty_at: 1 } }), { url: null, semFoto: true });
});
