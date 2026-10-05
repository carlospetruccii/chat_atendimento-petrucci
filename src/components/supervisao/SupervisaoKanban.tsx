import { useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import {
  STATUS_BADGE,
  STATUS_LABEL,
  formatTimeShort,
  type SupervisaoRow,
} from "@/lib/supervisao-queries";
import type { AtendimentoStatus } from "@/lib/inbox-queries";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";

const COLUMNS: AtendimentoStatus[] = [
  "em_triagem",
  "reservado",
  "em_atendimento",
  "pendente",
  "encerrado",
];

const ENCERRADO_LIMIT = 30;

function deptStyle(cor: string): React.CSSProperties {
  return { backgroundColor: `${cor}20`, color: cor };
}

interface Props {
  rows: SupervisaoRow[];
  currentUserId: string | null;
}

export function SupervisaoKanban({ rows, currentUserId }: Props) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState<SupervisaoRow | null>(null);
  const [closeMotivo, setCloseMotivo] = useState("");

  // Mouse e toque pedem sensores separados. Com um único PointerSensor por
  // distância, o dedo que desliza para rolar a faixa de colunas já passa dos
  // 6px antes do navegador decidir "é rolagem" — e o dnd-kit rouba o gesto
  // pro drag. TouchSensor com delay dá tempo do gesto de rolagem vencer
  // (se o dedo andar mais que `tolerance` antes do delay, o drag é
  // cancelado e a rolagem nativa segue); MouseSensor mantém a resposta
  // imediata do desktop, que não tem esse conflito.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );

  const byStatus = useMemo(() => {
    const map = new Map<AtendimentoStatus, SupervisaoRow[]>();
    for (const s of COLUMNS) map.set(s, []);
    for (const r of rows) {
      map.get(r.status)?.push(r);
    }
    // Limita encerrados
    const enc = map.get("encerrado");
    if (enc && enc.length > ENCERRADO_LIMIT) {
      map.set("encerrado", enc.slice(0, ENCERRADO_LIMIT));
    }
    return map;
  }, [rows]);

  const encerradoTotal = rows.filter((r) => r.status === "encerrado").length;

  const claimMutation = useMutation({
    mutationFn: async (atendimentoId: string) => {
      const { data, error } = await supabase.rpc("claim_pendente", {
        p_atendimento_id: atendimentoId,
      });
      if (error) throw error;
      if (!data) throw new Error("Atendimento já foi atribuído a outro colaborador.");
    },
    onSuccess: () => {
      toast.success("Atendimento reservado");
      queryClient.invalidateQueries({ queryKey: ["supervisao"] });
    },
    onError: (e: Error) => {
      toast.error(e.message || "Não foi possível reservar.");
      queryClient.invalidateQueries({ queryKey: ["supervisao"] });
    },
  });

  const closeMutation = useMutation({
    mutationFn: async ({ id, motivo }: { id: string; motivo: string }) => {
      const { data, error } = await supabase.rpc("encerrar_atendimento", {
        p_atendimento_id: id,
        p_motivo: motivo || undefined,
      });
      if (error) throw error;
      if (!data) throw new Error("Atendimento já encerrado.");
    },
    onSuccess: () => {
      toast.success("Atendimento encerrado");
      queryClient.invalidateQueries({ queryKey: ["supervisao"] });
    },
    onError: (e: Error) => {
      toast.error(e.message || "Não foi possível encerrar.");
      queryClient.invalidateQueries({ queryKey: ["supervisao"] });
    },
  });

  function handleDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
  }

  function handleDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const id = String(e.active.id);
    const overId = e.over?.id ? String(e.over.id) : null;
    if (!overId) return;
    const target = overId as AtendimentoStatus;
    const row = rows.find((r) => r.id === id);
    if (!row || row.status === target) return;

    if (target === "reservado") {
      if (row.assignedTo) {
        toast.info("Já tem dono. Use o repasse pela conversa para trocar.");
        return;
      }
      if (!currentUserId) {
        toast.error("Sessão inválida.");
        return;
      }
      claimMutation.mutate(id);
      return;
    }

    if (target === "encerrado") {
      setConfirmClose(row);
      setCloseMotivo("");
      return;
    }

    toast.info(
      `Transição para "${STATUS_LABEL[target]}" não é permitida manualmente — depende do fluxo do atendimento.`,
    );
  }

  const activeRow = activeId ? rows.find((r) => r.id === activeId) ?? null : null;

  return (
    <>
      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        {/* scroll-contain: rolar a faixa não arrasta a página atrás dela.
            snap-x-mandatory: no celular a coluna "encaixa" em vez de parar
            pela metade, deixando claro que existe mais coluna ao lado. */}
        <div className="flex gap-3 overflow-x-auto pb-2 scroll-contain snap-x-mandatory">
          {COLUMNS.map((status) => {
            const items = byStatus.get(status) ?? [];
            const isEncerrado = status === "encerrado";
            return (
              <Column
                key={status}
                status={status}
                count={isEncerrado ? encerradoTotal : items.length}
                limited={isEncerrado && encerradoTotal > ENCERRADO_LIMIT}
              >
                {items.map((r) => (
                  <Card
                    key={r.id}
                    row={r}
                    onOpen={() =>
                      navigate({
                        to: "/inbox",
                        search: { mode: "supervision", conversation: r.id },
                      })
                    }
                  />
                ))}
                {items.length === 0 && (
                  <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                    Nenhuma conversa
                  </div>
                )}
              </Column>
            );
          })}
        </div>

        <DragOverlay>
          {activeRow ? <CardContent row={activeRow} dragging /> : null}
        </DragOverlay>
      </DndContext>

      <AlertDialog open={!!confirmClose} onOpenChange={(o) => !o && setConfirmClose(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Encerrar atendimento?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmClose ? (
                <>
                  Encerrar a conversa com <strong>{confirmClose.clientNome}</strong>.
                  Esta ação não pode ser desfeita.
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            placeholder="Motivo (opcional)"
            value={closeMotivo}
            onChange={(e) => setCloseMotivo(e.target.value)}
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmClose) {
                  closeMutation.mutate({ id: confirmClose.id, motivo: closeMotivo.trim() });
                  setConfirmClose(null);
                }
              }}
            >
              Encerrar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function Column({
  status,
  count,
  limited,
  children,
}: {
  status: AtendimentoStatus;
  count: number;
  limited: boolean;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return (
    // Largura em vw no celular (com teto em px): estreita o bastante pra
    // sobrar uma fatia da próxima coluna à direita, sinalizando que dá pra
    // rolar. snap-start-always é o que faz o dedo "encaixar" a coluna.
    <div className="flex w-[78vw] max-w-[280px] shrink-0 snap-start-always flex-col rounded-2xl border border-border bg-muted/40 sm:w-[280px]">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
        <div className="flex items-center gap-2">
          <span className={`text-[11px] px-2 py-0.5 rounded ${STATUS_BADGE[status]}`}>
            {STATUS_LABEL[status]}
          </span>
          <span className="text-xs text-muted-foreground">{count}</span>
        </div>
      </div>
      <div
        ref={setNodeRef}
        className={`flex-1 min-h-[200px] max-h-[calc(100dvh-280px)] overflow-y-auto p-2 space-y-2 scroll-contain transition-colors ${
          isOver ? "bg-accent/40" : ""
        }`}
      >
        {children}
        {limited && (
          <div className="px-2 py-2 text-center text-[11px] text-muted-foreground">
            Mostrando {ENCERRADO_LIMIT} mais recentes
          </div>
        )}
      </div>
    </div>
  );
}

function Card({ row, onOpen }: { row: SupervisaoRow; onOpen: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: row.id,
  });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={(e) => {
        // Só dispara clique se não houve drag significativo
        if (!isDragging) onOpen();
        e.stopPropagation();
      }}
      className={`cursor-grab active:cursor-grabbing rounded-xl border border-border bg-card p-2.5 shadow-sm transition-opacity hover:border-foreground/20 ${
        isDragging ? "opacity-40" : ""
      }`}
    >
      <CardContent row={row} />
    </div>
  );
}

