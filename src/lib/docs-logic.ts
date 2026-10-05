// Regras puras da aba Docs (conversas do número FINANCEIRO). Nada aqui fala
// com o Supabase: é o que a tela decide sozinha — quem vê o quê, quem pode
// agir, como a lista se ordena, quando tocar o aviso. O banco e as Edge
// Functions revalidam tudo (ver 20260929200000_docs_numero_financeiro.sql);
// isto é experiência de uso, não autorização.

import { dateLabel, dayKeySP } from "./inbox-history";

const TZ = "America/Sao_Paulo";

/** Permissão (user_permissions) que libera a aba para colaboradores. */
export const PERMISSAO_DOCS = "docs_acesso";

export type DocsStatus = "so_envio" | "sem_dono" | "em_andamento" | "encerrada";
export type DocsFiltro = "todas" | "sem_dono" | "em_andamento" | "encerradas";

/** Uma linha da lista de conversas do Docs. */
export interface DocsConversa {
  id: string;
  clientId: string;
  clientNome: string;
  clientNumero: string;
  status: DocsStatus;
  assignedTo: string | null;
  assignedNome: string | null;
  lastMessageAt: string | null;
  /** Última mensagem do CLIENTE — o "tique azul" só dispara quando ela muda. */
  lastInboundAt: string | null;
  createdAt: string;
  lastMessagePreview: string;
  unread: number;
}

// ————————————————————————————————————————————————————————————————
// Acesso e ações
// ————————————————————————————————————————————————————————————————

/** Admin sempre; colaborador só com a permissão `docs_acesso`. */
export function podeAcessarDocs(
  user: { isSuperadmin: boolean; permissions: string[] } | null,
): boolean {
  if (!user) return false;
  return user.isSuperadmin || user.permissions.includes(PERMISSAO_DOCS);
}

const ROTULO_STATUS: Record<DocsStatus, string> = {
  so_envio: "Só envio",
  sem_dono: "Sem dono",
  em_andamento: "Em andamento",
  encerrada: "Encerrada",
};

const CLASSE_STATUS: Record<DocsStatus, string> = {
  so_envio: "bg-muted text-muted-foreground",
  sem_dono: "bg-amber-100 text-amber-700",
  em_andamento: "bg-[color-mix(in_oklab,var(--wa-green)_16%,transparent)] text-primary",
  encerrada: "bg-slate-200 text-slate-700",
};

export function rotuloStatus(status: DocsStatus): string {
  return ROTULO_STATUS[status];
}

/** Classes Tailwind do chip de status (lista e cabeçalho). */
export function classeStatus(status: DocsStatus): string {
  return CLASSE_STATUS[status];
}

export interface AcoesConversa {
  /** Só o dono de uma conversa em andamento manda mensagem. */
  podeEscrever: boolean;
  podeAssumir: boolean;
  /** Assumir tiraria a conversa de outra pessoa (só admin chega aqui). */
  tomaDeOutro: boolean;
  podeRepassar: boolean;
  podeEncerrar: boolean;
  /** Editar/apagar o que já foi enviado: dono ou admin (régua da docs-acao). */
  podeAlterarMensagens: boolean;
}

/**
 * O que a pessoa pode fazer nesta conversa, espelhando as RPCs:
 *  - docs_assumir: qualquer um com acesso, menos tomar de outra pessoa (só admin);
 *  - docs_repassar / docs_encerrar: dono ou admin. Encerrar some em 'so_envio'
 *    (o cliente nunca escreveu, não há o que encerrar) e em 'encerrada'.
 */
export function acoesDaConversa(
  conversa: Pick<DocsConversa, "status" | "assignedTo">,
  user: { id: string; isSuperadmin: boolean },
): AcoesConversa {
  const souDono = conversa.status === "em_andamento" && conversa.assignedTo === user.id;
  const deOutraPessoa = conversa.status === "em_andamento" && !souDono;
  const donoOuAdmin = souDono || user.isSuperadmin;
  return {
    podeEscrever: souDono,
    podeAssumir: !souDono && (!deOutraPessoa || user.isSuperadmin),
    tomaDeOutro: deOutraPessoa && user.isSuperadmin,
    podeRepassar: donoOuAdmin,
    podeEncerrar:
      donoOuAdmin && (conversa.status === "em_andamento" || conversa.status === "sem_dono"),
    podeAlterarMensagens: donoOuAdmin,
  };
}

