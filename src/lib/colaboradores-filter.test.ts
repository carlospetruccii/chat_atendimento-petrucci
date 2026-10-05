import { describe, expect, test } from "vitest";
import { filtrarColaboradores, type ColaboradorFiltravel } from "./colaboradores-filter";

const colaboradores: ColaboradorFiltravel[] = [
  {
    id: "ativo",
    nome: "Ana Ativa",
    email: "ana@almore.com",
    department_id: "comercial",
    status: "ativo",
  },
  {
    id: "indisponivel",
    nome: "Bruno Indisponível",
    email: "bruno@almore.com",
    department_id: "comercial",
    status: "indisponivel",
  },
  {
    id: "inativo",
    nome: "Carla Inativa",
    email: "carla@almore.com",
    department_id: "suporte",
    status: "inativo",
  },
];

describe("filtrarColaboradores", () => {
  test("oculta colaboradores inativos enquanto o filtro Inativos está desativado", () => {
    const resultado = filtrarColaboradores(colaboradores, {
      busca: "",
      departamentoId: "Todos",
      status: "Todos",
      mostrarInativos: false,
    });

    expect(resultado.map((colaborador) => colaborador.id)).toEqual(["ativo", "indisponivel"]);
  });

  test("inclui colaboradores inativos quando o filtro Inativos está ativado", () => {
    const resultado = filtrarColaboradores(colaboradores, {
      busca: "",
      departamentoId: "Todos",
      status: "Todos",
      mostrarInativos: true,
    });

    expect(resultado.map((colaborador) => colaborador.id)).toEqual([
      "ativo",
      "indisponivel",
      "inativo",
    ]);
  });
});
