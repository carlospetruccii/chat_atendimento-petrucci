import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SelecaoMensagensBar } from "@/components/inbox/SelecaoMensagensBar";
import { ApagarParaTodosDialog } from "@/components/inbox/ApagarParaTodosDialog";
import { EditarMensagemDialog } from "@/components/inbox/EditarMensagemDialog";
import { EncaminharDialog } from "@/components/inbox/EncaminharDialog";
import { useSelecaoMensagens } from "@/hooks/useSelecaoMensagens";
import { useAgora } from "@/hooks/useAgora";
import { useDocsHistory } from "@/hooks/useDocsHistory";
import { useMarcarDocsLida } from "@/hooks/useMarcarDocsLida";
import { CBS_VAZIOS, type DocsRealtimeCbs } from "@/hooks/useDocsRealtime";
import {
  acoesDaConversa,
  agruparItensDocs,
  autorDaMensagemDocs,
  avisoSomenteLeitura,
  type DocsConversa,
} from "@/lib/docs-logic";
import {
  assumirDocsConversa,
  type DocsMessage,
  encerrarDocsConversa,
  listDocsEventos,
} from "@/lib/docs-queries";
import { apagarDocsMensagens, editarDocsMensagem, encaminharDocsMensagem } from "@/lib/docs-acoes";
import { DocsChatHeader } from "./DocsChatHeader";
import { DocsComposer } from "./DocsComposer";
import { DocsConfirmacaoDialog } from "./DocsConfirmacaoDialog";
import { DocsMensagemBolha } from "./DocsMensagemBolha";
import { DocsRepassarModal } from "./DocsRepassarModal";

interface Props {
  conversa: DocsConversa;
  user: { id: string; isSuperadmin: boolean };
  formatTime: (iso: string | null) => string;
  /** Conversas minhas em andamento (menos esta): destinos de "Encaminhar". */
  destinosEncaminhar: Array<Pick<DocsConversa, "id" | "clientNome" | "clientNumero">>;
  onVoltar: () => void;
  /** Registra os callbacks de realtime do chat aberto (o canal vive em useDocsRealtime). */
  registrarRealtime: (cbs: DocsRealtimeCbs) => void;
}

/**
 * Chat de uma conversa do Docs. Todo mundo com acesso lê; só o DONO escreve
 * (composer), e quem não é dono vê a faixa explicando com quem está a conversa.
 * Nada de triagem, bot ou departamento.
 */
