import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { fetchRelacionamento } from "@/lib/relacionamento-queries";
import type { DashboardRange } from "@/lib/dashboard-queries";
import { RelacionamentoPrimeiraResposta } from "./RelacionamentoPrimeiraResposta";
import { RelacionamentoIniciativa } from "./RelacionamentoIniciativa";
import { RelacionamentoTransferencias } from "./RelacionamentoTransferencias";
import { RelacionamentoEngajamento } from "./RelacionamentoEngajamento";

/**
 * Seção de Relacionamento da dashboard.
 *
 * Os KPIs de cima medem a operação (quantos, quanto tempo). Estes quatro medem
 * a EXPERIÊNCIA de quem está do outro lado, usando só metadados — nenhuma
 * conversa é lida. Vem depois de propósito: são leitura de gestão, não de
 * plantão.
 */
export function RelacionamentoSection({ range }: { range: DashboardRange }) {
  const { data, isLoading, isError, error, isFetching } = useQuery({
    queryKey: ["dashboard-relacionamento", range.from, range.to],
    queryFn: () => fetchRelacionamento(range),
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });

  return (
    <section className="flex flex-col gap-4">
      <header className="flex items-baseline justify-between gap-4 border-t border-border pt-6">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Relacionamento</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Sinais de experiência do cliente tirados só de metadados — nenhuma conversa é lida.
          </p>
        </div>
      </header>

      {isError ? (
        <p className="rounded-2xl border border-destructive/30 bg-card px-6 py-5 text-sm text-destructive">
          Não foi possível carregar as métricas de relacionamento
          {error instanceof Error && error.message ? `: ${error.message}` : "."}
        </p>
      ) : isLoading ? (
        <EsqueletoRelacionamento />
      ) : data ? (
        // Em refetch a grade fica visível com opacidade reduzida em vez de
        // voltar ao esqueleto: sem pulo de layout a cada 60s.
        <div
          className={cn(
            "grid grid-cols-1 gap-4 transition-opacity xl:grid-cols-2",
            isFetching && "opacity-60",
          )}
        >
          <RelacionamentoPrimeiraResposta dados={data.primeira_resposta} />
          <RelacionamentoIniciativa dados={data.iniciativa} />
          <RelacionamentoTransferencias dados={data.transferencias} />
          <RelacionamentoEngajamento dados={data.engajamento} />
        </div>
      ) : null}
    </section>
  );
}

function EsqueletoRelacionamento() {
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="h-[420px] animate-pulse rounded-2xl border border-border bg-card"
          aria-hidden
        />
      ))}
    </div>
  );
}
