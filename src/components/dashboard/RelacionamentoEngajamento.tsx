import { HeroNumero, ListaVazia, VizCard } from "./viz";
import { formatarDelta, nivelRiscoQueda, rotuloJanela } from "@/lib/relacionamento-format";
import type { Engajamento, QuedaEngajamento } from "@/lib/relacionamento-queries";
import type { NivelRisco } from "@/lib/relacionamento-format";

/** Rampa ordinal de um matiz só — quanto mais escuro, pior a queda. */
const COR_POR_NIVEL: Record<NivelRisco, string> = {
  medio: "var(--viz-queda-1)",
  alto: "var(--viz-queda-2)",
  critico: "var(--viz-queda-3)",
};

export function RelacionamentoEngajamento({ dados }: { dados: Engajamento }) {
  // Escala compartilhada entre os clientes: sem isso cada linha teria régua
  // própria e as quedas deixariam de ser comparáveis entre si.
  const maximo = dados.quedas.reduce((acc, q) => Math.max(acc, q.antes, q.agora), 0);
  const temBaseline = dados.clientes_avaliados > 0;

  return (
    <VizCard
      titulo="Engajamento em queda"
      descricao="Volume de mensagens de cada cliente contra o histórico dele — não contra a média geral."
      rodape={
        temBaseline ? (
          <span>
            Compara {rotuloJanela(dados.janela_dias)}. Entram só clientes com pelo menos{" "}
            {dados.baseline_min} mensagens na janela anterior.
            {dados.janela_reduzida ? (
              <>
                {" "}
                <strong className="font-medium text-foreground">
                  Régua encurtada para {dados.janela_dias} dias
                </strong>{" "}
                porque ainda não há 30 dias de histórico anterior.
              </>
            ) : null}
          </span>
        ) : (
          <span>
            Ainda não há histórico anterior suficiente para comparar. A métrica acende sozinha
            quando a base acumular duas janelas de mensagens.
          </span>
        )
      }
    >
      <HeroNumero
        valor={temBaseline ? String(dados.em_queda) : "—"}
        unidade={dados.em_queda === 1 ? "cliente falando menos" : "clientes falando menos"}
        contexto={
          temBaseline ? (
            <>
              De {dados.clientes_avaliados} clientes com histórico comparável. No conjunto:{" "}
              {dados.msgs_antes} mensagens antes, {dados.msgs_agora} agora.
            </>
          ) : null
        }
        tom={dados.em_queda > 0 ? "alerta" : "normal"}
      />

      {dados.quedas.length > 0 ? (
        <ul className="mt-5 flex flex-col gap-4">
          {dados.quedas.map((q) => (
            <LinhaQueda key={q.client_id} queda={q} maximo={maximo} />
          ))}
        </ul>
      ) : (
        <ListaVazia
          preencher
          texto={
            temBaseline
              ? "Nenhum cliente caiu mais de 50% — é o cenário bom"
              : "Aguardando baseline"
          }
          tom={temBaseline ? "bom" : "neutro"}
        />
      )}
    </VizCard>
  );
}

/**
 * Par de barras antes/depois numa escala compartilhada.
 *
 * A forma óbvia aqui seria um dumbbell, e ele foi tentado primeiro — mas numa
 * queda o valor atual é SEMPRE menor que o anterior, então o ponto do "antes"
 * cai à direita do "agora" e qualquer rótulo em coluna fixa passa a contradizer
 * a posição do próprio ponto. Duas barras empilhadas leem de cima para baixo na
 * ordem do tempo, mantêm a escala comparável entre clientes e não têm como
 * confundir qual número é qual.
 */
function LinhaQueda({ queda, maximo }: { queda: QuedaEngajamento; maximo: number }) {
  const cor = COR_POR_NIVEL[nivelRiscoQueda(queda.delta_pct)];

  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-sm text-foreground">{queda.cliente ?? "sem nome"}</span>
        <span className="shrink-0 text-sm font-semibold tabular-nums" style={{ color: cor }}>
          {formatarDelta(queda.delta_pct)}
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <BarraQueda rotulo="antes" valor={queda.antes} maximo={maximo} cor="var(--viz-neutro)" />
        <BarraQueda rotulo="agora" valor={queda.agora} maximo={maximo} cor={cor} />
      </div>

      <span className="text-[11px] text-muted-foreground">
        {queda.dias_sem_contato > 0
          ? `${queda.dias_sem_contato} dias sem escrever`
          : "ainda escrevendo"}
      </span>
    </li>
  );
}

function BarraQueda({
  rotulo,
  valor,
  maximo,
  cor,
}: {
  rotulo: string;
  valor: number;
  maximo: number;
  cor: string;
}) {
  const largura = maximo > 0 ? Math.max((valor / maximo) * 100, valor > 0 ? 1.5 : 0) : 0;

  return (
    <div className="flex items-center gap-2">
      <span className="w-9 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/70">
        {rotulo}
      </span>
      <div className="relative h-1.5 flex-1 rounded-full bg-[var(--viz-grid)]">
        <div
          className="absolute inset-y-0 left-0 rounded-r-[4px]"
          style={{ width: `${largura}%`, backgroundColor: cor }}
        />
      </div>
      <span className="w-7 shrink-0 text-right text-[11px] font-medium tabular-nums text-foreground">
        {valor}
      </span>
    </div>
  );
}
