import { describe, expect, test } from "vitest";
import { filtrarColaboradores, type ColaboradorFiltravel } from "./colaboradores-filter";

const colaboradores: ColaboradorFiltravel[] = [
  {
    id: "ativo",
    nome: "Ana Ativa",
    email: "ana@almore.com",
    department_ids: ["comercial"],
    status: "ativo",
  },
  {
    id: "indisponivel",
    nome: "Bruno Indisponível",
    email: "bruno@almore.com",
    department_ids: ["comercial"],
    status: "indisponivel",
  },
  {
    id: "inativo",
    nome: "Carla Inativa",
    email: "carla@almore.com",
    department_ids: ["suporte"],
    status: "inativo",
  },
  {
    id: "dois-setores",
    nome: "Luiz Dois Setores",
    email: "luiz@almore.com",
    department_ids: ["vendas", "suporte"],
    status: "ativo",
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

    expect(resultado.map((colaborador) => colaborador.id)).toEqual([
      "ativo",
      "indisponivel",
      "dois-setores",
    ]);
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
      "dois-setores",
    ]);
  });

  test("filtro de departamento acha quem tem o setor entre vários", () => {
    const resultado = filtrarColaboradores(colaboradores, {
      busca: "",
      departamentoId: "suporte",
      status: "Todos",
      mostrarInativos: true,
    });

    expect(resultado.map((colaborador) => colaborador.id)).toEqual(["inativo", "dois-setores"]);
  });
});
