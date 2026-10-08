// Acesso de colaborador desativado. O corte de verdade é no banco
// (trigger users_aplicar_ativo: bloqueia o login e derruba as sessões); aqui só
// explicamos o motivo ao usuário e tiramos da app quem já estava logado.

export const MENSAGEM_ACESSO_DESATIVADO = "Seu acesso foi desativado. Fale com o administrador.";

const MENSAGEM_LOGIN_PADRAO = "E-mail ou senha incorretos";

interface ErroAuth {
  code?: string;
  message?: string;
}

/** Texto do toast quando o login falha. */
export function mensagemErroLogin(error: ErroAuth | null): string {
  const banido = error?.code === "user_banned" || /banned/i.test(error?.message ?? "");
  return banido ? MENSAGEM_ACESSO_DESATIVADO : MENSAGEM_LOGIN_PADRAO;
}

/** true só quando o perfil já carregou e está inativo (carregando não expulsa). */
export function perfilDesativado(perfil: { ativo: boolean } | null): boolean {
  return perfil !== null && perfil.ativo === false;
}
