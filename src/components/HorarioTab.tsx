import { useEffect, useState } from "react";
import { Plus, X, Pencil, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
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
import {
  fetchBusinessHours,
  addBusinessHoursSlot,
  removeBusinessHoursSlot,
  fetchHolidays,
  createHoliday,
  updateHoliday,
  deleteHoliday,
  DIAS_SEMANA,
  type BusinessHoursRow,
  type HolidayRow,
} from "@/lib/configuracoes-queries";

function fmtDate(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

interface AddSlotState {
  open: boolean;
  dia: number;
  inicio: string;
  fim: string;
}

interface HolidayFormState {
  open: boolean;
  id: string | null;
  data: string;
  descricao: string;
  hasOverride: boolean;
  inicio: string;
  fim: string;
}

const emptyHoliday: HolidayFormState = {
  open: false,
  id: null,
  data: "",
  descricao: "",
  hasOverride: false,
  inicio: "09:00",
  fim: "18:00",
};

export function HorarioTab() {
  const [hours, setHours] = useState<BusinessHoursRow[]>([]);
  const [holidays, setHolidays] = useState<HolidayRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [addSlot, setAddSlot] = useState<AddSlotState>({
    open: false,
    dia: 1,
    inicio: "09:00",
    fim: "12:00",
  });
  const [confirmRemoveSlot, setConfirmRemoveSlot] = useState<string | null>(null);
  const [holidayForm, setHolidayForm] = useState<HolidayFormState>(emptyHoliday);
  const [confirmRemoveHoliday, setConfirmRemoveHoliday] = useState<HolidayRow | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [h, f] = await Promise.all([fetchBusinessHours(), fetchHolidays()]);
      setHours(h);
      setHolidays(f);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const openAdd = (dia: number) => setAddSlot({ open: true, dia, inicio: "09:00", fim: "12:00" });

  const handleAddSlot = async () => {
    setBusy(true);
    try {
      await addBusinessHoursSlot({
        dia_semana: addSlot.dia,
        inicio: addSlot.inicio,
        fim: addSlot.fim,
      });
      toast.success("Faixa adicionada.");
      setAddSlot((s) => ({ ...s, open: false }));
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveSlot = async (id: string) => {
    setBusy(true);
    try {
      await removeBusinessHoursSlot(id);
      toast.success("Faixa removida.");
      setConfirmRemoveSlot(null);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const openNewHoliday = () => setHolidayForm({ ...emptyHoliday, open: true });
  const openEditHoliday = (h: HolidayRow) =>
    setHolidayForm({
      open: true,
      id: h.id,
      data: h.data,
      descricao: h.descricao ?? "",
      hasOverride: !!(h.inicio_override && h.fim_override),
      inicio: h.inicio_override ?? "09:00",
      fim: h.fim_override ?? "18:00",
    });

  const handleSaveHoliday = async () => {
    if (!holidayForm.data) {
      toast.error("Informe a data.");
      return;
    }
    setBusy(true);
    try {
      const payload = {
        data: holidayForm.data,
        descricao: holidayForm.descricao,
        inicio_override: holidayForm.hasOverride ? holidayForm.inicio : null,
        fim_override: holidayForm.hasOverride ? holidayForm.fim : null,
      };
      if (holidayForm.id) {
        await updateHoliday(holidayForm.id, payload);
        toast.success("Feriado atualizado.");
      } else {
        await createHoliday(payload);
        toast.success("Feriado criado.");
      }
      setHolidayForm(emptyHoliday);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteHoliday = async () => {
    if (!confirmRemoveHoliday) return;
    setBusy(true);
    try {
      await deleteHoliday(confirmRemoveHoliday.id);
      toast.success("Feriado removido.");
      setConfirmRemoveHoliday(null);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Parte 1 — Faixas de horário */}
      <div className="rounded-2xl border border-border bg-card shadow-sm">
        <div className="border-b border-border p-6">
          <h3 className="text-base font-semibold text-foreground">Horário comercial</h3>
          <p className="mt-1 text-sm text-muted-foreground max-w-3xl">
            Defina os horários em que a Parabrisas Petrucci atende. Mensagens fora destes horários disparam o
            template de fora-de-horário.
          </p>
        </div>

        {loading ? (
          <div className="p-12 flex items-center justify-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <div className="divide-y divide-border">
            {DIAS_SEMANA.map((dia) => {
              const slots = hours.filter((h) => h.dia_semana === dia.num);
              return (
                <div key={dia.num} className="p-4">
                  {/* Celular: rótulo do dia, faixas e botão empilham — os
                      três lado a lado com rótulo de 120px fixo estouram bem
                      antes dos 360px. Do md: pra cima volta à linha única
                      original (rótulo à esquerda com largura fixa). */}
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:gap-4">
                    <div className="md:w-[120px] md:shrink-0 md:pt-2">
                      <span className="text-sm font-semibold text-foreground">{dia.label}</span>
                    </div>
                    <div className="min-w-0 md:flex-1">
                      {slots.length === 0 ? (
                        <p className="text-sm text-muted-foreground italic md:pt-2">Fechado</p>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {slots.map((s) => (
                            <div
                              key={s.id}
                              className="flex items-center gap-2 rounded-2xl border border-border bg-background px-3 py-1.5 text-sm"
                            >
                              <span className="tabular-nums text-foreground">
                                {s.inicio} — {s.fim}
                              </span>
                              <button
                                type="button"
                                onClick={() => setConfirmRemoveSlot(s.id)}
                                className="touch-target-mobile inline-flex items-center justify-center rounded p-0.5 text-muted-foreground hover:text-destructive"
                                title="Remover faixa"
                              >
                                <X className="h-3.5 w-3.5" strokeWidth={1.8} />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="md:shrink-0 md:pt-1">
                      <button
                        type="button"
                        onClick={() => openAdd(dia.num)}
                        className="flex items-center gap-1.5 rounded-md bg-muted px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted/70"
                      >
                        <Plus className="h-3.5 w-3.5" strokeWidth={2} />
                        adicionar faixa
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Parte 2 — Feriados */}
      <div className="rounded-2xl border border-border bg-card shadow-sm">
        <div className="flex flex-col gap-3 border-b border-border p-6 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-foreground">Feriados e datas especiais</h3>
            <p className="mt-1 text-sm text-muted-foreground max-w-3xl">
              Datas em que o atendimento fica fechado ou tem horário diferenciado.
            </p>
          </div>
          <button
            onClick={openNewHoliday}
            className="flex w-full shrink-0 items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 sm:w-auto"
          >
            <Plus className="h-4 w-4" strokeWidth={1.8} /> Novo feriado
          </button>
        </div>

        {holidays.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            Nenhum feriado cadastrado.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {holidays.map((h) => (
              // Celular: data, descrição, horário e ações empilham — as três
              // colunas de largura fixa (110/1fr/180px) somam mais que os
              // 360px disponíveis. Do md: pra cima volta à linha única.
              <div
                key={h.id}
                className="flex flex-col gap-1.5 p-4 md:flex-row md:items-center md:gap-4"
              >
                <div className="text-sm font-semibold tabular-nums text-foreground md:w-[110px] md:shrink-0">
                  {fmtDate(h.data)}
                </div>
                <div className="min-w-0 md:flex-1">
                  <div className="text-sm text-foreground truncate">
                    {h.descricao ?? (
                      <span className="text-muted-foreground italic">sem descrição</span>
                    )}
                  </div>
                </div>
                <div className="text-xs text-muted-foreground tabular-nums md:w-[180px] md:shrink-0 md:text-sm">
                  {h.inicio_override && h.fim_override
                    ? `${h.inicio_override} — ${h.fim_override}`
                    : "Dia fechado"}
                </div>
                <div className="flex items-center gap-1 md:shrink-0">
                  <button
                    onClick={() => openEditHoliday(h)}
                    className="touch-target-mobile inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
                    title="Editar"
                  >
                    <Pencil className="h-4 w-4" strokeWidth={1.8} />
                  </button>
                  <button
                    onClick={() => setConfirmRemoveHoliday(h)}
                    className="touch-target-mobile inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-muted"
                    title="Excluir"
                  >
                    <Trash2 className="h-4 w-4" strokeWidth={1.8} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Modal: adicionar faixa */}
      <Dialog
        open={addSlot.open}
        onOpenChange={(v) => !v && setAddSlot((s) => ({ ...s, open: false }))}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Adicionar faixa — {DIAS_SEMANA.find((d) => d.num === addSlot.dia)?.label}
            </DialogTitle>
          </DialogHeader>
          {/* min-w-0 nos dois <input type="time">: sem isso, dentro do
              Dialog (já estreito no celular), a largura intrínseca de cada
              campo de hora somada não cabe e o modal ganha rolagem
              horizontal própria. */}
          <div className="flex items-center gap-3">
            <input
              type="time"
              value={addSlot.inicio}
              onChange={(e) => setAddSlot((s) => ({ ...s, inicio: e.target.value }))}
              className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <span className="shrink-0 text-muted-foreground">—</span>
            <input
              type="time"
              value={addSlot.fim}
              onChange={(e) => setAddSlot((s) => ({ ...s, fim: e.target.value }))}
              className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <DialogFooter>
            <button
              onClick={() => setAddSlot((s) => ({ ...s, open: false }))}
              className="w-full rounded-md border border-input px-3 py-2 text-sm hover:bg-muted sm:w-auto"
            >
              Cancelar
            </button>
            <button
              onClick={handleAddSlot}
              disabled={busy}
              className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60 sm:w-auto"
            >
              {busy ? "Salvando..." : "Adicionar"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Modal: feriado */}
      <Dialog open={holidayForm.open} onOpenChange={(v) => !v && setHolidayForm(emptyHoliday)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{holidayForm.id ? "Editar feriado" : "Novo feriado"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Data</label>
              <input
                type="date"
                value={holidayForm.data}
                onChange={(e) => setHolidayForm((s) => ({ ...s, data: e.target.value }))}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Descrição
              </label>
              <input
                type="text"
                value={holidayForm.descricao}
                onChange={(e) => setHolidayForm((s) => ({ ...s, descricao: e.target.value }))}
                placeholder="Ex: Natal, Carnaval..."
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={holidayForm.hasOverride}
                onChange={(e) => setHolidayForm((s) => ({ ...s, hasOverride: e.target.checked }))}
              />
              Tem horário diferenciado (em vez de dia fechado)
            </label>
            {holidayForm.hasOverride && (
              <div className="flex items-center gap-3">
                <input
                  type="time"
                  value={holidayForm.inicio}
                  onChange={(e) => setHolidayForm((s) => ({ ...s, inicio: e.target.value }))}
                  className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <span className="shrink-0 text-muted-foreground">—</span>
                <input
                  type="time"
                  value={holidayForm.fim}
                  onChange={(e) => setHolidayForm((s) => ({ ...s, fim: e.target.value }))}
                  className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <button
              onClick={() => setHolidayForm(emptyHoliday)}
              className="w-full rounded-md border border-input px-3 py-2 text-sm hover:bg-muted sm:w-auto"
            >
              Cancelar
            </button>
            <button
              onClick={handleSaveHoliday}
              disabled={busy}
              className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60 sm:w-auto"
            >
              {busy ? "Salvando..." : "Salvar"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm: remover faixa */}
      <AlertDialog
        open={!!confirmRemoveSlot}
        onOpenChange={(v) => !v && setConfirmRemoveSlot(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover esta faixa?</AlertDialogTitle>
            <AlertDialogDescription>
              A faixa será removida do horário comercial. Você pode adicioná-la de novo a qualquer
              momento.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmRemoveSlot && handleRemoveSlot(confirmRemoveSlot)}
            >
              Remover
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirm: remover feriado */}
      <AlertDialog
        open={!!confirmRemoveHoliday}
        onOpenChange={(v) => !v && setConfirmRemoveHoliday(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir feriado?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmRemoveHoliday && fmtDate(confirmRemoveHoliday.data)}
              {confirmRemoveHoliday?.descricao ? ` — ${confirmRemoveHoliday.descricao}` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteHoliday}>Excluir</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
