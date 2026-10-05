import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import type { InboxMessage } from "@/lib/inbox-queries";
import { avaliarAcao, type Elegibilidade, textoMotivo } from "@/lib/janelas-whatsapp";
import { MAX_APAGAR_POR_VEZ } from "@/lib/mensagem-acoes";
import { useAgora } from "@/hooks/useAgora";

/**
 * O que a regra de prazo lê de uma mensagem. Recorte da InboxMessage para que a
 * aba Docs (DocsMessage, mesmo formato nesses campos) use as mesmas regras.
 */
export type MensagemAvaliavelNaTela = Pick<
  InboxMessage,
  | "createdAt"
  | "direction"
  | "senderType"
  | "tipo"
  | "statusEnvio"
  | "apagadaEm"
  | "temIdWhatsapp"
  | "mediaMetadata"
>;

/** Traduz a mensagem (Inbox ou Docs) para o formato que a regra de prazo avalia. */
export function paraAvaliavel(m: MensagemAvaliavelNaTela) {
  const meta = m.mediaMetadata as { kind?: string; origem?: string } | null;
  return {
    criadaEm: m.createdAt,
    direction: m.direction,
    senderType: m.senderType,
    tipo: m.tipo,
    statusEnvio: m.statusEnvio,
    apagadaEm: m.apagadaEm,
    temIdWhatsapp: m.temIdWhatsapp,
    ehListaOpcoes: meta?.kind === "lista_opcoes",
    // Separa "saiu do celular da empresa" de "outro sistema mandou pela mesma
    // instância" — só a primeira é apagável (ver @/lib/janelas-whatsapp).
    origemExterna: meta?.origem ?? null,
  };
}

type MensagemSelecionavel = MensagemAvaliavelNaTela & { id: string };

interface UseSelecaoMensagensResult<T extends MensagemSelecionavel> {
  ativo: boolean;
  selecionados: Set<string>;
  /** Elegibilidade de apagar, por id, recalculada quando o relógio avança. */
  podeApagar: (m: T) => Elegibilidade;
  /** Entra no modo seleção já com esta mensagem marcada (gesto de segurar). */
  iniciarCom: (m: T) => void;
  alternar: (m: T) => void;
  limpar: () => void;
  /** ids na ordem em que a conversa os mostra — o lote sai na ordem da conversa. */
  idsSelecionados: string[];
}

/**
 * Modo de seleção de mensagens para apagar em lote, no gesto do WhatsApp:
 * segura uma mensagem, ela fica marcada, marca-se as outras no toque simples.
 *
 * Só mensagens elegíveis entram. Tentar marcar uma que passou do prazo NÃO é
 * ignorado em silêncio — avisa o motivo, que é justamente o que o produto pediu.
 */
export function useSelecaoMensagens<T extends MensagemSelecionavel>(
  mensagens: T[],
): UseSelecaoMensagensResult<T> {
  const [ativo, setAtivo] = useState(false);
  const [selecionados, setSelecionados] = useState<Set<string>>(() => new Set());
  const agora = useAgora();

  const podeApagar = useCallback((m: T) => avaliarAcao("apagar", paraAvaliavel(m), agora), [agora]);

  const limpar = useCallback(() => {
    setAtivo(false);
    setSelecionados(new Set());
  }, []);

  const marcar = useCallback((m: T, jaSelecionados: Set<string>): Set<string> | null => {
    const el = avaliarAcao("apagar", paraAvaliavel(m), Date.now());
    if (!el.pode) {
      toast.error("Não é possível apagar para todos", {
        description: el.motivo ? textoMotivo("apagar", el.motivo) : undefined,
      });
      return null;
    }
    if (jaSelecionados.size >= MAX_APAGAR_POR_VEZ) {
      toast.warning(`Máximo de ${MAX_APAGAR_POR_VEZ} mensagens por vez.`);
      return null;
    }
    const proximo = new Set(jaSelecionados);
    proximo.add(m.id);
    return proximo;
  }, []);

  const iniciarCom = useCallback(
    (m: T) => {
      const proximo = marcar(m, new Set());
      if (!proximo) return;
      setAtivo(true);
      setSelecionados(proximo);
    },
    [marcar],
  );

  const alternar = useCallback(
    (m: T) => {
      setSelecionados((prev) => {
        if (prev.has(m.id)) {
          const proximo = new Set(prev);
          proximo.delete(m.id);
          return proximo;
        }
        return marcar(m, prev) ?? prev;
      });
    },
    [marcar],
  );

  // Ordem da conversa, não ordem de clique: o lote é lido pelo humano na
  // confirmação, e "a primeira que aparece" é o que ele espera ver primeiro.
  const idsSelecionados = useMemo(
    () => mensagens.filter((m) => selecionados.has(m.id)).map((m) => m.id),
    [mensagens, selecionados],
  );

  return {
    // Desmarcar a última fecha o modo, igual ao WhatsApp — sem isso a barra de
    // ações ficaria na tela com zero selecionadas.
    ativo: ativo && selecionados.size > 0,
    selecionados,
    podeApagar,
    iniciarCom,
    alternar,
    limpar,
    idsSelecionados,
  };
}
