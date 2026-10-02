// Lógica pura do diff de sincronização de grupos.
// Sem I/O: recebe o que a uazapi devolveu + o que já existe no banco e diz o
// que gravar. Testado em logic.test.ts.

import type { GrupoUazapi } from "../_shared/uazapi-grupos.ts";

export interface GrupoExistente {
  id: string;
  wa_jid: string;
  ativo: boolean;
}

export interface LinhaUpsertGrupo {
  company_id: string;
  wa_jid: string;
  nome: string | null;
  topico: string | null;
  // Sem foto_url de propósito: a /group/list quase nunca traz foto, e o upsert
  // apagaria a que já temos. A foto é cuidada à parte (foto-perfil-sync).
  participantes_total: number | null;
  sou_admin: boolean;
  somente_admin_envia: boolean;
  ativo: true;
  synced_at: string;
}

export interface PlanoSincronizacao {
  /** Linhas para upsert por (company_id, wa_jid). */
  upserts: LinhaUpsertGrupo[];
  /** Ids de grupos que a uazapi não lista mais e estavam ativos → desativar. */
  idsParaDesativar: string[];
  /** Quantos grupos a uazapi devolveu que ainda não existiam no banco. */
  novos: number;
  /**
   * true quando a uazapi não devolveu NENHUM grupo mas o banco tem grupos
   * ativos. Nesse caso a desativação é abortada (`idsParaDesativar` vem vazio)
   * e o chamador avisa em vez de esconder tudo. Ver comentário abaixo.
   */
  respostaVaziaSuspeita: boolean;
}

/**
 * Monta o plano de gravação.
 *
 * Grupo que saiu da lista da uazapi (saímos, fomos removidos ou o grupo morreu)
 * é DESATIVADO, nunca apagado: o histórico de mensagens continua legível e as
 * FKs de grupo_mensagens seguem válidas. Se ele voltar a aparecer, o upsert
 * marca `ativo = true` de novo.
 *
 * SALVAGUARDA da lista vazia: `extrairGruposDaResposta` devolve lista vazia
 * para qualquer resposta 2xx que ela não reconheça — e a uazapi só levanta erro
 * em HTTP não-2xx. Ou seja, um 2xx com envelope diferente do esperado (mudança
 * de versão, instância reconectando) chegaria aqui como "zero grupos" e
 * desativaria TODOS os grupos da empresa de uma vez, fazendo a aba Grupos
 * esvaziar para todo mundo. Como esse é o único jeito de a lista vir vazia por
 * defeito (uma lista parcial é sinal legítimo), tratamos exatamente o caso
 * zero-grupos-mas-tinha-grupos como suspeito e não desativamos nada.
 */
export function planejarSincronizacao(params: {
  companyId: string;
  agoraIso: string;
  daUazapi: readonly GrupoUazapi[];
  noBanco: readonly GrupoExistente[];
}): PlanoSincronizacao {
  const { companyId, agoraIso, daUazapi, noBanco } = params;

  const jidsDaUazapi = new Set(daUazapi.map((g) => g.jid));
  const porJidNoBanco = new Map(noBanco.map((g) => [g.wa_jid, g]));

  const upserts: LinhaUpsertGrupo[] = daUazapi.map((g) => ({
    company_id: companyId,
    wa_jid: g.jid,
    nome: g.nome,
    topico: g.topico,
    participantes_total: g.participantesTotal,
    sou_admin: g.souAdmin,
    somente_admin_envia: g.somenteAdminEnvia,
    ativo: true,
    synced_at: agoraIso,
  }));

  const ativosNoBanco = noBanco.filter((g) => g.ativo);
  const respostaVaziaSuspeita = daUazapi.length === 0 && ativosNoBanco.length > 0;

  const idsParaDesativar = respostaVaziaSuspeita
    ? []
    : ativosNoBanco.filter((g) => !jidsDaUazapi.has(g.wa_jid)).map((g) => g.id);

  const novos = daUazapi.filter((g) => !porJidNoBanco.has(g.jid)).length;

  return { upserts, idsParaDesativar, novos, respostaVaziaSuspeita };
}
