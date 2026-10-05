// Janelas de tempo do WhatsApp para apagar-para-todos e editar mensagem, e a
// avaliação de elegibilidade de uma mensagem. Lado FRONTEND.
//
// Serve para a tela saber, sem ida ao servidor, quais mensagens ainda aceitam
// "apagar para todos" / "editar" — e mostrar o motivo quando não aceitam. O
// servidor revalida tudo (ver supabase/functions/mensagem-acao): isto aqui é
// experiência de uso, não autorização.
//
// ESTE ARQUIVO TEM UM GÊMEO: supabase/functions/_shared/janelas-whatsapp.ts.
// Tudo abaixo do marcador é idêntico nos dois e janelas-whatsapp.test.ts exige
// isso lendo os dois arquivos como texto. Editar um só quebra o teste.

// ═══ NUCLEO COMPARTILHADO — identico no gemeo, nao editar so um lado ═══
const MINUTO_MS = 60_000;
const HORA_MS = 60 * MINUTO_MS;

/**
 * Apagar para todos: 2 dias e 12 horas (60h) desde o envio.
 * Referência: WhatsApp estendeu o limite de ~1h para 60h em 2022.
 */
export const JANELA_APAGAR_MS = 60 * HORA_MS;

/** Editar: 15 minutos desde o envio. */
export const JANELA_EDITAR_MS = 15 * MINUTO_MS;

/**
 * Encolhe as duas janelas antes de oferecer a ação.
 *
 * O relógio de referência é `created_at`, que é o instante em que NÓS inserimos
 * a linha — o WhatsApp conta do instante em que ELE recebeu, sempre um pouco
 * depois. A diferença é de milissegundos no caminho normal, mas pode virar
 * minutos quando o envio ficou preso em fila ou retry. A margem faz o erro cair
 * sempre para o lado seguro: escondemos o botão um pouco antes em vez de
 * prometer uma ação que o WhatsApp vai ignorar em silêncio.
 */
export const MARGEM_JANELA_MS = 30_000;

export type AcaoMensagem = "apagar" | "editar";

export type MotivoBloqueio =
  /** Passou do prazo do WhatsApp. É o único motivo que o tempo resolve — para pior. */
  | "fora_da_janela"
  /** Mensagem do cliente, ou saída que não foi o nosso sistema que produziu. */
  | "nao_e_saida_nossa"
  /** Ainda não chegou ao WhatsApp (aguardando envio, falha, enviando). */
  | "nao_enviada"
  /** Não temos o id do WhatsApp, então não há o que citar na chamada. */
  | "sem_id_whatsapp"
  /** Já está apagada. */
  | "ja_apagada"
  /** Editar só existe para texto simples. */
  | "tipo_nao_editavel";

export interface Elegibilidade {
  pode: boolean;
  motivo?: MotivoBloqueio;
}

export interface MensagemAvaliavel {
  /** created_at em ISO. */
  criadaEm: string;
  direction: string;
  senderType: string;
  tipo: string;
  statusEnvio: string;
  apagadaEm: string | null;
  /**
   * A mensagem tem `zapi_message_id` (o `owner:messageid` da uazapi)? É a chave
   * que as duas rotas exigem. Booleano em vez do id porque o frontend também
   * avalia, e ele não precisa carregar o id na memória para isso.
   */
  temIdWhatsapp: boolean;
  /** Menu/lista interativa: é tipo 'texto' no banco, mas não é editável como texto. */
  ehListaOpcoes?: boolean;
  /**
   * `media_metadata.origem` das mensagens 'externo'. Só ela distingue as duas
   * fontes que caem nesse mesmo sender_type — ver ORIGEM_EXTERNA_APAGAVEL.
   * Ausente nas linhas gravadas antes de o webhook passar a registrar isso
   * (tudo anterior a 30/07/2026), e ausência é tratada como "não dá para saber".
   */
  origemExterna?: string | null;
}

/** Saídas que este sistema produziu. Elegíveis às duas ações. */
const SENDER_TYPES_NOSSOS = ["atendente", "bot", "sistema"];