function CardContent({ row, dragging = false }: { row: SupervisaoRow; dragging?: boolean }) {
  return (
    <div
      className={
        // Acompanha a largura responsiva da coluna (item anterior): sem isso
        // o cartão flutuante ficava largo demais para caber na coluna estreita
        // do celular enquanto era arrastado.
        dragging
          ? "w-[72vw] max-w-[260px] rounded-xl border border-border bg-card p-2.5 shadow-lg sm:w-[260px]"
          : ""
      }
    >
      <div className="flex items-start gap-2">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-medium text-primary">
          {row.initials}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">
            {row.clientNome}
          </div>
          <div className="text-[11px] text-muted-foreground">{row.clientNumero}</div>
        </div>
        <div className="text-[10px] text-muted-foreground shrink-0">
          {formatTimeShort(row.lastMessageAt)}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {row.departmentNome && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded"
            style={deptStyle(row.departmentCor)}
          >
            {row.departmentNome}
          </span>
        )}
        <span className="text-[10px] text-muted-foreground">
          {row.assignedTo ? row.assignedNome : "Sem dono"}
        </span>
      </div>
      {row.lastMessagePreview && (
        <div className="mt-1.5 line-clamp-2 text-[11px] text-muted-foreground">
          {row.lastMessagePreview}
        </div>
      )}
    </div>
  );
}
