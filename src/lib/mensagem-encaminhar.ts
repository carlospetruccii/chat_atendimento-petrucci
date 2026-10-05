// Encaminhar mensagem para outra conversa já existente no sistema —
// recurso próprio (a uazapi não tem "encaminhar por id", só um flag
// `forward` que marca uma mensagem NOVA como "Encaminhada" — ver
// supabase/functions/mensagem-encaminhar).
//
// A elegibilidade aqui é só experiência de uso (esconder o item do menu); o
// servidor revalida tudo — ver supabase/functions/mensagem-encaminhar/logic.ts.

import { supabase } from "@/integrations/supabase/client";
import type { InboxMessage } from "@/lib/inbox-queries";

export type MotivoBloqueadoEncaminhar =
  /** Já apagada — não há mais conteúdo para encaminhar. */
  | "ja_apagada"
  /** Aviso interno do sistema, não é conteúdo real do WhatsApp. */
  | "aviso_interno"
  /** Menu/lista interativa: não existe como mensagem enviável. */
  | "menu_interativo"
  /** Tipo sem suporte a envio (ex.: figurinha, localização, contato). */
  | "tipo_nao_suportado"
  /** Mídia que nunca chegou ao bucket (download falhou ou ainda não terminou). */
  | "midia_indisponivel";

export interface ElegibilidadeEncaminhar {
  pode: boolean;
  motivo?: MotivoBloqueadoEncaminhar;
}

export interface MensagemEncaminhavel {
  apagadaEm: string | null;
  senderType: string;
  tipo: string;
  ehListaOpcoes?: boolean;
  /**
   * Mídia já no bucket (tem storage_path). Só olhado para tipos de mídia — o
   * encaminhamento copia o arquivo do bucket, então mensagem com
   * `download_falhou` (ou ainda baixando) não tem o que encaminhar.
   */
  midiaPronta?: boolean;
}

/** Tipos que o envio (enviarTexto/enviarMidia) sabe mandar para o WhatsApp. */
export const TIPOS_ENCAMINHAVEIS: ReadonlySet<string> = new Set([
  "texto",
  "imagem",
  "audio",
  "video",
  "documento",
]);

/**
 * Diferente de editar/apagar (ver janelas-whatsapp.ts): sem janela de tempo, e
 * vale tanto para mensagens inbound quanto outbound — no WhatsApp real dá para
 * encaminhar qualquer mensagem, inclusive as que o cliente mandou.
 */
export function avaliarEncaminhar(msg: MensagemEncaminhavel): ElegibilidadeEncaminhar {
  if (msg.apagadaEm) return { pode: false, motivo: "ja_apagada" };
  if (msg.senderType === "sistema") return { pode: false, motivo: "aviso_interno" };
  if (msg.ehListaOpcoes) return { pode: false, motivo: "menu_interativo" };
  if (!TIPOS_ENCAMINHAVEIS.has(msg.tipo)) return { pode: false, motivo: "tipo_nao_suportado" };
  if (msg.tipo !== "texto" && msg.midiaPronta !== true) {
    return { pode: false, motivo: "midia_indisponivel" };
  }
  return { pode: true };
}

/** Traduz a mensagem (Inbox ou Docs) para o formato que `avaliarEncaminhar` avalia. */
export function paraEncaminhavel(
  m: Pick<InboxMessage, "apagadaEm" | "senderType" | "tipo" | "mediaMetadata">,
): MensagemEncaminhavel {
  const meta = m.mediaMetadata as { kind?: string; storage_path?: unknown } | null;
  return {
    apagadaEm: m.apagadaEm,
    senderType: m.senderType,
    tipo: m.tipo,
    ehListaOpcoes: meta?.kind === "lista_opcoes",
    // Mesmo critério que MessageMedia usa para decidir entre render e
    // "Mídia indisponível": sem storage_path não há arquivo no bucket.
    midiaPronta: typeof meta?.storage_path === "string" && meta.storage_path.length > 0,
  };
}

