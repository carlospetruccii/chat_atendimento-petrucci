import { BarraEmpilhada, HeroNumero, VizCard } from "./viz";
import { resumoIniciativa } from "@/lib/relacionamento-format";
import type { Iniciativa } from "@/lib/relacionamento-format";

export function RelacionamentoIniciativa({ dados }: { dados: Iniciativa }) {
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
    </VizCard>
  );
}
