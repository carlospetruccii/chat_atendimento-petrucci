import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Search, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import {
  fetchPermissionsMatrix,
  grantPermission,
  PERMISSION_CATALOG,
  revokePermission,
  UserPermsRow,
} from "@/lib/configuracoes-queries";

const avatarPalette = [
  "bg-card text-blue-700",
  "bg-emerald-100 text-emerald-700",
  "bg-purple-100 text-purple-700",
  "bg-amber-100 text-amber-700",
  "bg-rose-100 text-rose-700",
  "bg-cyan-100 text-cyan-700",
  "bg-indigo-100 text-indigo-700",
  "bg-pink-100 text-pink-700",
];

function colorForName(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return avatarPalette[h % avatarPalette.length];
}

function initials(n: string) {
  return n.split(" ").map((p) => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
}

export function PermissoesTab() {
  const qc = useQueryClient();
  const matrixQ = useQuery({ queryKey: ["perms-matrix"], queryFn: fetchPermissionsMatrix });
  const [selectedKey, setSelectedKey] = useState<string>(PERMISSION_CATALOG[0].key);
  const [search, setSearch] = useState("");

  const allUsers = matrixQ.data ?? [];
  const colaboradores = useMemo(() => allUsers.filter((u) => !u.is_superadmin), [allUsers]);

  const selected = PERMISSION_CATALOG.find((p) => p.key === selectedKey)!;
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const u of colaboradores) {
      for (const p of u.permissions) m.set(p, (m.get(p) ?? 0) + 1);
    }
    return m;
  }, [colaboradores]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return colaboradores;
    return colaboradores.filter((c) => c.nome.toLowerCase().includes(q));
  }, [colaboradores, search]);

  const toggleMut = useMutation({
    mutationFn: async ({ user_id, on }: { user_id: string; on: boolean }) => {
      if (on) await grantPermission(user_id, selectedKey);
      else await revokePermission(user_id, selectedKey);
    },
    onMutate: async ({ user_id, on }) => {
      await qc.cancelQueries({ queryKey: ["perms-matrix"] });
      const prev = qc.getQueryData<UserPermsRow[]>(["perms-matrix"]);
      qc.setQueryData<UserPermsRow[]>(["perms-matrix"], (old) =>
        (old ?? []).map((u) =>
          u.id === user_id
            ? {
                ...u,
                permissions: on
                  ? Array.from(new Set([...u.permissions, selectedKey]))
                  : u.permissions.filter((p) => p !== selectedKey),
              }
            : u,
        ),
      );
      return { prev };
    },
    onError: (e: Error, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["perms-matrix"], ctx.prev);
      toast.error(e.message);
    },
    onSuccess: (_d, vars) => {
      toast.success(vars.on ? "Permissão concedida" : "Permissão revogada");
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["perms-matrix"] }),
  });

  if (matrixQ.isLoading) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const isEmpty = filtered.every((c) => !c.permissions.includes(selectedKey));

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
        <h3 className="text-base font-semibold text-foreground">Permissões</h3>
        <p className="mt-1 text-sm text-muted-foreground max-w-3xl">
          Permissões são aditivas. Cada colaborador começa sem permissões especiais e ganha apenas
          as flags que você liberar individualmente. A Luana tem todas implicitamente.
        </p>
      </div>

      <div className="flex flex-col lg:flex-row gap-6 lg:h-[calc(100vh-280px)]">
        <div className="lg:w-[380px] shrink-0 lg:h-full">
          <div className="rounded-2xl border border-border bg-card p-4 shadow-sm flex flex-col lg:h-full">
            <h4 className="px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Permissões disponíveis
            </h4>
            <ul className="mt-3 space-y-1 overflow-y-auto pr-1 flex-1 min-h-0">
              {PERMISSION_CATALOG.map((p) => {
                const isSel = p.key === selectedKey;
                const count = counts.get(p.key) ?? 0;
                return (
                  <li key={p.key}>
                    <button
                      onClick={() => setSelectedKey(p.key)}
                      className={`flex w-full items-start justify-between gap-2 rounded-md px-2.5 py-2 text-left transition-colors border-l-2 ${
                        isSel ? "bg-muted border-primary" : "border-transparent hover:bg-muted/60"
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold text-foreground leading-tight">
                          {p.label}
                        </div>
                        <div className="mt-0.5 text-xs text-muted-foreground truncate">
                          {p.description}
                        </div>
                      </div>
                      <span className="shrink-0 inline-flex items-center justify-center min-w-6 h-5 rounded bg-muted px-1.5 text-[11px] font-medium text-muted-foreground">
                        {count}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>

        <div className="flex-1 min-w-0 lg:h-full">
          <div className="rounded-2xl border border-border bg-card p-6 shadow-sm flex flex-col lg:h-full overflow-y-auto">
            <h3 className="text-base font-semibold text-foreground">{selected.label}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{selected.description}</p>
            <p className="mt-2 text-xs italic text-muted-foreground">
              Flag de RLS: <code className="font-mono text-[11px]">{selected.key}</code>
            </p>

            <div className="mt-6 flex items-center justify-between gap-3">
              <h4 className="text-sm font-medium text-foreground">
                Colaboradores com esta permissão
              </h4>
              <div className="relative w-56">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                  strokeWidth={1.5}
                />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Buscar..."
                  className="w-full rounded-2xl border border-border bg-card py-1.5 pl-9 pr-3 text-sm"
                />
              </div>
            </div>

            {isEmpty && (
              <div className="mt-5 flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card py-8 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                  <ShieldCheck className="h-5 w-5 text-muted-foreground" strokeWidth={1.5} />
                </div>
                <p className="mt-3 text-sm font-medium text-foreground">
                  Nenhum colaborador tem esta permissão ainda.
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Use os switches abaixo para liberar a permissão.
                </p>
              </div>
            )}

            <ul className="mt-4 divide-y divide-border rounded-xl border border-border bg-card">
              {filtered.map((c) => {
                const has = c.permissions.includes(selectedKey);
                return (
                  <li key={c.id} className="flex items-center gap-3 px-4 py-3">
                    <div
                      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${colorForName(c.nome)}`}
                    >
                      {initials(c.nome)}
                    </div>
                    <div className="min-w-0 flex-1 flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {c.nome}
                      </span>
                      <span
                        className="shrink-0 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
                        style={{ backgroundColor: `${c.department_cor}22`, color: c.department_cor }}
                      >
                        {c.department_nome}
                      </span>
                    </div>
                    <Switch
                      checked={has}
                      disabled={toggleMut.isPending}
                      onCheckedChange={(v) => toggleMut.mutate({ user_id: c.id, on: v })}
                    />
                  </li>
                );
              })}
              {filtered.length === 0 && (
                <li className="px-4 py-6 text-center text-sm text-muted-foreground">
                  Nenhum colaborador encontrado.
                </li>
              )}
            </ul>

            <p className="mt-4 text-xs text-muted-foreground">
              A Luana possui todas as permissões implicitamente e não aparece nesta lista.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
