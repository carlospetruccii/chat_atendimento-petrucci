// Texto do toast depois de cadastrar cliente/contato avulso. Colaborador comum
// não renomeia cliente que já existe (cadastrar-cliente), então "atualizado"
// só aparece quando o nome mudou de verdade.

interface ResultadoCadastro {
  criado: boolean;
  atualizado: boolean;
}

export function avisoCadastro(r: ResultadoCadastro, item: "Cliente" | "Contato"): string {
  if (r.criado) return item === "Contato" ? "Contato adicionado" : "Cliente cadastrado";
  if (r.atualizado) return `${item} atualizado`;
  return `${item} já estava cadastrado`;
}