export function DocsChatPanel({
  conversa,
  user,
  formatTime,
  destinosEncaminhar,
  onVoltar,
  registrarRealtime,
}: Props) {
  const queryClient = useQueryClient();
  const [replyTo, setReplyTo] = useState<DocsMessage | null>(null);
  const [editando, setEditando] = useState<DocsMessage | null>(null);
  const [confirmarApagar, setConfirmarApagar] = useState<DocsMessage[] | null>(null);
  const [encaminhando, setEncaminhando] = useState<DocsMessage | null>(null);
  const [repassarOpen, setRepassarOpen] = useState(false);
  const [encerrarOpen, setEncerrarOpen] = useState(false);
  const [tomarOpen, setTomarOpen] = useState(false);
  const [assumindo, setAssumindo] = useState(false);
  const agora = useAgora();

  const acoes = acoesDaConversa(conversa, user);
  const aviso = avisoSomenteLeitura(conversa, user.id);
  const chat = useDocsHistory({ conversaId: conversa.id, enabled: true });
  const selecao = useSelecaoMensagens(chat.messages);

  const eventosQ = useQuery({
    queryKey: ["docs", "eventos", conversa.id],
    queryFn: () => listDocsEventos(conversa.id),
  });

  const invalidar = () => {
    queryClient.invalidateQueries({ queryKey: ["docs"] });
    queryClient.invalidateQueries({ queryKey: ["docs-unread-total"] });
  };

  // Entrega os callbacks para o canal único do DocsPane (recriar canal por
  // conversa aberta fazia perder INSERTs na janela de reinscrição) e
  // desregistra ao desmontar, para o canal não chamar um hook já morto.
  const registrarRef = useRef(registrarRealtime);
  registrarRef.current = registrarRealtime;
  useEffect(() => {
    registrarRef.current({
      onInsert: chat.onRealtimeInsert,
      onUpdate: chat.onRealtimeUpdate,
      onDelete: chat.onRealtimeDelete,
    });
    return () => registrarRef.current(CBS_VAZIOS);
  }, [chat.onRealtimeInsert, chat.onRealtimeUpdate, chat.onRealtimeDelete]);

  useMarcarDocsLida({
    conversaId: conversa.id,
    lastInboundAt: conversa.lastInboundAt,
    souDono: acoes.podeEscrever,
  });

  // Perdeu a conversa (repasse, admin tomou) no meio de uma seleção ou citação:
  // o que sobrou não pode mais ser feito.
  useEffect(() => {
    if (!acoes.podeAlterarMensagens) selecao.limpar();
    if (!acoes.podeEscrever) setReplyTo(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acoes.podeAlterarMensagens, acoes.podeEscrever]);

  const mensagensPorId = useMemo(() => {
    const map = new Map<string, DocsMessage>();
    for (const m of chat.messages) map.set(m.id, m);
    return map;
  }, [chat.messages]);

  const itens = agruparItensDocs(chat.messages, eventosQ.data ?? [], {
    desde: chat.hasMore ? (chat.messages[0]?.createdAt ?? null) : null,
    meuUserId: user.id,
  });

  const autorDe = (m: DocsMessage) =>
    autorDaMensagemDocs(m, { meuUserId: user.id, clienteNome: conversa.clientNome });

  const assumir = async () => {
    if (acoes.tomaDeOutro) {
      setTomarOpen(true);
      return;
    }
    setAssumindo(true);
    try {
      await assumirDocsConversa(conversa.id);
      toast.success("Conversa assumida — agora ela é sua");
      invalidar();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível assumir a conversa.");
    } finally {
      setAssumindo(false);
    }
  };

  const permissoes = {
    podeResponder: acoes.podeEscrever,
    podeEncaminhar: destinosEncaminhar.length > 0,
    podeAlterar: acoes.podeAlterarMensagens,
  };
  const carregando = chat.isLoadingInitial && chat.messages.length === 0;
  const falhou = !!chat.error && chat.messages.length === 0 && !chat.isLoadingInitial;

  return (
    <>
      <DocsChatHeader
        conversa={conversa}
        meuUserId={user.id}
        acoes={acoes}
        assumindo={assumindo}
        onVoltar={onVoltar}
        onAssumir={assumir}
        onRepassar={() => setRepassarOpen(true)}
        onEncerrar={() => setEncerrarOpen(true)}
      />

      {/* Mensagens — scroll contínuo com paginação infinita pra cima */}
      <div
        ref={chat.scrollContainerRef}
        className="scroll-contain relative flex-1 overflow-y-auto bg-[var(--chat-bg)] p-3 sm:p-6"
      >
        <div ref={chat.topSentinelRef} aria-hidden className="h-px" />

        {selecao.ativo && (
          <SelecaoMensagensBar
            quantas={selecao.selecionados.size}
            onCancelar={selecao.limpar}
            onApagar={() =>
              setConfirmarApagar(chat.messages.filter((m) => selecao.selecionados.has(m.id)))
            }
          />
        )}

        {chat.isLoadingMore && (
          <div className="flex items-center justify-center py-3 text-xs text-muted-foreground">
            <Loader2 className="mr-2 h-3 w-3 animate-spin" /> Carregando mais...
          </div>
        )}

        {carregando ? (
          <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Carregando mensagens...
          </div>
        ) : falhou ? (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center text-sm text-muted-foreground">
            <AlertCircle className="h-5 w-5 text-destructive" aria-hidden />
            <p>Não foi possível carregar o histórico agora.</p>
            <Button type="button" variant="outline" size="sm" onClick={chat.retryInitial}>
              Tentar novamente
            </Button>
          </div>
        ) : itens.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            Nenhuma mensagem nessa conversa ainda.
          </div>
        ) : (
          itens.map((item, idx) => {
            if (item.kind === "date-separator") {
              return (
                <div key={item.key} className="my-3 flex justify-center">
                  <span className="rounded-full bg-muted px-3 py-1 text-[11px] text-muted-foreground">
                    {item.label}
                  </span>
                </div>
              );
            }
            if (item.kind === "evento") {
              return (
                <div key={item.key} className="my-4 flex items-center gap-3">
                  <div className="h-px flex-1 bg-border" />
                  <span className="rounded-full border border-border bg-card px-2.5 py-1 text-center text-[11px] text-muted-foreground">
                    {item.label}
                  </span>
                  <div className="h-px flex-1 bg-border" />
                </div>
              );
            }
            const m = item.message;
            return (
              <DocsMensagemBolha
                key={item.key}
                m={m}
                colada={item.colada}
                primeira={idx === 0}
                meuUserId={user.id}
                quoted={
                  m.replyToMessageId ? (mensagensPorId.get(m.replyToMessageId) ?? null) : null
                }
                autorDe={autorDe}
                formatTime={formatTime}
                agora={agora}
                selecao={{
                  ativo: selecao.ativo,
                  selecionada: selecao.selecionados.has(m.id),
                  podeApagar: selecao.podeApagar(m),
                  onSegurar: () => acoes.podeAlterarMensagens && selecao.iniciarCom(m),
                  onToque: () => selecao.alternar(m),
                }}
                permissoes={permissoes}
                onResponder={() => setReplyTo(m)}
                onEditar={() => setEditando(m)}
                onApagar={() => setConfirmarApagar([m])}
                onEncaminhar={() => setEncaminhando(m)}
              />
            );
          })
        )}
        <div ref={chat.bottomRef} />

        {chat.newBelow > 0 && (
          <button
            type="button"
            onClick={() => {
              chat.scrollToBottom(true);
              chat.clearNewBelow();
            }}
            className="badge-counter absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full px-3 py-1.5 text-xs font-medium shadow-md"
          >
            ↓ {chat.newBelow} nova{chat.newBelow > 1 ? "s" : ""} mensage
            {chat.newBelow > 1 ? "ns" : "m"}
          </button>
        )}
      </div>

      {acoes.podeEscrever ? (
        <DocsComposer
          conversaId={conversa.id}
          clienteNome={conversa.clientNome}
          replyTo={replyTo}
          onCancelarResposta={() => setReplyTo(null)}
          autorDe={autorDe}
          onEnviada={(id) => {
            if (id) void chat.ingestMessage(id);
            else requestAnimationFrame(() => chat.scrollToBottom(true));
          }}
        />
      ) : (
        <div className="flex items-center gap-2 border-t border-[var(--warning-border)] bg-[var(--warning-bg)] px-4 py-3 text-sm text-[var(--warning-foreground)] sm:px-6">
          <AlertCircle className="h-4 w-4 shrink-0" strokeWidth={1.5} />
          <span className="min-w-0 flex-1">{aviso}</span>
          {acoes.podeAssumir && (
            <Button size="sm" variant="outline" onClick={assumir} disabled={assumindo}>
              {assumindo && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Assumir
            </Button>
          )}
        </div>
      )}

      <DocsRepassarModal
        open={repassarOpen}
        onOpenChange={setRepassarOpen}
        conversaId={conversa.id}
        donoAtual={conversa.status === "em_andamento" ? conversa.assignedTo : null}
        onDone={invalidar}
      />
      <DocsConfirmacaoDialog
        open={encerrarOpen}
        onOpenChange={setEncerrarOpen}
        titulo="Encerrar conversa"
        descricao="A conversa fica sem dono. Se o cliente escrever de novo, ela volta para Sem dono."
        rotuloConfirmar="Encerrar conversa"
        destrutivo
        onConfirmar={() => encerrarDocsConversa(conversa.id)}
        mensagemSucesso="Conversa encerrada"
        onConcluido={invalidar}
      />
      <DocsConfirmacaoDialog
        open={tomarOpen}
        onOpenChange={setTomarOpen}
        titulo={`Assumir a conversa de ${conversa.assignedNome ?? "outra pessoa"}?`}
        descricao="Ela deixa de ser dona e não poderá mais responder. A troca fica registrada na conversa."
        rotuloConfirmar="Assumir conversa"
        onConfirmar={() => assumirDocsConversa(conversa.id)}
        mensagemSucesso="Conversa assumida — agora ela é sua"
        onConcluido={invalidar}
      />
      <ApagarParaTodosDialog
        open={!!confirmarApagar}
        onOpenChange={(v) => !v && setConfirmarApagar(null)}
        mensagens={confirmarApagar ?? []}
        apagar={apagarDocsMensagens}
        onConcluido={() => {
          // As bolhas mudam sozinhas pelo realtime (UPDATE); aqui só sai da
          // seleção e atualiza a prévia da lista.
          selecao.limpar();
          invalidar();
        }}
      />
      <EditarMensagemDialog
        mensagem={editando}
        onOpenChange={(v) => !v && setEditando(null)}
        editar={editarDocsMensagem}
        onEditada={invalidar}
      />
      <EncaminharDialog
        mensagem={encaminhando}
        conversations={destinosEncaminhar}
        currentAtendimentoId={conversa.id}
        encaminhar={encaminharDocsMensagem}
        textoSemDestino="Você só pode encaminhar para conversas do Docs em que é o dono."
        onOpenChange={(v) => !v && setEncaminhando(null)}
        onEncaminhada={invalidar}
      />
    </>
  );
}
