import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Link2,
  Loader2,
  RefreshCw,
  WifiOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { DocsRespostaAutomatica } from "@/components/DocsRespostaAutomatica";
import {
  configurarWebhookDocs,
  definirAcessoDocs,
  listarAcessoDocs,
  mensagemErroAcessoDocs,
  organizarAcessos,
  resumoConexaoDocs,
  statusConexaoDocs,
  type AcessoDocsRow,
} from "@/lib/docs-config";

// Configuração da aba Docs (número financeiro): quem acessa e se o número está
// conectado e mandando as conversas para cá. Sem QR/desconectar de propósito —
// o número é do outro sistema da Almore, que dispara documentos por ele.

const CHAVE_ACESSO = ["docs-acesso"] as const;
const CHAVE_CONEXAO = ["docs-conexao"] as const;

const TOM_CLASSES = {
  ok: "border-border bg-card",
  alerta: "border-amber-300 bg-amber-50 text-amber-900",
  erro: "border-red-200 bg-red-50 text-red-900",
} as const;

function ConexaoNumeroFinanceiro() {
  const qc = useQueryClient();
  const statusQ = useQuery({
    queryKey: CHAVE_CONEXAO,
    queryFn: statusConexaoDocs,
    refetchInterval: 30_000,
  });

  const webhookM = useMutation({
    mutationFn: configurarWebhookDocs,
    onSuccess: (d) => {
      if (!d.ok) {
        toast.error("Não foi possível configurar o webhook do Docs.");
        return;
      }
      toast.success(
        "Webhook do Docs ligado. As conversas do número financeiro vão aparecer na aba Docs.",
      );
      qc.invalidateQueries({ queryKey: CHAVE_CONEXAO });
    },
    onError: () => toast.error("Falha ao falar com o servidor."),
  });

  if (statusQ.isLoading) {
    return (
      <div className="flex items-center justify-center rounded-2xl border border-border bg-card py-10 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Verificando o número financeiro…
      </div>
    );
  }

  const resumo = resumoConexaoDocs(statusQ.data ?? { ok: false, erro: "falha_uazapi" });
  const Icone =
    resumo.tom === "ok" ? CheckCircle2 : resumo.tom === "alerta" ? AlertTriangle : WifiOff;

  return (
    <div className={`rounded-2xl border p-5 ${TOM_CLASSES[resumo.tom]}`}>
      <div className="flex items-start gap-3">
        <Icone
          className={`mt-0.5 h-5 w-5 shrink-0 ${resumo.tom === "ok" ? "text-emerald-500" : ""}`}
        />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{resumo.titulo}</h3>
          <p className="mt-0.5 break-words text-sm opacity-90">
            {resumo.numero ? `${resumo.numero} · ` : ""}
            {resumo.detalhe}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0"
          aria-label="Atualizar status"
          onClick={() => statusQ.refetch()}
          disabled={statusQ.isFetching}
        >
          <RefreshCw className={`h-4 w-4 ${statusQ.isFetching ? "animate-spin" : ""}`} />
        </Button>
      </div>
      {resumo.precisaWebhook && (
        <Button className="mt-4" onClick={() => webhookM.mutate()} disabled={webhookM.isPending}>
          {webhookM.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Link2 className="mr-2 h-4 w-4" />
          )}
          Configurar webhook do Docs
        </Button>
      )}
    </div>
  );
}

function LinhaPessoa({
  pessoa,
  onToggle,
  salvando,
}: {
  pessoa: AcessoDocsRow;
  onToggle?: (permitir: boolean) => void;
  salvando?: boolean;
}) {
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">{pessoa.nome ?? "Sem nome"}</p>
        <p className="truncate text-xs text-muted-foreground">
          {pessoa.is_superadmin
            ? "Admin — sempre tem acesso"
            : (pessoa.department_nome ?? "Sem departamento")}
        </p>
      </div>
      <Switch
        checked={pessoa.tem_acesso}
        disabled={!onToggle || salvando}
        onCheckedChange={onToggle}
        aria-label={`Acesso de ${pessoa.nome ?? "colaborador"} à aba Docs`}
      />
    </li>
  );
}

function QuemAcessa() {
  const qc = useQueryClient();
  const acessosQ = useQuery({ queryKey: CHAVE_ACESSO, queryFn: listarAcessoDocs });

  const toggleM = useMutation({
    mutationFn: (v: { userId: string; permitir: boolean }) =>
      definirAcessoDocs(v.userId, v.permitir),
    onSuccess: (_d, v) => {
      toast.success(v.permitir ? "Acesso ao Docs liberado." : "Acesso ao Docs removido.");
      qc.invalidateQueries({ queryKey: CHAVE_ACESSO });
    },
    onError: (e) => toast.error(mensagemErroAcessoDocs(e)),
  });

  if (acessosQ.isLoading) {
    return (
      <div className="flex items-center justify-center py-10 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Carregando colaboradores…
      </div>
    );
  }
  if (acessosQ.isError) {
    return <p className="text-sm text-destructive">Não foi possível carregar os colaboradores.</p>;
  }

  const { admins, colaboradores, totalComAcesso } = organizarAcessos(acessosQ.data ?? []);

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {totalComAcesso === 1 ? "1 pessoa acessa" : `${totalComAcesso} pessoas acessam`} a aba Docs.
        Quem perde o acesso solta as conversas que estavam com ela — elas voltam para "Sem dono".
      </p>
      <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
        {colaboradores.map((p) => (
          <LinhaPessoa
            key={p.user_id}
            pessoa={p}
            salvando={toggleM.isPending && toggleM.variables?.userId === p.user_id}
            onToggle={(permitir) => toggleM.mutate({ userId: p.user_id, permitir })}
          />
        ))}
        {admins.map((p) => (
          <LinhaPessoa key={p.user_id} pessoa={p} />
        ))}
      </ul>
    </div>
  );
}

export function DocsConfigTab() {
  return (
    <div className="max-w-2xl space-y-8">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent">
          <FileText className="h-5 w-5 text-primary" strokeWidth={1.75} />
        </div>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">Docs — número financeiro</h2>
          <p className="text-sm text-muted-foreground">
            Conversas de quem responde aos documentos enviados pelo número financeiro.
          </p>
        </div>
      </div>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-foreground">Número financeiro</h3>
        <ConexaoNumeroFinanceiro />
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-foreground">Resposta automática</h3>
        <DocsRespostaAutomatica />
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-foreground">Quem pode acessar</h3>
        <QuemAcessa />
      </section>
    </div>
  );
}
