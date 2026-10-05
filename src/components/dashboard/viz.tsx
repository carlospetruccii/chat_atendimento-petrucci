import { cn } from "@/lib/utils";

/**
 * Primitivas visuais da seção de Relacionamento.
 *
 * Construídas em HTML/CSS em vez de Recharts de propósito: as formas usadas
 * aqui (histograma rotulado, barra 100% empilhada, dumbbell antes→depois)
 * precisam de controle fino de folga entre preenchimentos, ponta arredondada só
 * na extremidade do dado e rótulo direto em cada marca. Recharts entrega isso
 * só à base de override.
 *
 * Regra que vale para todas: nenhum valor pode existir só no hover. As barras
 * carregam rótulo visível porque --viz-rapido fica abaixo de 3:1 contra a
 * superfície do card, e nesse caso o rótulo deixa de ser enfeite e passa a ser
 * requisito de acessibilidade.
 */

interface VizCardProps {
  titulo: string;
  descricao: string;
  children: React.ReactNode;
  /** Faixa inferior de leitura — o "e daí?" da métrica. */
  rodape?: React.ReactNode;
  className?: string;
}

export function VizCard({ titulo, descricao, children, rodape, className }: VizCardProps) {
  return (
    <section
      className={cn(
        "flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm",
        className,
      )}
    >
      <header className="px-4 pt-5 sm:px-6">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {titulo}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground/80">{descricao}</p>
      </header>

      {/* flex-col aqui é o que permite um bloco filho crescer com flex-1 e
          centrar o próprio estado vazio. Sem isso, num card curto ao lado de um
          alto, a folga toda se acumula acima do rodapé. */}
      <div className="flex flex-1 flex-col px-4 py-4 sm:px-6">{children}</div>

      {rodape ? (
        <footer className="border-t border-border bg-[var(--layer-3)] px-4 py-3 text-xs text-muted-foreground sm:px-6">
          {rodape}
        </footer>
      ) : null}
    </section>
  );
}

interface HeroNumeroProps {
  valor: string;
  /** Etiqueta curta ao lado do número: "reativo", "trocas por conversa". */
  unidade?: string;
  /** Linha de contexto abaixo — o comparativo que impede a leitura errada. */
  contexto?: React.ReactNode;
  /** Tom do número. `alerta` só quando o dado realmente pede atenção. */
  tom?: "normal" | "alerta";
}

/** Travessão de "sem dado" — em 40px ele vira um traço solto na tela. */
const SEM_DADO = "—";

export function HeroNumero({ valor, unidade, contexto, tom = "normal" }: HeroNumeroProps) {
  const vazio = valor === SEM_DADO;

  return (
    <div>
      {/* flex-wrap: rede de segurança pra unidade longa ("clientes falando
          menos") ao lado do número de 40px num card estreito — não quebra o
          caso comum (cabe numa linha), só evita estourar o raro. */}
      <div className="flex flex-wrap items-baseline gap-2">
        {/* Sem tabular-nums: em tamanho display, dígitos de largura fixa deixam
            o número frouxo. Alinhamento vertical não é problema aqui. */}
        <span
          className={cn(
            "font-semibold leading-none tracking-tight",
            vazio
              ? "text-2xl text-muted-foreground"
              : cn("text-[40px]", tom === "alerta" ? "text-destructive" : "text-foreground"),
          )}
        >
          {valor}
        </span>
        {unidade ? (
          <span className="text-sm font-medium text-muted-foreground">{unidade}</span>
        ) : null}
      </div>
      {contexto ? <p className="mt-2 text-xs text-muted-foreground">{contexto}</p> : null}
    </div>
  );
}

interface LinhaBarraProps {
  rotulo: string;
  valor: number;
  /** Maior valor do conjunto — define a escala compartilhada das linhas. */
  maximo: number;
  cor: string;
  /** Marca discreta à direita, tipo "dói". */
  anotacao?: string;
  /**
   * Reserva a coluna da anotação em TODAS as linhas da lista. Precisa ser
   * ligado no conjunto inteiro quando alguma linha tem anotação: se a coluna
   * aparecesse só na linha anotada, aquela barra ficaria mais curta que as
   * outras e a escala deixaria de ser comparável.
   */
  reservarAnotacao?: boolean;
  /** Largura da coluna do rótulo, para alinhar listas de rótulos curtos. */
  larguraRotulo?: string;
}