/**
 * A única origem de 'externo' que o atendente pode apagar.
 *
 * 'externo' é um balde com duas coisas bem diferentes, que o webhook separa em
 * `media_metadata.origem` (ver webhook-zapi-receive, `wasSentByApi`):
 *
 *   - 'celular': alguém NOSSO digitou no WhatsApp (ou no Web) do número da
 *     empresa. Apagar isso é o mesmo gesto de apagar o que se mandou pelo
 *     sistema — a mensagem é da empresa e quem apaga responde por ela igual.
 *   - 'api_externa': o outro sistema da empresa (envio de documentos) usando a
 *     mesma instância uazapi. Apagar documento dele é dano sem volta e segue
 *     proibido.
 *
 * EDITAR continua fora para os dois. A rota de edição troca o id da mensagem no
 * WhatsApp (e com ele o vínculo com os eventos seguintes), e quem mandou do
 * celular tem o aparelho na mão para corrigir — risco sem contrapartida.
 *
 * Isto só é seguro porque `media_metadata` é escrita apenas pelo servidor
 * (trava em protect_mensagem_immutable_fields). Sem ela, daria para remarcar
 * uma mensagem do outro sistema como 'celular' e apagá-la.
 */
const ORIGEM_EXTERNA_APAGAVEL = "celular";

export function janelaDaAcao(acao: AcaoMensagem): number {
  return acao === "apagar" ? JANELA_APAGAR_MS : JANELA_EDITAR_MS;
}

/** Instante (epoch ms) em que a ação deixa de ser possível, já com a margem. */
export function expiraEm(acao: AcaoMensagem, criadaEm: string): number {
  return new Date(criadaEm).getTime() + janelaDaAcao(acao) - MARGEM_JANELA_MS;
}

/** A mensagem saiu do nosso número de um jeito que ESTA ação pode tocar? */
function ehAlvoDaAcao(acao: AcaoMensagem, msg: MensagemAvaliavel): boolean {
  if (msg.direction !== "outbound") return false;
  if (SENDER_TYPES_NOSSOS.includes(msg.senderType)) return true;
  return (
    acao === "apagar" &&
    msg.senderType === "externo" &&
    msg.origemExterna === ORIGEM_EXTERNA_APAGAVEL
  );
}

/**
 * A mensagem aceita a ação AGORA? Pura de propósito: `agoraMs` entra por
 * parâmetro para o teste não depender do relógio e para a UI poder recalcular
 * com um tick próprio.
 */
export function avaliarAcao(
  acao: AcaoMensagem,
  msg: MensagemAvaliavel,
  agoraMs: number,
): Elegibilidade {
  if (msg.apagadaEm) return { pode: false, motivo: "ja_apagada" };

  if (!ehAlvoDaAcao(acao, msg)) return { pode: false, motivo: "nao_e_saida_nossa" };

  if (msg.statusEnvio !== "enviado") return { pode: false, motivo: "nao_enviada" };
  if (!msg.temIdWhatsapp) return { pode: false, motivo: "sem_id_whatsapp" };

  if (acao === "editar" && (msg.tipo !== "texto" || msg.ehListaOpcoes === true)) {
    return { pode: false, motivo: "tipo_nao_editavel" };
  }

  const criadaMs = new Date(msg.criadaEm).getTime();
  if (!Number.isFinite(criadaMs)) return { pode: false, motivo: "fora_da_janela" };
  if (agoraMs > criadaMs + janelaDaAcao(acao) - MARGEM_JANELA_MS) {
    return { pode: false, motivo: "fora_da_janela" };
  }

  return { pode: true };
}

/** Texto curto para o atendente. Mesmo vocabulário no backend e na tela. */
export function textoMotivo(acao: AcaoMensagem, motivo: MotivoBloqueio): string {
  switch (motivo) {
    case "fora_da_janela":
      return acao === "apagar"
        ? "Passou do prazo do WhatsApp para apagar para todos (2 dias e 12 horas)."
        : "Passou do prazo do WhatsApp para editar (15 minutos).";
    case "nao_e_saida_nossa":
      return acao === "apagar"
        ? "Só é possível nas mensagens enviadas por este sistema ou pelo celular da empresa."
        : "Só é possível nas mensagens que este sistema enviou.";
    case "nao_enviada":
      return "A mensagem ainda não foi entregue ao WhatsApp.";
    case "sem_id_whatsapp":
      return "Não temos a referência dessa mensagem no WhatsApp.";
    case "ja_apagada":
      return "Essa mensagem já foi apagada.";
    case "tipo_nao_editavel":
      return "Só mensagens de texto podem ser editadas.";
  }
}
