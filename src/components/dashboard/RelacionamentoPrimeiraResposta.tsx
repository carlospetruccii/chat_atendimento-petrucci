import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { HeroNumero, LinhaBarra, ListaVazia, VizCard } from "./viz";
import { formatarMinutos, pctCauda } from "@/lib/relacionamento-format";
import type { PrimeiraResposta } from "@/lib/relacionamento-queries";

/**
 * Quantas faixas finais do histograma contam como "cauda". O RPC devolve 8
 * faixas em ordem crescente; as 3 últimas são 1–2h, 2–4h e 4h+. Marcar por
 * índice em vez de por rótulo evita acoplar o front ao texto das faixas.
 */
const FAIXAS_DE_CAUDA = 3;

export function RelacionamentoPrimeiraResposta({ dados }: { dados: PrimeiraResposta }) {
  const { histograma } = dados;
  const maximo = histograma.reduce((acc, f) => Math.max(acc, f.total), 0);
  const inicioCauda = Math.max(histograma.length - FAIXAS_DE_CAUDA, 0);
  const rotuloInicioCauda = histograma[inicioCauda]?.faixa ?? "";
  const pctNaCauda = pctCauda(histograma, rotuloInicioCauda);

  const temAmostra = dados.total > 0;

  return (
    <VizCard
      titulo="Primeira resposta"
      descricao="Em minutos de expediente, olhando a cauda — não a média."
      rodape={
        dados.pior ? (
          <span>
            Pior episódio:{" "}
            <strong className="font-medium text-foreground">
              {dados.pior.cliente ?? "cliente sem nome"}
            </strong>{" "}
            esperou{" "}
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
      <HeroNumero
        valor={formatarMinutos(dados.p95_min)}
        unidade="p95"
        contexto={
          temAmostra ? (
            <>
              Mediana {formatarMinutos(dados.p50_min)} · média {formatarMinutos(dados.media_min)}.{" "}
              {dados.total} respondidos
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
            <div className="flex flex-col gap-[6px]">
              {histograma.map((faixa, i) => {
                const naCauda = i >= inicioCauda;
                return (
                  <LinhaBarra
                    key={faixa.faixa}
                    rotulo={faixa.faixa}
                    valor={faixa.total}
                    maximo={maximo}
                    cor={naCauda ? "var(--viz-cauda)" : "var(--viz-rapido)"}
                    anotacao={i === inicioCauda ? "cauda" : undefined}
                    reservarAnotacao
                  />
                );
              })}
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              <strong className="font-medium text-[var(--viz-cauda)]">{pctNaCauda}%</strong> das
              respostas passaram de uma hora de expediente.
            </p>
          </>
        ) : (
          <ListaVazia texto="Sem respostas registradas no período" preencher />
        )}
      </div>
    </VizCard>
  );
}