/** Motivos que só a execução no servidor conhece. */
export type MotivoExecucaoEncaminhar =
  | "mensagem_nao_encontrada"
  | "atendimento_destino_nao_encontrado"
  | "mesmo_atendimento"
  | "sem_permissao"
  | "cliente_sem_numero"
  | "falha_whatsapp";

export type MotivoEncaminhar = MotivoBloqueadoEncaminhar | MotivoExecucaoEncaminhar;

/** Frase para o atendente, com o detalhe do servidor quando houver. */
export function explicarMotivoEncaminhar(
  motivo: MotivoEncaminhar | undefined,
  detalhe?: string,
): string {
  if (detalhe) return detalhe;
  switch (motivo) {
    case "ja_apagada":
      return "Essa mensagem já foi apagada.";
    case "aviso_interno":
      return "Avisos internos não podem ser encaminhados.";
    case "menu_interativo":
      return "Menus interativos não podem ser encaminhados.";
    case "tipo_nao_suportado":
      return "Esse tipo de mensagem não pode ser encaminhado.";
    case "midia_indisponivel":
      return "O arquivo dessa mensagem não está disponível (o download falhou ou ainda não terminou).";
    case "mensagem_nao_encontrada":
      return "Mensagem não encontrada.";
    case "atendimento_destino_nao_encontrado":
      return "Conversa de destino não encontrada.";
    case "mesmo_atendimento":
      return "Escolha uma conversa diferente da atual.";
    case "sem_permissao":
      return "Você não pode agir nesta conversa.";
    case "cliente_sem_numero":
      return "O cliente de destino não tem número de WhatsApp cadastrado.";
    case "falha_whatsapp":
      return "O WhatsApp recusou o envio.";
    case undefined:
      return "Não foi possível concluir.";
    default:
      return "Não foi possível concluir.";
  }
}

interface RespostaEncaminhar {
  ok?: boolean;
  erro?: string;
  motivo?: MotivoEncaminhar;
  detalhe?: string;
  mensagem_id?: string;
}

export interface ResultadoEncaminhar {
  ok: boolean;
  motivo?: MotivoEncaminhar;
  detalhe?: string;
  mensagemId?: string;
}

/** Encaminha uma mensagem já enviada para outra conversa existente no sistema. */
export async function encaminharMensagem(params: {
  mensagemId: string;
  atendimentoIdDestino: string;
}): Promise<ResultadoEncaminhar> {
  const { data, error } = await supabase.functions.invoke<RespostaEncaminhar>(
    "mensagem-encaminhar",
    {
      body: {
        mensagem_id: params.mensagemId,
        atendimento_id_destino: params.atendimentoIdDestino,
      },
    },
  );
  // invoke() trata status >= 400 como erro e a mensagem dele é sempre genérica
  // ("Edge Function returned a non-2xx status code"). A recusa de negócio vem em
  // 200 com ok:false, mas 400/403/500 ainda caem aqui: lê o corpo para mostrar o
  // motivo real em vez do texto genérico (mesmo padrão de clientes-queries.ts).
  if (error) {
    const ctx = (error as { context?: Response }).context;
    if (ctx) {
      try {
        const corpo = (await ctx.json()) as RespostaEncaminhar;
        if (corpo?.motivo || corpo?.detalhe || corpo?.erro) {
          return {
            ok: false,
            motivo: corpo.motivo,
            detalhe: corpo.detalhe ?? (corpo.motivo ? undefined : corpo.erro),
          };
        }
      } catch {
        // corpo não-JSON ou já consumido: cai no throw abaixo
      }
    }
    throw error;
  }

  if (!data?.ok) {
    return { ok: false, motivo: data?.motivo, detalhe: data?.detalhe ?? data?.erro };
  }
  return { ok: true, mensagemId: data.mensagem_id };
}