/** Faixa no lugar do composer para quem não é dono. null = pode escrever. */
export function avisoSomenteLeitura(
  conversa: Pick<DocsConversa, "status" | "assignedTo" | "assignedNome">,
  meuUserId: string,
): string | null {
  if (conversa.status === "em_andamento") {
    if (conversa.assignedTo === meuUserId) return null;
    return `Conversa com ${conversa.assignedNome ?? "outra pessoa"} — só quem é dono responde.`;
  }
  return "Assuma a conversa para responder.";
}

/** Minúsculas e sem acento, para busca local ("jose" acha "José"). */
function semAcento(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

// ————————————————————————————————————————————————————————————————
// Mensagens: prévia, remetente, rótulo de externo
// ————————————————————————————————————————————————————————————————

/**
 * Última mensagem, no formato da RPC docs_ultimas_mensagens. `sentByUserId` e
 * `origem` são opcionais: `undefined` = a fonte não informou, e aí o prefixo
 * sai neutro ("Equipe:", "Financeiro:") em vez de chutar.
 */
export interface MensagemResumo {
  tipo: string;
  content: string | null;
  direction: string;
  senderType: string;
  apagadaEm: string | null;
  fileName?: string | null;
  sentByUserId?: string | null;
  origem?: string | null;
}

function origemDe(meta: Record<string, unknown> | null | undefined): string | null {
  const origem = meta?.origem;
  return typeof origem === "string" ? origem : null;
}

function corpoDaMensagem(m: MensagemResumo): string {
  if (m.apagadaEm) return "🚫 Mensagem apagada";
  if (m.content?.trim()) return m.content.trim();
  switch (m.tipo) {
    case "imagem":
      return "📷 Imagem";
    case "audio":
      return "🎤 Áudio";
    case "video":
      return "🎥 Vídeo";
    case "documento":
      return m.fileName?.trim() ? `📎 ${m.fileName.trim()}` : "📎 Documento";
    case "sticker":
      return "Figurinha";
    default:
      return m.tipo ? `(${m.tipo})` : "";
  }
}

function prefixoDeSaida(m: MensagemResumo, meuUserId: string): string {
  if (m.senderType === "atendente") return m.sentByUserId === meuUserId ? "Você" : "Equipe";
  if (m.senderType === "externo") {
    if (m.origem === "api_externa") return "Sistema";
    if (m.origem === "celular") return "Celular";
    // Os dois saem do número financeiro; sem saber qual, diz só isso.
    return "Financeiro";
  }
  return "Sistema";
}

/** Prévia da última mensagem na lista de conversas. */
export function previewDaMensagem(m: MensagemResumo | null, meuUserId: string): string {
  if (!m) return "";
  const corpo = corpoDaMensagem(m);
  if (!corpo || m.direction !== "outbound") return corpo;
  return `${prefixoDeSaida(m, meuUserId)}: ${corpo}`;
}

/** Legenda embaixo das bolhas 'externo' (documento do outro sistema ou celular). */
export function rotuloExterno(meta: Record<string, unknown> | null): string {
  const origem = origemDe(meta);
  if (origem === "api_externa") return "Enviado pelo sistema financeiro";
  if (origem === "celular") return "Enviado pelo celular do financeiro";
  return "Enviado fora do sistema";
}

/** Nome de quem mandou a mensagem (citação, prévia de resposta). */
export function autorDaMensagemDocs(
  m: {
    direction: string;
    senderType: string;
    sentByUserId: string | null;
    sentByNome: string | null;
    mediaMetadata: Record<string, unknown> | null;
  },
  params: { meuUserId: string; clienteNome: string },
): string {
  if (m.direction !== "outbound") return params.clienteNome;
  if (m.senderType === "sistema") return "Sistema";
  if (m.senderType === "externo") {
    return origemDe(m.mediaMetadata) === "api_externa"
      ? "Sistema financeiro"
      : "Celular do financeiro";
  }
  if (m.sentByUserId === params.meuUserId) return "Você";
  return m.sentByNome ?? "Atendente";
}

// ————————————————————————————————————————————————————————————————
// Notificação
// ————————————————————————————————————————————————————————————————

/**
 * Mensagem nova do cliente: em conversa sem dono avisa todo mundo com acesso
 * (alguém precisa pegar); em andamento, só o dono. O status já vem atualizado
 * pelo gatilho do banco (so_envio/encerrada → sem_dono na mesma transação).
 */
export function deveNotificarDocs(params: {
  direction: string | undefined;
  status: DocsStatus | null;
  assignedTo: string | null;
  meuUserId: string;
}): boolean {
  if (params.direction !== "inbound") return false;
  if (params.status === "sem_dono") return true;
  return params.status === "em_andamento" && params.assignedTo === params.meuUserId;
}

// ————————————————————————————————————————————————————————————————
// Repasse
// ————————————————————————————————————————————————————————————————

export interface PessoaDocs {
  userId: string;
  nome: string;
  departamentoNome: string | null;
  isSuperadmin: boolean;
  temAcesso: boolean;
}

/**
 * Destinos do repasse: quem tem acesso ao Docs, menos o dono atual (a RPC
 * recusaria), agrupados por departamento como no repasse da Inbox.
 */
export function candidatosRepasse(
  pessoas: PessoaDocs[],
  params: { donoAtual: string | null; busca: string },
): Array<{ departamento: string; pessoas: PessoaDocs[] }> {
  const termo = semAcento(params.busca.trim());
  const grupos = new Map<string, PessoaDocs[]>();
  for (const p of pessoas) {
    if (!p.temAcesso || p.userId === params.donoAtual) continue;
    if (termo && !semAcento(p.nome).includes(termo)) continue;
    const dept = p.departamentoNome ?? "Sem departamento";
    grupos.set(dept, [...(grupos.get(dept) ?? []), p]);
  }
  return Array.from(grupos.entries())
    .sort(([a], [b]) => a.localeCompare(b, "pt-BR"))
    .map(([departamento, lista]) => ({ departamento, pessoas: lista }));
}

// ————————————————————————————————————————————————————————————————
// Linha do tempo dentro do chat
// ————————————————————————————————————————————————————————————————

export type DocsEventoTipo = "iniciada" | "assumida" | "repassada" | "encerrada" | "reaberta";

export interface DocsEvento {
  id: string;
  tipo: DocsEventoTipo;
  actorUserId: string | null;
  actorNome: string | null;
  targetUserId: string | null;
  targetNome: string | null;
  observacao: string | null;
  createdAt: string;
}

/** Frase curta do separador de evento ("Ana repassou para você"). */
export function rotuloEvento(e: DocsEvento, meuUserId: string): string {
  const ator = e.actorUserId && e.actorUserId === meuUserId ? "Você" : (e.actorNome ?? "Alguém");
  switch (e.tipo) {
    case "iniciada":
      return `${ator} iniciou a conversa`;
    case "assumida":
      return `${ator} assumiu a conversa${e.observacao ? ` · ${e.observacao}` : ""}`;
    case "repassada": {
      const alvo =
        e.targetUserId && e.targetUserId === meuUserId ? "você" : (e.targetNome ?? "outra pessoa");
      return `${ator} repassou para ${alvo}${e.observacao ? ` · “${e.observacao}”` : ""}`;
    }
    case "encerrada":
      return `${ator} encerrou a conversa`;
    case "reaberta":
      return e.observacao ?? "Cliente respondeu — conversa voltou para Sem dono";
  }
}

interface MensagemAgrupavel {
  id: string;
  createdAt: string;
  direction: string;
  senderType: string;
  sentByUserId: string | null;
}

export type DocsChatItem<M extends MensagemAgrupavel> =
  | { kind: "date-separator"; key: string; label: string }
  | { kind: "evento"; key: string; label: string }
  | { kind: "message"; key: string; message: M; colada: boolean };

type Entrada<M> = { quando: string; msg?: M; evento?: DocsEvento };

function chaveDoAutor(m: MensagemAgrupavel): string {
  return `${m.direction}:${m.senderType}:${m.sentByUserId ?? "-"}`;
}

/**
 * Intercala separadores de dia, eventos (assumiu/repassou/encerrou) e
 * mensagens em ordem cronológica. `desde` = a mensagem mais antiga carregada
 * quando ainda há páginas acima: evento anterior a ela esperaria a paginação,
 * senão apareceria solto no topo, fora de contexto.
 */
export function agruparItensDocs<M extends MensagemAgrupavel>(
  messages: M[],
  eventos: DocsEvento[],
  params: { desde: string | null; meuUserId: string },
): DocsChatItem<M>[] {
  const visiveis = params.desde
    ? eventos.filter((e) => e.createdAt >= (params.desde as string))
    : eventos;
  const entradas: Entrada<M>[] = [
    ...messages.map((m) => ({ quando: m.createdAt, msg: m })),
    ...visiveis.map((e) => ({ quando: e.createdAt, evento: e })),
  ].sort((a, b) => (a.quando < b.quando ? -1 : a.quando > b.quando ? 1 : 0));

  const itens: DocsChatItem<M>[] = [];
  let ultimoDia: string | null = null;
  let ultimoAutor: string | null = null;
  for (const entrada of entradas) {
    const dia = dayKeySP(entrada.quando);
    if (dia !== ultimoDia) {
      itens.push({ kind: "date-separator", key: `date-${dia}`, label: dateLabel(entrada.quando) });
      ultimoDia = dia;
      ultimoAutor = null;
    }
    if (entrada.evento) {
      const e = entrada.evento;
      itens.push({ kind: "evento", key: `ev-${e.id}`, label: rotuloEvento(e, params.meuUserId) });
      ultimoAutor = null;
      continue;
    }
    const m = entrada.msg as M;
    const autor = chaveDoAutor(m);
    itens.push({ kind: "message", key: m.id, message: m, colada: autor === ultimoAutor });
    ultimoAutor = autor;
  }
  return itens;
}

/** Junta páginas/realtime: dedup por id (a versão nova vence), ordem por data. */
export function mesclarMensagens<M extends { id: string; createdAt: string }>(
  prev: M[],
  incoming: M[],
): M[] {
  if (incoming.length === 0) return prev;
  const map = new Map<string, M>();
  for (const m of prev) map.set(m.id, m);
  for (const m of incoming) map.set(m.id, m);
  return Array.from(map.values()).sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
  );
}

