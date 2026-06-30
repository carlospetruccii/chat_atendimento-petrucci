import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Upload, Search, Loader2, ChevronLeft, ChevronRight, Pencil } from "lucide-react";
import {
  listClientesPaginado,
  formatTelefoneBR,
  type ClienteRow,
} from "@/lib/clientes-queries";
import { AddClienteDialog } from "@/components/clientes/AddClienteDialog";
import { ImportCsvDialog } from "@/components/clientes/ImportCsvDialog";
import { EditClienteDialog } from "@/components/clientes/EditClienteDialog";

const PAGE_SIZE = 50;

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export function ClientesTab({ canManage = true }: { canManage?: boolean } = {}) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState<ClienteRow | null>(null);

  const q = useQuery({
    queryKey: ["clientes", search, page],
    queryFn: () => listClientesPaginado({ search, page, pageSize: PAGE_SIZE }),
  });

  const rows: ClienteRow[] = q.data?.rows ?? [];
  const total = q.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const refresh = () => qc.invalidateQueries({ queryKey: ["clientes"] });

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Buscar por nome ou telefone..."
            className="w-full rounded-md border border-border bg-background pl-9 pr-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>
        {canManage && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setImportOpen(true)}
              className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
            >
              <Upload className="h-4 w-4" strokeWidth={1.8} /> Importar CSV/TXT
            </button>
            <button
              onClick={() => setAddOpen(true)}
              className="flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              <Plus className="h-4 w-4" strokeWidth={1.8} /> Adicionar cliente
            </button>
          </div>
        )}
      </div>

      {canManage && (
        <div className="mb-4 rounded-md border border-border bg-muted px-4 py-3 text-xs text-muted-foreground">
          <div className="mb-1.5 font-medium text-foreground">
            Formato do arquivo (CSV ou TXT)
          </div>
          <p className="mb-2">
            Uma linha por cliente, no formato{" "}
            <code className="rounded bg-background px-1 py-0.5">nome, telefone</code>. O cabeçalho é opcional.
          </p>
          <pre className="overflow-x-auto rounded bg-background px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground">
{`Adriano Peças, 11970968081
Felipe Souza, 19971234567
Mileide Santos, 11988887777`}
          </pre>
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-muted">
            <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3 font-medium">Nome</th>
              <th className="px-4 py-3 font-medium">Telefone</th>
              <th className="px-4 py-3 font-medium">Cliente desde</th>
              <th className="px-4 py-3 font-medium">Último atendimento</th>
              <th className="px-4 py-3 font-medium text-right">Total atendimentos</th>
              <th className="px-4 py-3 font-medium text-right w-16">Ações</th>
            </tr>
          </thead>
          <tbody>
            {q.isLoading ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-sm text-muted-foreground">
                  {search ? "Nenhum cliente encontrado." : "Nenhum cliente cadastrado ainda."}
                </td>
              </tr>
            ) : (
              rows.map((c) => (
                <tr key={c.id} className="border-t border-border">
                  <td className="px-4 py-3 text-foreground">
                    {c.nome ?? <span className="text-muted-foreground italic">sem nome</span>}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {formatTelefoneBR(c.numero_whatsapp)}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{formatDate(c.created_at)}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {c.ultimo_atendimento_at ? formatDate(c.ultimo_atendimento_at) : "Nunca"}
                  </td>
                  <td className="px-4 py-3 text-right text-foreground">{c.total_atendimentos}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => setEditing(c)}
                      title="Editar cliente"
                      aria-label="Editar cliente"
                      className="inline-flex items-center justify-center rounded-md border border-border bg-background p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <Pencil className="h-3.5 w-3.5" strokeWidth={1.8} />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {total > PAGE_SIZE && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <div className="text-muted-foreground">
            Página {page} de {totalPages} • {total} cliente(s)
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="flex items-center gap-1 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Anterior
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="flex items-center gap-1 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-40"
            >
              Próxima <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {canManage && (
        <>
          <AddClienteDialog open={addOpen} onOpenChange={setAddOpen} onSaved={refresh} />
          <ImportCsvDialog open={importOpen} onOpenChange={setImportOpen} onImported={refresh} />
        </>
      )}

      <EditClienteDialog
        cliente={editing}
        onOpenChange={(o) => { if (!o) setEditing(null); }}
        onSaved={refresh}
      />
    </>
  );
}
