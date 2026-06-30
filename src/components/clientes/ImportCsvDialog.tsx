import { useState, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2, X, Upload, AlertCircle, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { cadastrarClientesBatch, type CadastrarClienteBatchResp } from "@/lib/clientes-queries";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onImported: () => void;
}

interface ParsedRow {
  nome: string;
  telefone: string;
  linha: number;
}

interface ParseResult {
  rows: ParsedRow[];
  headerError: string | null;
}

function parseCsv(text: string): ParseResult {
  const lines = text.replace(/\r\n/g, "\n").split("\n").map((l) => l.trim());
  if (lines.length === 0 || lines.every((l) => !l)) {
    return { rows: [], headerError: "Arquivo vazio" };
  }

  const sep = lines[0].includes(";") && !lines[0].includes(",") ? ";" : ",";
  const firstCells = lines[0]
    .split(sep)
    .map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ""));

  const hasHeader =
    firstCells.includes("nome") &&
    (firstCells.includes("telefone") ||
      firstCells.includes("celular") ||
      firstCells.includes("whatsapp"));

  let idxNome = 0;
  let idxTel = 1;
  let startLine = 0;

  if (hasHeader) {
    idxNome = firstCells.indexOf("nome");
    idxTel = firstCells.findIndex((c) =>
      ["telefone", "celular", "whatsapp"].includes(c),
    );
    startLine = 1;
  }

  const rows: ParsedRow[] = [];
  for (let i = startLine; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw) continue;
    const cells = raw.split(sep).map((c) => c.trim().replace(/^"|"$/g, ""));
    rows.push({
      nome: cells[idxNome] ?? "",
      telefone: cells[idxTel] ?? "",
      linha: i + 1,
    });
  }
  return { rows, headerError: null };
}

export function ImportCsvDialog({ open, onOpenChange, onImported }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [resultado, setResultado] = useState<CadastrarClienteBatchResp | null>(null);

  const reset = () => {
    setParsed(null);
    setFileName(null);
    setResultado(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  async function handleFile(file: File) {
    setFileName(file.name);
    setResultado(null);
    const text = await file.text();
    setParsed(parseCsv(text));
  }

  const mut = useMutation({
    mutationFn: async () => {
      if (!parsed) throw new Error("Nenhum arquivo carregado");
      return cadastrarClientesBatch(
        parsed.rows.map((r) => ({ nome: r.nome, telefone: r.telefone })),
      );
    },
    onSuccess: (resp) => {
      setResultado(resp);
      toast.success(
        `Importação concluída: ${resp.criados} criados, ${resp.atualizados} atualizados, ${resp.erros.length} erros`,
      );
      onImported();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!open) return null;

  const preview = parsed?.rows.slice(0, 20) ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => !mut.isPending && (reset(), onOpenChange(false))}
    >
      <div
        className="w-full max-w-2xl rounded-lg bg-card p-6 shadow-lg max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <h4 className="text-base font-semibold text-foreground">Importar clientes (CSV ou TXT)</h4>
          <button
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mt-2 text-xs text-muted-foreground">
          Arquivo .csv ou .txt com <code className="px-1 bg-muted rounded">nome, telefone</code>{" "}
          (nessa ordem, uma linha por cliente). O cabeçalho é opcional. Telefones existentes terão o nome atualizado.
        </p>

        {!parsed && !resultado && (
          <div className="mt-6">
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
              className="hidden"
            />
            <button
              onClick={() => inputRef.current?.click()}
              className="flex w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border bg-background px-6 py-12 text-sm text-muted-foreground hover:border-primary hover:bg-muted"
            >
              <Upload className="h-6 w-6" />
              <span>Clique para selecionar um arquivo CSV ou TXT</span>
            </button>
          </div>
        )}

        {parsed?.headerError && (
          <div className="mt-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>{parsed.headerError}</div>
          </div>
        )}

        {parsed && !parsed.headerError && !resultado && (
          <div className="mt-4 space-y-4">
            <div className="rounded-md border border-border bg-muted px-3 py-2 text-xs">
              <div>
                Arquivo: <strong>{fileName}</strong>
              </div>
              <div className="mt-1 text-muted-foreground">
                {parsed.rows.length} linha(s) detectada(s). Telefones inválidos ou duplicados serão
                reportados após o envio.
              </div>
            </div>

            <div className="overflow-hidden rounded-md border border-border">
              <table className="w-full text-xs">
                <thead className="bg-muted">
                  <tr className="text-left">
                    <th className="px-3 py-2 font-medium">#</th>
                    <th className="px-3 py-2 font-medium">Nome</th>
                    <th className="px-3 py-2 font-medium">Telefone</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((r) => (
                    <tr key={r.linha} className="border-t border-border">
                      <td className="px-3 py-2 text-muted-foreground">{r.linha}</td>
                      <td className="px-3 py-2">{r.nome || <span className="text-destructive">vazio</span>}</td>
                      <td className="px-3 py-2">{r.telefone || <span className="text-destructive">vazio</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {parsed.rows.length > 20 && (
                <div className="border-t border-border bg-muted px-3 py-2 text-[11px] text-muted-foreground">
                  + {parsed.rows.length - 20} linha(s) não exibida(s).
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <button
                onClick={reset}
                disabled={mut.isPending}
                className="rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
              >
                Trocar arquivo
              </button>
              <button
                onClick={() => mut.mutate()}
                disabled={mut.isPending || parsed.rows.length === 0}
                className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {mut.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Confirmar importação
              </button>
            </div>
          </div>
        )}

        {resultado && (
          <div className="mt-4 space-y-4">
            <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
              <CheckCircle2 className="h-5 w-5 shrink-0 mt-0.5" />
              <div>
                <div className="font-medium">Importação concluída</div>
                <div className="text-xs mt-1">
                  Total: {resultado.total} • Criados: {resultado.criados} • Atualizados:{" "}
                  {resultado.atualizados} • Erros: {resultado.erros.length}
                </div>
              </div>
            </div>

            {resultado.erros.length > 0 && (
              <div className="overflow-hidden rounded-md border border-amber-200">
                <div className="bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
                  Linhas com erro
                </div>
                <table className="w-full text-xs">
                  <thead className="bg-muted">
                    <tr className="text-left">
                      <th className="px-3 py-2 font-medium">Linha</th>
                      <th className="px-3 py-2 font-medium">Motivo</th>
                      <th className="px-3 py-2 font-medium">Nome</th>
                      <th className="px-3 py-2 font-medium">Telefone</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resultado.erros.slice(0, 50).map((e, i) => (
                      <tr key={i} className="border-t border-border">
                        <td className="px-3 py-2 text-muted-foreground">{e.linha}</td>
                        <td className="px-3 py-2">{e.motivo}</td>
                        <td className="px-3 py-2">{e.nome ?? ""}</td>
                        <td className="px-3 py-2">{e.telefone ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex justify-end">
              <button
                onClick={() => {
                  reset();
                  onOpenChange(false);
                }}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                Fechar
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
