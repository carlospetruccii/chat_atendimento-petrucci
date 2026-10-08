interface ErroRpc {
  code?: string;
  message?: string;
}

/**
 * Traduz o erro da RPC `repassar_atendimento` pro toast. O 22023 cobre dois
 * casos no banco — destino inválido e "já está com este colaborador" (comum
 * quando o destino assumiu a conversa enquanto a tela de quem repassa estava
 * velha) — então só o código não basta: desempata pela mensagem.
 */
export function mensagemErroRepasse(erro: ErroRpc, nomeDestino: string): string {
  switch (erro.code) {
    case "42501":
      return "Você não tem permissão para repassar este atendimento.";
    case "P0002":
      // Encerrado e em triagem já não caem aqui: repassar reabre um e
      // interrompe o outro. Sobra o atendimento que não existe mais.
      return "Atendimento não encontrado — recarregue a conversa.";
    case "23505":
      return "Este cliente já tem uma conversa ativa — repasse a conversa atual dele.";
    case "22023":
      return erro.message?.includes("já está com este colaborador")
        ? `Este atendimento já está com ${nomeDestino}.`
        : "Colaborador destino inválido.";
    default:
      return erro.message
        ? `Não foi possível repassar: ${erro.message}`
        : "Não foi possível repassar o atendimento.";
  }
}
