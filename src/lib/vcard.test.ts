import { describe, expect, test } from "vitest";
import { lerVcard } from "./vcard";

describe("lerVcard", () => {
  test("usa o waid do TEL como número (é o id real do WhatsApp)", () => {
    const vcard =
      "BEGIN:VCARD\nVERSION:3.0\nN:;Contador Mario;;;\nFN:Contador Mario\nTEL;type=CELL;waid=559184008486:+55 91 8400-8486\nEND:VCARD";

    expect(lerVcard(vcard, null)).toEqual({
      nome: "Contador Mario",
      telefones: ["+559184008486"],
    });
  });

  test("aceita TEL com prefixo itemN. do iPhone", () => {
    const vcard =
      "BEGIN:VCARD\nVERSION:3.0\nFN:Paulo - UNIPRIME\nitem1.TEL;waid=554532403257:+55 45 3240-3257\nitem1.X-ABLabel:Celular\nEND:VCARD";

    expect(lerVcard(vcard, null).telefones).toEqual(["+554532403257"]);
  });

  test("sem waid, normaliza o valor do TEL", () => {
    const vcard = "BEGIN:VCARD\r\nFN:Ana\r\nTEL;type=CELL:(11) 99999-8888\r\nEND:VCARD";

    expect(lerVcard(vcard, null)).toEqual({ nome: "Ana", telefones: ["+5511999998888"] });
  });

  test("não repete o mesmo número e ignora TEL inválido", () => {
    const vcard =
      "BEGIN:VCARD\nFN:Bia\nTEL;waid=5511999998888:+55 11 99999-8888\nTEL:+55 11 99999-8888\nTEL:123\nEND:VCARD";

    expect(lerVcard(vcard, null).telefones).toEqual(["+5511999998888"]);
  });

  test("sem FN, cai no nome de fallback (displayName da mensagem)", () => {
    const vcard = "BEGIN:VCARD\nTEL;waid=5511999998888:x\nEND:VCARD";

    expect(lerVcard(vcard, "  Fulano  ").nome).toBe("Fulano");
  });

  test("vcard ausente devolve só o nome de fallback", () => {
    expect(lerVcard(null, "Fulano")).toEqual({ nome: "Fulano", telefones: [] });
    expect(lerVcard(undefined, null)).toEqual({ nome: null, telefones: [] });
  });

  test("desfaz o escape de vírgula e ponto e vírgula do FN", () => {
    const vcard = "BEGIN:VCARD\nFN:Silva\\, João\\; Jr\nEND:VCARD";

    expect(lerVcard(vcard, null).nome).toBe("Silva, João; Jr");
  });
});