// ————————————————————————————————————————————————————————————————
// Mensagens de erro (RPCs e Edge Functions)
// ————————————————————————————————————————————————————————————————

export type AcaoRpcDocs = "assumir" | "repassar" | "encerrar" | "iniciar";

const SEM_ACESSO = "Você não tem acesso ao Docs.";
const NAO_ENCONTRADA = "Conversa não encontrada — recarregue a lista.";

const ERROS_RPC: Record<AcaoRpcDocs, Record<string, string> & { padrao: string }> = {
  assumir: {
    "42501": SEM_ACESSO,
    P0002: NAO_ENCONTRADA,
    "23505": "Esta conversa já está com outra pessoa. Só um admin pode tomá-la.",
    padrao: "Não foi possível assumir a conversa.",
  },
  repassar: {
    "42501": "Só o dono da conversa ou um admin pode repassar.",
    P0002: NAO_ENCONTRADA,
    "23505": "A conversa já está com essa pessoa.",
    "22023": "Essa pessoa não tem acesso ao Docs.",
    padrao: "Não foi possível repassar a conversa.",
  },
  encerrar: {
    "42501": "Só o dono da conversa ou um admin pode encerrar.",
    P0002: NAO_ENCONTRADA,
    padrao: "Não foi possível encerrar a conversa.",
  },
  iniciar: {
    "42501": SEM_ACESSO,
    P0002: "Contato não encontrado.",
    "23505": "Esta conversa já está com outra pessoa — peça para ela repassar.",
    padrao: "Não foi possível iniciar a conversa.",
  },
};

