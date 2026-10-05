export type ModoCadastro = "single" | "csv_batch";

export interface PermissaoCadastroCliente {
  isSuperadmin: boolean;
  hasViewAllDepartments: boolean;
  modo: ModoCadastro;
}

export function podeCadastrarCliente(
  permissao: PermissaoCadastroCliente,
): boolean {
  // Cadastro avulso é o primeiro passo do botão "Conversar" na tela de
  // Contatos: sem ele o colaborador levava 403 e a conversa nunca abria.
  // Criar um cliente a partir de um número não expõe dado de ninguém, então
  // qualquer membro ativo pode.
  if (permissao.modo === "single") return true;

  // Importar a base inteira via CSV continua sendo ação administrativa.
  return permissao.isSuperadmin || permissao.hasViewAllDepartments;
}

/**
 * Trocar o nome de um cliente que já existe muda o que a equipe inteira vê,
 * então fica com quem administra. Colaborador comum ainda cadastra número novo
 * e abre conversa: para ele, o cliente existente só é reaproveitado.
 */
export function podeRenomearClienteExistente(
  permissao: Omit<PermissaoCadastroCliente, "modo">,
): boolean {
  return permissao.isSuperadmin || permissao.hasViewAllDepartments;
}
