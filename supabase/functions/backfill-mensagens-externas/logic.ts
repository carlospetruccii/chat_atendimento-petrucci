// Decisões puras do backfill (sem banco e sem rede), para poder testar.
//
// `idsPossiveis` e `inteiroNoIntervalo` moraram aqui primeiro e hoje vivem em
// _shared/historico.ts: a importação de histórico antigo precisa EXATAMENTE da
// mesma leitura de id (as duas gravam em `mensagens` e uma tem que enxergar o
// que a outra gravou, senão duplica). Reexportados para não mudar os
// chamadores.
export { idsPossiveis, inteiroNoIntervalo } from "../_shared/historico.ts";
