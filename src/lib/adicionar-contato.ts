import { cadastrarClienteSingle, type CadastrarClienteSingleResp } from "@/lib/clientes-queries";
import { normalizarE164 } from "@/lib/phone";

export interface AdicionarContatoInput {
  nome: string;
  telefone: string;
}

export interface AdicionarContatoErrors {
  nome?: string;
  telefone?: string;
}

type CadastrarContato = (nome: string, telefone: string) => Promise<CadastrarClienteSingleResp>;

function temDddOuCodigoDoPais(input: string): boolean {
  const trimmed = input.trim();
  if (trimmed.startsWith("+")) return true;

  const digits = trimmed.replace(/\D/g, "").replace(/^0+/, "");
  return digits.length === 10 || digits.length === 11 || /^55\d{10,11}$/.test(digits);
}

export class AdicionarContatoValidationError extends Error {
  readonly errors: AdicionarContatoErrors;

  constructor(errors: AdicionarContatoErrors) {
    super("Revise os campos do contato.");
    this.name = "AdicionarContatoValidationError";
    this.errors = errors;
  }
}

export async function adicionarContato(
  input: AdicionarContatoInput,
  cadastrar: CadastrarContato = cadastrarClienteSingle,
): Promise<CadastrarClienteSingleResp> {
  const nome = input.nome.trim();
  const telefone = temDddOuCodigoDoPais(input.telefone) ? normalizarE164(input.telefone) : null;
  const errors: AdicionarContatoErrors = {};

  if (nome.length < 2) {
    errors.nome = "Informe um nome com pelo menos 2 caracteres.";
  }
  if (!telefone) {
    errors.telefone = "Informe um WhatsApp com DDD e número.";
  }
  if (Object.keys(errors).length > 0 || !telefone) {
    throw new AdicionarContatoValidationError(errors);
  }

  return cadastrar(nome, telefone);
}
