import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, Plus, Power, PowerOff } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import {
  fetchTemplates,
  updateTemplateTexto,
  setTemplateAtivo,
  createTemplate,
  TEMPLATE_VARS,
  TEMPLATE_VAR_DESC,
  TEMPLATE_LABEL,
  type TemplateRow,
} from "@/lib/configuracoes-queries";

function fmtWhen(iso: string): string {
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function TemplatesTab() {
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [newOpen, setNewOpen] = useState(false);
  const [newChave, setNewChave] = useState("");
  const [newTexto, setNewTexto] = useState("");

  const load = async (preserveKey?: string) => {
    setLoading(true);
    try {
      const list = await fetchTemplates();
      setTemplates(list);
      if (list.length) {
        const keep =
          preserveKey && list.some((t) => t.chave === preserveKey)
            ? preserveKey
            : selectedKey && list.some((t) => t.chave === selectedKey)
            ? selectedKey
            : list[0].chave;
        setSelectedKey(keep);
        const sel = list.find((t) => t.chave === keep);
        if (sel) setDraft(sel.texto);
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = useMemo(
    () => templates.find((t) => t.chave === selectedKey) ?? null,
    [templates, selectedKey],
  );

  const vars = selected ? TEMPLATE_VARS[selected.chave] ?? [] : [];
  const isDirty = selected ? draft !== selected.texto : false;

  const handleSelect = (chave: string) => {
    if (isDirty) {
      const ok = window.confirm("Você tem alterações não salvas. Descartar?");
      if (!ok) return;
    }
    setSelectedKey(chave);
    const sel = templates.find((t) => t.chave === chave);
    if (sel) setDraft(sel.texto);
    setSavedFlash(false);
  };

  const handleSave = async () => {
    if (!selected) return;
    if (!draft.trim()) {
      toast.error("O texto não pode ficar vazio.");
      return;
    }
    setSaving(true);
    try {
      await updateTemplateTexto(selected.id, draft);
      toast.success("Template salvo.");
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 2000);
      await load(selected.chave);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (row: TemplateRow, ativo: boolean) => {
    try {
      await setTemplateAtivo(row.id, ativo);
      toast.success(ativo ? "Template ativado." : "Template desativado.");
      await load(row.chave);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const insertVariable = (name: string) => {
    const ta = textareaRef.current;
    const placeholder = `{{${name}}}`;
    if (!ta) {
      setDraft((d) => d + placeholder);
      return;
    }
    const start = ta.selectionStart ?? draft.length;
    const end = ta.selectionEnd ?? draft.length;
    const next = draft.slice(0, start) + placeholder + draft.slice(end);
    setDraft(next);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + placeholder.length;
      ta.setSelectionRange(pos, pos);
    });
  };

  const handleCreate = async () => {
    const chave = newChave.trim();
    if (!chave || !/^[a-z0-9_]+$/.test(chave)) {
      toast.error("Chave deve conter apenas letras minúsculas, números e _");
      return;
    }
    if (templates.some((t) => t.chave === chave)) {
      toast.error("Já existe um template com essa chave.");
      return;
    }
    if (!newTexto.trim()) {
      toast.error("Informe o texto do template.");
      return;
    }
    try {
      await createTemplate({ chave, texto: newTexto });
      toast.success("Template criado.");
      setNewOpen(false);
      setNewChave("");
      setNewTexto("");
      await load(chave);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  if (loading && !templates.length) {
    return (
      <div className="rounded-2xl border border-border bg-card p-12 flex items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-end">
        <button
          onClick={() => setNewOpen(true)}
          className="flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" strokeWidth={1.8} /> Novo template
        </button>
      </div>

      <div className="flex flex-col lg:flex-row gap-6">
        {/* Lista */}
        <div className="lg:w-[280px] shrink-0">
          <div className="rounded-2xl border border-border bg-card p-3 shadow-sm">
            <ul className="space-y-1">
              {templates.map((t) => {
                const isSel = t.chave === selectedKey;
                const preview = t.texto.replace(/\n/g, " ").slice(0, 40);
                return (
                  <li key={t.id}>
                    <button
                      onClick={() => handleSelect(t.chave)}
                      className={`flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition-colors border-l-2 ${
                        isSel
                          ? "bg-accent border-primary"
                          : "border-transparent hover:bg-muted"
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span
                            className={`text-sm leading-tight truncate ${
                              isSel ? "font-semibold text-foreground" : "text-foreground"
                            }`}
                          >
                            {TEMPLATE_LABEL[t.chave] ?? t.chave}
                          </span>
                          {!t.ativo && (
                            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                              inativo
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 text-xs text-muted-foreground truncate font-mono">
                          {t.chave}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground truncate">
                          {preview}
                          {t.texto.length > 40 ? "…" : ""}
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>

        {/* Editor */}
        <div className="flex-1 min-w-0">
          {!selected ? (
            <div className="rounded-2xl border border-border bg-card p-12 text-center text-sm text-muted-foreground">
              Selecione um template à esquerda.
            </div>
          ) : (
            <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h3 className="text-base font-semibold text-foreground">
                    {TEMPLATE_LABEL[selected.chave] ?? selected.chave}
                  </h3>
                  <p className="mt-1 text-xs text-muted-foreground font-mono">
                    {selected.chave}
                  </p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-xs text-muted-foreground">
                    {selected.ativo ? "Ativo" : "Inativo"}
                  </span>
                  <Switch
                    checked={selected.ativo}
                    onCheckedChange={(v) => handleToggle(selected, v)}
                  />
                  {selected.ativo ? (
                    <Power className="h-4 w-4 text-emerald-600" strokeWidth={1.8} />
                  ) : (
                    <PowerOff className="h-4 w-4 text-muted-foreground" strokeWidth={1.8} />
                  )}
                </div>
              </div>

              {(selected.chave === "triagem_pergunta_departamento" ||
                selected.chave === "triagem_pergunta_assunto") && (
                <div className="mt-4 rounded-md border border-border bg-card px-3 py-2 text-xs text-blue-900">
                  <strong>Mensagem interativa:</strong> esta pergunta é enviada
                  no WhatsApp como uma <em>lista de opções</em> (botão "Ver{" "}
                  {selected.chave === "triagem_pergunta_departamento"
                    ? "setores"
                    : "assuntos"}
                  "). O texto acima vira o corpo da mensagem; as opções vêm
                  automaticamente de{" "}
                  <strong>
                    {selected.chave === "triagem_pergunta_departamento"
                      ? "Departamentos"
                      : "Assuntos"}
                  </strong>{" "}
                  (gerencie naquela aba). A variável{" "}
                  <code className="font-mono">
                    {selected.chave === "triagem_pergunta_departamento"
                      ? "{{lista_departamentos}}"
                      : "{{lista_assuntos}}"}
                  </code>{" "}
                  pode ser removida — não aparece mais no WhatsApp.
                </div>
              )}

              <div className="mt-4 grid gap-4 lg:grid-cols-[1fr,220px]">
                <div>
                  <textarea
                    ref={textareaRef}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    className="w-full min-h-[220px] max-h-[420px] rounded-2xl border border-border bg-background p-4 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <div className="text-xs text-muted-foreground">
                      Atualizado por{" "}
                      <span className="font-medium text-foreground">
                        {selected.updated_by_nome ?? "—"}
                      </span>{" "}
                      em {fmtWhen(selected.updated_at)}
                    </div>
                    <div className="flex items-center gap-2">
                      {savedFlash && (
                        <span className="flex items-center gap-1 text-xs text-emerald-600">
                          <Check className="h-3.5 w-3.5" strokeWidth={2} /> Salvo
                        </span>
                      )}
                      <button
                        onClick={handleSave}
                        disabled={saving || !isDirty}
                        className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                      >
                        {saving ? "Salvando..." : "Salvar"}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="rounded-xl border border-border bg-background p-3">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Variáveis disponíveis
                  </h4>
                  {vars.length === 0 ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Este template não recebe variáveis dinâmicas — é enviado como texto fixo.
                    </p>
                  ) : (
                    <ul className="mt-2 space-y-2">
                      {vars.map((v) => (
                        <li key={v}>
                          <button
                            onClick={() => insertVariable(v)}
                            className="block w-full text-left rounded-md px-2 py-1.5 hover:bg-muted"
                            title="Inserir no texto"
                          >
                            <code className="text-xs font-mono text-primary">
                              {`{{${v}}}`}
                            </code>
                            <p className="mt-0.5 text-[11px] text-muted-foreground leading-snug">
                              {TEMPLATE_VAR_DESC[v] ?? ""}
                            </p>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Modal: novo template */}
      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Novo template</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Chave (identificador estável)
              </label>
              <input
                type="text"
                value={newChave}
                onChange={(e) => setNewChave(e.target.value.toLowerCase())}
                placeholder="ex: aviso_personalizado"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Apenas letras minúsculas, números e _
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Texto
              </label>
              <textarea
                value={newTexto}
                onChange={(e) => setNewTexto(e.target.value)}
                className="w-full min-h-[140px] rounded-md border border-input bg-background p-3 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>
          <DialogFooter>
            <button
              onClick={() => setNewOpen(false)}
              className="rounded-md border border-input px-3 py-2 text-sm hover:bg-muted"
            >
              Cancelar
            </button>
            <button
              onClick={handleCreate}
              className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Criar
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