/**
 * Uma linha de histograma: rótulo, barra e valor. A barra é fina, ancorada à
 * esquerda e arredondada só na ponta do dado.
 */
export function LinhaBarra({
  rotulo,
  valor,
  maximo,
  cor,
  anotacao,
  reservarAnotacao = false,
  larguraRotulo = "52px",
}: LinhaBarraProps) {
  const largura = maximo > 0 ? Math.max((valor / maximo) * 100, valor > 0 ? 1.5 : 0) : 0;

  return (
    <div className="flex items-center gap-3">
      <span
        className="shrink-0 text-right text-[11px] tabular-nums text-muted-foreground"
        style={{ width: larguraRotulo }}
      >
        {rotulo}
      </span>
      <div className="relative h-2 flex-1 rounded-full bg-[var(--viz-grid)]">
        <div
          className="absolute inset-y-0 left-0 rounded-r-[4px] transition-[width] duration-500 ease-out"
          style={{ width: `${largura}%`, backgroundColor: cor }}
        />
      </div>
      <span className="w-8 shrink-0 text-right text-xs font-medium tabular-nums text-foreground">
        {valor}
      </span>
      {reservarAnotacao ? (
        // Some abaixo de sm: no celular essa coluna comia ~58px (largura +
        // gap) que a barra precisa mais, e a anotação ("dói") é só reforço visual
        // — o mesmo dado já aparece por extenso no rodapé do card. O rótulo
        // de VALOR (span acima) nunca some: esse sim é obrigatório.
        <span className="hidden w-[46px] shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/70 sm:block">
          {anotacao ?? ""}
        </span>
      ) : null}
    </div>
  );
}

export interface SegmentoBarra {
  chave: string;
  rotulo: string;
  valor: number;
  cor: string;
}

/**
 * Barra 100% empilhada. Os segmentos são separados por 2px da cor da
 * superfície — folga, não borda: borda em volta da marca engrossa o desenho.
 */
export function BarraEmpilhada({ segmentos }: { segmentos: SegmentoBarra[] }) {
  const total = segmentos.reduce((acc, s) => acc + s.valor, 0);
  if (total <= 0) return <ListaVazia texto="Sem conversas no período" />;

  const visiveis = segmentos.filter((s) => s.valor > 0);

  return (
    <div>
      <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-full">
        {visiveis.map((s) => (
          <div
            key={s.chave}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{ width: `${(s.valor / total) * 100}%`, backgroundColor: s.cor }}
            title={`${s.rotulo}: ${s.valor}`}
          />
        ))}
      </div>

      {/* Legenda sempre presente com 2+ séries, e rotulada com o valor: a
          identidade nunca depende só da cor. */}
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
        {segmentos.map((s) => (
          <li key={s.chave} className="flex items-center gap-2 text-xs">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: s.cor }}
              aria-hidden
            />
            <span className="text-foreground">{s.rotulo}</span>
            <span className="tabular-nums text-muted-foreground">
              {s.valor} · {Math.round((s.valor / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ListaVazia({
  texto,
  tom = "neutro",
  /** Ocupa a folga restante do card e centra o texto nela. */
  preencher = false,
}: {
  texto: string;
  tom?: "neutro" | "bom";
  preencher?: boolean;
}) {
  return (
    <p
      className={cn(
        "text-center text-xs",
        preencher ? "flex flex-1 items-center justify-center py-6" : "py-6",
        tom === "bom" ? "text-[var(--viz-rapido)]" : "text-muted-foreground",
      )}
    >
      {texto}
    </p>
  );
}

/** Nome de departamento no caminho de uma peregrinação. */
export function ChipDepartamento({ nome }: { nome: string }) {
  return (
    <span className="rounded-md bg-[var(--layer-3)] px-1.5 py-0.5 text-[11px] font-medium text-foreground">
      {nome}
    </span>
  );
}
