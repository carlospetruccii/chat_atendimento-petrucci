import { ArrowRight } from "lucide-react";
import { ChipDepartamento, HeroNumero, LinhaBarra, ListaVazia, VizCard } from "./viz";
import { resumoTransferencias } from "@/lib/relacionamento-format";
import type { TransferenciasCompletas } from "@/lib/relacionamento-queries";

/**
 * A partir de quantos saltos a linha da distribuição deixa de ser rotina e
 * passa a ser peregrinação. Um repasse é normal; dois já significa que o
 * cliente contou o problema pra três times diferentes.
 */
const SALTOS_PROBLEMA = 2;

export function RelacionamentoTransferencias({
  dados,
  className,
}: {
  dados: TransferenciasCompletas;
  className?: string;
}) {
  const { mediaPorConversa, pctComTransferencia, pctDuasOuMais } = resumoTransferencias(dados);
  const maximo = dados.distribuicao.reduce((acc, f) => Math.max(acc, f.total), 0);
  const temConversas = dados.conversas > 0;

  return (
    <VizCard
      className={className}
      titulo="Peregrinação entre departamentos"
      descricao="Trocas de departamento por conversa. Só conta quando o departamento muda."
      rodape={
        // Sem conversa nenhuma, "nenhuma passou por 2+ departamentos" é uma
        // frase verdadeira que soa como resultado bom. Não é resultado: é
        // ausência de dado, e o rodapé precisa dizer isso.
        !temConversas ? (
          <span>Sem conversas no período.</span>
        ) : dados.duas_ou_mais > 0 ? (
          <span>
            <strong className="font-medium text-destructive">{pctDuasOuMais}%</strong> das conversas
            passaram por dois departamentos ou mais.
          </span>
        ) : (
          <span>Nenhuma conversa passou por dois departamentos ou mais no período.</span>
        )
      }
    >
      <HeroNumero
        valor={temConversas ? mediaPorConversa : "—"}
        unidade="trocas por conversa"
        contexto={
          temConversas ? (
            <>
              {dados.com_transferencia} de {dados.conversas} conversas ({pctComTransferencia}%)
              trocaram de departamento pelo menos uma vez.
            </>
          ) : null
        }
      />

      <div className="mt-5">
        {temConversas ? (
          // Ênfase: 0 e 1 salto são rotina (cinza), 2+ é o que dói (laranja).
          <div className="flex flex-col gap-[6px]">
            {dados.distribuicao.map((faixa, i) => (
              <LinhaBarra
                key={faixa.faixa}
                rotulo={faixa.faixa === "0" ? "nenhuma" : faixa.faixa}
                valor={faixa.total}
                maximo={maximo}
                cor={i >= SALTOS_PROBLEMA ? "var(--viz-alerta)" : "var(--viz-neutro)"}
                // Só anota se houver o que anotar: marcar "dói" numa linha que
                // vale 0 aponta pra um problema que não existe.
                anotacao={i === SALTOS_PROBLEMA && dados.duas_ou_mais > 0 ? "dói" : undefined}
                reservarAnotacao
                larguraRotulo="60px"
              />
            ))}
          </div>
        ) : (
          <ListaVazia texto="Sem conversas no período" preencher />
        )}
      </div>

      {/* A lista de caminhos só existe quando há caminho. Sem conversa nenhuma,
          o card já disse "sem conversas no período" acima — repetir a mesma
          frase num segundo bloco vazio só faz o card parecer quebrado. */}
      {temConversas ? (
        <div className="mt-6 flex flex-1 flex-col">
          <h4 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Caminhos percorridos
          </h4>
          {dados.peregrinacoes.length > 0 ? (
            <ul className="mt-3 flex flex-col gap-3">
              {dados.peregrinacoes.map((p) => (
                <li key={p.atendimento_id} className="flex flex-col gap-1.5">
                  {/* min-w-0 por consistência com as outras listas — aqui o
                      pai é flex-col e o span já estica pra largura toda, mas
                      o par min-w-0+truncate é o padrão do arquivo inteiro. */}
                  <span className="min-w-0 truncate text-sm text-foreground">
                    {p.cliente ?? "sem nome"}
                  </span>
                  <div className="flex flex-wrap items-center gap-1">
                    {p.caminho.map((dept, i) => (
                      <span key={`${p.atendimento_id}-${i}`} className="flex items-center gap-1">
                        {i > 0 ? (
                          <ArrowRight
                            className="h-3 w-3 text-muted-foreground/60"
                            strokeWidth={2}
                            aria-hidden
                          />
                        ) : null}
                        <ChipDepartamento nome={dept} />
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <ListaVazia
              preencher
              texto="Ninguém foi jogado de um time pra outro — é o cenário bom"
              tom="bom"
            />
          )}
        </div>
      ) : null}
    </VizCard>
  );
}