/** Código do Postgres (mesmos da Inbox) → frase para o toast. */
export function mensagemErroRpcDocs(acao: AcaoRpcDocs, code: string | undefined): string {
  const tabela = ERROS_RPC[acao];
  return (code && tabela[code]) || tabela.padrao;
}

const ERROS_ENVIO: Record<string, string> = {
  unauthorized: "Sua sessão expirou. Entre de novo.",
  nao_e_dono: "Só quem é dono da conversa responde. Assuma a conversa primeiro.",
  forbidden: SEM_ACESSO,
  conversa_nao_encontrada: "Conversa não encontrada.",
  cliente_sem_numero: "O cliente não tem número de WhatsApp cadastrado.",
  arquivo_muito_grande: "Arquivo muito grande (máx 16 MB).",
  arquivo_invalido: "Não foi possível ler o arquivo.",
  upload_falhou: "Não foi possível subir o arquivo. Tente de novo.",
  mensagem_muito_longa: "Mensagem muito longa.",
  reply_invalido: "A mensagem citada não é desta conversa.",
  insert_falhou: "Não foi possível registrar a mensagem. Tente de novo.",
  erro_interno: "Erro no servidor. Tente de novo em instantes.",
};

/** Código `erro` da docs-enviar → frase para o toast. */
export function mensagemErroEnvioDocs(codigo: string | undefined): string {
  return (codigo && ERROS_ENVIO[codigo]) || "Não foi possível enviar a mensagem.";
}

