import { describe, expect, test } from "vitest";
import { deveSincronizar, INTERVALO_SYNC_MS } from "./grupos-auto-sync";

const AGORA = Date.parse("2026-07-27T13:00:00Z");

function estado(over: Partial<Parameters<typeof deveSincronizar>[0]> = {}) {
  return {
    grupos: [{ syncedAt: new Date(AGORA - 60_000).toISOString() }],
    agoraMs: AGORA,
    sincronizando: false,
    jaTentou: false,
    ...over,
  };
}

describe("deveSincronizar", () => {
  test("lista vazia: sincroniza para popular", () => {
    expect(deveSincronizar(estado({ grupos: [] }))).toBe(true);
  });

  test("sincronizado agora há pouco: não sincroniza", () => {
    expect(deveSincronizar(estado())).toBe(false);
  });

  test("carimbo mais velho que a janela: sincroniza", () => {
    const velho = new Date(AGORA - INTERVALO_SYNC_MS - 1_000).toISOString();
    expect(deveSincronizar(estado({ grupos: [{ syncedAt: velho }] }))).toBe(true);
  });

  test("exatamente na janela ainda não sincroniza (só depois de passar)", () => {
    const naBorda = new Date(AGORA - INTERVALO_SYNC_MS).toISOString();
    expect(deveSincronizar(estado({ grupos: [{ syncedAt: naBorda }] }))).toBe(false);
  });

  test("grupo sem carimbo (criado pelo webhook) pede sincronização", () => {
    expect(deveSincronizar(estado({ grupos: [{ syncedAt: null }] }))).toBe(true);
  });

  test("mistura: um sincronizado e um sem carimbo ainda pede", () => {
    const grupos = [{ syncedAt: new Date(AGORA).toISOString() }, { syncedAt: null }];
    expect(deveSincronizar(estado({ grupos }))).toBe(true);
  });

  test("usa o carimbo MAIS RECENTE, não o mais antigo", () => {
    const velho = new Date(AGORA - INTERVALO_SYNC_MS - 1_000).toISOString();
    const novo = new Date(AGORA - 1_000).toISOString();
    expect(deveSincronizar(estado({ grupos: [{ syncedAt: velho }, { syncedAt: novo }] }))).toBe(
      false,
    );
  });

  test("já sincronizando: não dispara de novo", () => {
    expect(deveSincronizar(estado({ grupos: [], sincronizando: true }))).toBe(false);
  });

  test("já tentou nesta montagem: não repete (evita laço se der erro)", () => {
    expect(deveSincronizar(estado({ grupos: [], jaTentou: true }))).toBe(false);
  });

  test("carimbo inválido é tratado como ausente", () => {
    expect(deveSincronizar(estado({ grupos: [{ syncedAt: "não é data" }] }))).toBe(true);
  });
});
