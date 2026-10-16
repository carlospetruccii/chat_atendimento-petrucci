// Leitura da lista de departamentos de uma pessoa no corpo da requisição.
// Aceita o formato novo (`department_ids`, lista; o 1º é o principal) e o
// antigo (`department_id`, um só), para o front ainda não atualizado.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DEPARTAMENTOS = 50;

export type LeituraDepartamentos =
  | { ok: true; ids: string[] }
  | { ok: false; error: string };

export function lerDepartamentos(body: {
  department_ids?: unknown;
  department_id?: unknown;
}): LeituraDepartamentos {
  let brutos: unknown[];
  if (body.department_ids !== undefined && body.department_ids !== null) {
    if (!Array.isArray(body.department_ids)) {
      return { ok: false, error: "department_ids precisa ser uma lista" };
    }
    brutos = body.department_ids;
  } else {
    brutos = body.department_id == null ? [] : [body.department_id];
  }

  const ids: string[] = [];
  for (const bruto of brutos) {
    if (bruto == null) continue;
    if (typeof bruto !== "string") return { ok: false, error: "Departamento inválido" };
    const id = bruto.trim();
    if (!id) continue;
    if (!UUID_RE.test(id)) return { ok: false, error: "Departamento inválido" };
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > MAX_DEPARTAMENTOS) {
    return { ok: false, error: "Departamentos demais" };
  }
  return { ok: true, ids };
}