const DETALHE_MOTIVO: Record<string, string> = {
  sem_permissao: "Só o dono da conversa (ou um admin) pode fazer isso.",
  nao_e_dono: "Você só pode encaminhar para conversas em que é o dono.",
  mesma_conversa: "Escolha uma conversa diferente da atual.",
  conversa_destino_nao_encontrada: "Conversa de destino não encontrada.",
};

/**
 * A docs-acao fala o vocabulário da Inbox, com dois sotaques: "nao_encontrada"
 * (a Inbox diz "mensagem_nao_encontrada") e motivos que só existem no Docs, que
 * viram `detalhe` pronto — os tradutores da Inbox mostram o detalhe primeiro.
 */
export function normalizarMotivoDocs(motivo: string | undefined): {
  motivo: string | undefined;
  detalhe?: string;
} {
  if (motivo === "nao_encontrada") return { motivo: "mensagem_nao_encontrada" };
  if (motivo && DETALHE_MOTIVO[motivo]) return { motivo, detalhe: DETALHE_MOTIVO[motivo] };
  return { motivo };
}

// ————————————————————————————————————————————————————————————————
// Hora na lista / nas bolhas
// ————————————————————————————————————————————————————————————————

const HORA_FMT = new Intl.DateTimeFormat("pt-BR", {
  timeZone: TZ,
  hour: "2-digit",
  minute: "2-digit",
});
const DIA_FMT = new Intl.DateTimeFormat("pt-BR", {
  timeZone: TZ,
  day: "2-digit",
  month: "2-digit",
});

/** "09:05" hoje, "Ontem", ou "20/09" — mesmo formato da Inbox, fuso de São Paulo. */
export function formatarHora(iso: string | null, agora: Date = new Date()): string {
  if (!iso) return "";
  const dia = dayKeySP(iso);
  if (dia === dayKeySP(agora.toISOString())) return HORA_FMT.format(new Date(iso));
  const ontem = new Date(agora.getTime() - 24 * 60 * 60 * 1000);
  if (dia === dayKeySP(ontem.toISOString())) return "Ontem";
  return DIA_FMT.format(new Date(iso));
}

/**
 * Divide uma lista em lotes. A lista do Docs pode ter centenas de conversas e
 * `.in("conversa_id", ids)` vai na URL do PostgREST — sem lote, a URL estoura.
 */
export function emLotes<T>(itens: T[], tamanho: number): T[][] {
  if (tamanho <= 0) return [itens];
  const lotes: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) lotes.push(itens.slice(i, i + tamanho));
  return lotes;
}

/** Zera o contador de uma conversa na lista em cache (sem recarregar a lista). */
export function zerarNaoLidas(lista: DocsConversa[], conversaId: string): DocsConversa[] {
  if (!lista.some((c) => c.id === conversaId && c.unread > 0)) return lista;
  return lista.map((c) => (c.id === conversaId ? { ...c, unread: 0 } : c));
}

/**
 * Agrupa pedidos repetidos numa execução só, no fim da janela. Não reinicia o
 * relógio a cada pedido: num disparo em massa de documentos (uma mensagem atrás
 * da outra) a lista ainda atualiza a cada `esperaMs`, em vez de nunca.
 */
export function criarAgendador(
  acao: () => void,
  esperaMs: number,
): { agendar: () => void; cancelar: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    agendar() {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        acao();
      }, esperaMs);
    },
    cancelar() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
