import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { HeroNumero, LinhaBarra, ListaVazia, VizCard } from "./viz";
import { formatarMinutos, resumoEspera } from "@/lib/relacionamento-format";
import type { TomEspera } from "@/lib/relacionamento-format";
import type { PrimeiraResposta } from "@/lib/relacionamento-queries";

const COR_POR_TOM: Record<TomEspera, string> = {
  rapido: "var(--viz-rapido)",
  ok: "var(--viz-neutro)",
  lento: "var(--viz-alerta)",
};

export function RelacionamentoPrimeiraResposta({ dados }: { dados: PrimeiraResposta }) {
  const { linhas, total, pctAte15min } = resumoEspera(dados.histograma);
  const maximo = linhas.reduce((acc, l) => Math.max(acc, l.total), 0);
  const temAmostra = total > 0;

  return (
    <VizCard
      titulo="Primeira resposta"
      descricao="Quanto o cliente esperou pela primeira resposta, em horário de expediente. Só entra conversa que o cliente puxou."
      rodape={
        dados.pior ? (
          <span>
            Quem mais esperou:{" "}
            <strong className="font-medium text-foreground">
              {dados.pior.cliente ?? "cliente sem nome"}
            </strong>
            ,{" "}
            <strong className="font-medium text-destructive">
              {formatarMinutos(dados.pior.min)}
            </strong>
            {dados.pior.quando
              ? ` · ${format(new Date(dados.pior.quando), "dd 'de' MMM", { locale: ptBR })}`
              : null}
          </span>
        ) : (
          <span>Nenhum atendimento respondido no período.</span>
        )
      }
    >
      {/* O número grande é a mediana, chamada aqui de "tempo típico": uma
          espera de 4h entre 20 respostas rápidas move a média e não move a
          mediana. A média aparece logo abaixo, e o texto explica por que as
          duas diferem — senão parece contradição com o KPI do topo, que é a
          média em tempo de relógio. */}
      <HeroNumero
        valor={temAmostra ? formatarMinutos(dados.p50_min) : "—"}
        unidade="tempo típico"
        contexto={
          temAmostra ? (
            <>
              Metade das conversas foi respondida mais rápido que isso. A média é{" "}
              {formatarMinutos(dados.media_min)}, maior porque poucos casos demorados puxam ela pra
              cima; 95% em até {formatarMinutos(dados.p95_min)}. {total} respondidos
              {dados.sem_resposta > 0 ? (
                <>
                  {" e "}
                  <strong className="font-medium text-foreground">
                    {dados.sem_resposta} sem nenhuma resposta
                  </strong>
                </>
              ) : null}
              .
            </>
          ) : null
        }
      />

      <div className="mt-5 flex flex-1 flex-col">
        {temAmostra ? (
          <>
            <div className="flex flex-col gap-2">
              {linhas.map((l) => (
                <div key={l.faixa} className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <LinhaBarra
                      rotulo={l.faixa}
                      valor={l.total}
                      maximo={maximo}
                      cor={COR_POR_TOM[l.tom]}
                      larguraRotulo="72px"
                    />
                  </div>
                  <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                    {l.pct}%
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              <strong className="font-medium text-[var(--viz-rapido)]">{pctAte15min}%</strong> foram
              respondidos em até 15 minutos.
            </p>
          </>
        ) : (
          <ListaVazia texto="Sem respostas registradas no período" preencher />
        )}
      </div>
    </VizCard>
  );
}
