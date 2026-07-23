// Lógica PURA do aviso aos colaboradores quando cai um pendente.
// Sem I/O — testável isoladamente com `deno test`.

// Depto de sistema "triagem": cliente aqui ainda não escolheu setor, não há
// time para avisar.
export const TRIAGEM_DEPT_ID = "00000000-0000-0000-0000-000000000010";

// Um atendimento só é notificável quando já tem um departamento REAL (não nulo
// e não o de triagem).
export function departamentoNotificavel(departmentId: string | null | undefined): boolean {
  const id = (departmentId ?? "").trim();
  return id.length > 0 && id !== TRIAGEM_DEPT_ID;
}

export interface ColaboradorLike {
  ativo: boolean | null;
  is_system_user: boolean | null;
  whatsapp: string | null;
}

// Colaborador recebe o aviso se: ativo, não é usuário de sistema e tem WhatsApp
// cadastrado. Um administrador também recebe QUANDO tiver esse departamento
// atribuído — a query que chama esta função já filtra por department_id, então
// um admin sem departamento atribuído nunca aparece aqui.
export function colaboradorRecebe(u: ColaboradorLike): boolean {
  if (u.ativo === false) return false;
  if (u.is_system_user === true) return false;
  return soDigitos(u.whatsapp ?? "").length > 0;
}

// Mantém só dígitos (formato aceito pela uazapi).
export function soDigitos(valor: string): string {
  return (valor ?? "").replace(/\D/g, "");
}

// Telefone do cliente em E.164 com '+' para exibir na mensagem.
export function telefoneExibicao(telefone: string | null | undefined): string {
  const raw = (telefone ?? "").trim();
  if (!raw) return "";
  return raw.startsWith("+") ? raw : `+${soDigitos(raw)}`;
}
