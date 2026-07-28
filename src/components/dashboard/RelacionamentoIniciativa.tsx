import { BarraEmpilhada, HeroNumero, ListaVazia, VizCard } from "./viz";
import { resumoIniciativa } from "@/lib/relacionamento-format";
import type { IniciativaCompleta } from "@/lib/relacionamento-queries";

export function RelacionamentoIniciativa({ dados }: { dados: IniciativaCompleta }) {
  const { pctReativo, pctProativo, pctProativoForaDoSistema } = resumoIniciativa(dados);
  const temConversas = dados.total > 0;

  return (
    <VizCard
      titulo="Quem puxa a conversa"
      descricao="Proporção proativo × reativo — a métrica mais honesta de relacionamento."
      rodape={
        dados.empresa > 0 ? (
          <span>
            <strong className="font-medium text-foreground">{pctProativoForaDoSistema}%</strong> do
            contato proativo saiu pelo celular, fora da plataforma ({dados.empresa_fora_do_sistema}{" "}
            de {dados.empresa}).
          </span>
        ) : (
          <span>Nenhuma conversa foi iniciada pela empresa no período.</span>
        )
      }
    >
      <HeroNumero
        valor={temConversas ? `${pctReativo}%` : "—"}
        unidade="reativo"
        contexto={
          temConversas ? (
            <>
              {dados.cliente} de {dados.total} conversas começaram com o cliente. Só {pctProativo}%
              partiram da empresa.
            </>
          ) : null
        }
        tom={pctReativo >= 90 ? "alerta" : "normal"}
      />

      <div className="mt-5">
        {/* Forma de ênfase: o cinza é contexto, o verde é o que se quer ver
            crescer. Duas séries, legenda sempre presente e cada segmento
            rotulado com valor e percentual. */}
        <BarraEmpilhada
          segmentos={[
            {
              chave: "cliente",
              rotulo: "Cliente puxou",
              valor: dados.cliente,
              cor: "var(--viz-neutro)",
            },
            {
              chave: "empresa",
              rotulo: "Empresa puxou",
              valor: dados.empresa,
              cor: "var(--viz-rapido)",
            },
          ]}
        />
      </div>

      {/* Sem conversa nenhuma a barra acima já diz "sem conversas no período";
          um segundo bloco repetindo a frase faz o card parecer quebrado. */}
      {temConversas ? (
        <div className="mt-6 flex flex-1 flex-col">
          <h4 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Contas em que só o cliente puxa
          </h4>
          {dados.contas_reativas.length > 0 ? (
            <ul className="mt-2 flex flex-col divide-y divide-border">
              {dados.contas_reativas.map((conta) => (
                <li
                  key={conta.client_id}
                  className="flex items-center justify-between gap-3 py-2 text-sm"
                >
                  <span className="truncate text-foreground">{conta.cliente ?? "sem nome"}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {conta.pct_cliente}% de {conta.conversas} conversas
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <ListaVazia preencher texto="Nenhuma conta é 100% reativa no período" tom="bom" />
          )}
        </div>
      ) : null}
    </VizCard>
  );
}
