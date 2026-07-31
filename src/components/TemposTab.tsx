import { useEffect, useState } from "react";
import { Pencil, Loader2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  fetchTempos,
  updateTempo,
  TEMPO_GRUPOS,
  type TempoRow,
} from "@/lib/configuracoes-queries";

export function TemposTab() {
  const [rows, setRows] = useState<TempoRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<TempoRow | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      setRows(await fetchTempos());
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const openEdit = (row: TempoRow) => {
    setEditing(row);
    setDraft(row.valor === null ? "" : String(row.valor));
  };

  const handleSave = async () => {
    if (!editing) return;
    const n = Number(draft);
    if (!Number.isInteger(n) || n < editing.min || n > editing.max) {
      toast.error(`Valor deve ser inteiro entre ${editing.min} e ${editing.max}.`);
      return;
    }
    setSaving(true);
    try {
      await updateTempo(editing.chave, n);
      toast.success("Tempo atualizado.");
      setEditing(null);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-card shadow-sm">
      <div className="border-b border-border p-6">
        <h3 className="text-base font-semibold text-foreground">Tempos do sistema</h3>
        <p className="mt-1 text-sm text-muted-foreground max-w-3xl">
          Defina os prazos automáticos de triagem, reserva, notificação e encerramento.
        </p>
      </div>

      {loading && !rows ? (
        <div className="p-12 flex items-center justify-center text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : (
        <div className="divide-y divide-border">
          {TEMPO_GRUPOS.map((grupo) => {
            const doGrupo = (rows ?? []).filter((f) => f.grupo === grupo.id);
            if (doGrupo.length === 0) return null;
            return (
              <section key={grupo.id}>
                <div className="bg-muted/40 px-6 py-3">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground">
                    {grupo.titulo}
                  </h4>
                  <p className="mt-0.5 text-xs text-muted-foreground">{grupo.descricao}</p>
                </div>
                <div className="divide-y divide-border">
                  {doGrupo.map((f) => (
                    <div key={f.chave} className="p-6">
                      <div className="flex items-start justify-between gap-6">
                        <div className="flex-1 min-w-0">
                          <label className="block text-sm font-semibold text-foreground">
                            {f.label}
                          </label>
                          {f.inativo && (
                            <span className="mt-1.5 inline-flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                              <AlertTriangle className="h-3 w-3" strokeWidth={2} />
                              {f.inativo}
                            </span>
                          )}
                          <p className="mt-1 text-xs text-muted-foreground max-w-2xl">
                            {f.descricao ?? "—"}
                          </p>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <span className="text-sm font-semibold text-foreground tabular-nums">
                            {f.valor ?? "—"}
                          </span>
                          <span className="text-sm text-muted-foreground w-24">
                            {f.unit || "—"}
                          </span>
                          <button
                            type="button"
                            onClick={() => openEdit(f)}
                            className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted"
                            title="Editar"
                          >
                            <Pencil className="h-4 w-4" strokeWidth={1.8} />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <Dialog open={!!editing} onOpenChange={(v) => !v && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing?.label}</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">{editing.descricao ?? ""}</p>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={editing.min}
                  max={editing.max}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  className="w-[140px] rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <span className="text-sm text-muted-foreground">{editing.unit || "—"}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Faixa permitida: {editing.min} – {editing.max}
              </p>
            </div>
          )}
          <DialogFooter>
            <button
              onClick={() => setEditing(null)}
              className="rounded-md border border-input px-3 py-2 text-sm hover:bg-muted"
            >
              Cancelar
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {saving ? "Salvando..." : "Salvar"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
