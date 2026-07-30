// Edge Function: triagem-bot (triagem por DEPARTAMENTO).
// Cron a cada 10s. Cobre o ciclo de triagem — o bot pergunta SÓ o departamento:
//  - Continuidade do mesmo dia útil (RN-05.6) curto-circuita boas-vindas.
//  - aguardando_inicio: envia boas-vindas + menu de departamentos.
//      · 0 departamentos → encaminha para Pendentes geral (não some).
//      · 1 departamento  → pula o menu e roteia direto.
//  - aguardando_departamento: identifica dept (numero/exato/parcial), confirma e finaliza.
//  - Finalização: carimba mensagens, roteia (último atendente → pendente).
//  - Abandono: encerra atendimentos parados há mais que tempo_abandono_triagem.
// Idempotência por triagem_last_processed_msg_id; hardening anti-loop em tentativas >= 10.

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { botEstaAtivo, getBotAtivadoEm } from "../_shared/kill-switch.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";
import { enviarListaOpcoes, enviarTexto, type OpcaoLista, ZapiError } from "../_shared/uazapi-client.ts";

const FUNCAO = "triagem-bot";
const BOT_USER_ID = "00000000-0000-0000-0000-000000000001";
const TRIAGEM_DEPT_ID = "00000000-0000-0000-0000-000000000010";
const LOOP_HARD_LIMIT = 10;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Estagio =
  | "aguardando_inicio"
  | "aguardando_departamento"
  | "aguardando_colaborador"
  | "concluida";

interface Atendimento {
  id: string;
  client_id: string;
  triagem_estagio: Estagio;
  triagem_tentativas: number;
  current_department_id: string | null;
  triagem_last_processed_msg_id: string | null;
  // true → veio de um número da Lista de Sessões (fluxo interno: escolhe
  // departamento e depois o colaborador). Sempre false para cliente comum.
  is_sessao: boolean;
}

interface Departamento { id: string; nome: string; }
// Colaborador para o passo "aguardando_colaborador" do fluxo de sessão.
interface Colaborador { id: string; nome: string; }
// Item genérico de menu interativo (departamento ou colaborador).
type ItemMenu = { id: string; nome: string };
interface InboundMsg {
  id: string;
  content: string | null;
  created_at: string;
  media_metadata?: Record<string, unknown> | null;
}

interface Config {
  delaySeg: number;
  maxTentativas: number;
  abandonoMin: number;
  lembreteAtivo: boolean;
  lembreteMin: number;
}

function normalizar(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}
function aplicarTemplate(texto: string, vars: Record<string, string>): string {
  return texto.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] ?? "");
}
function formatarLista(itens: { nome: string }[]): string {
  return itens.map((d, i) => `${i + 1} - ${d.nome}`).join("\n");
}
function telefoneZapi(numero: string): string { return numero.replace(/\D/g, ""); }

// Palavras genéricas de conversa que NÃO ajudam a identificar o setor/pessoa.
// Ignoradas no casamento por texto livre para não gerar falso-positivo (ex.:
// "quero falar com o setor" não pode casar pela palavra "setor").
const STOPWORDS = new Set([
  "quero", "queria", "gostaria", "preciso", "necessito", "desejo",
  "falar", "com", "o", "a", "os", "as", "um", "uma", "uns", "umas",
  "de", "do", "da", "dos", "das", "no", "na", "nos", "nas", "em",
  "pra", "para", "por", "favor", "pf", "pfv",
  "setor", "departamento", "depto", "opcao", "opção", "opções", "opcoes",
  "e", "ou", "que", "meu", "minha", "assunto", "sobre", "atendimento",
  "me", "ajuda", "ajudar", "ao", "isso", "esse", "essa", "tem", "ver",
]);

// Casa a resposta LIVRE do cliente com um item do menu (departamento ou
// colaborador). Ordem de tentativa:
//   1) número puro → índice (1-based) do menu;
//   2) nome do item idêntico ao texto;
//   3) nome do item mencionado no meio da frase ("quero fiscal", "o fiscal"),
//      casando por nome inteiro contido, palavra significativa em comum ou
//      prefixo (>=3 chars) em qualquer direção — só resolve se UM único item
//      casar (ambíguo devolve null e o bot pergunta de novo);
//   4) número solto em meio ao texto ("opção 2", "quero a 3").
// Nunca "chuta": entrada ambígua (0 ou 2+ candidatos) retorna null.
function identificarPorTexto<T extends { id: string; nome: string }>(texto: string, itens: T[]): string | null {
  const t = normalizar(texto);
  if (!t) return null;

  // 1) Número puro → índice.
  if (/^\d+$/.test(t)) {
    const idx = parseInt(t, 10) - 1;
    return idx >= 0 && idx < itens.length ? itens[idx].id : null;
  }

  // 2) Nome idêntico.
  const exato = itens.find((d) => normalizar(d.nome) === t);
  if (exato) return exato.id;

  // 3) Nome mencionado no texto livre.
  const tokens = t.split(/\s+/).filter((x) => x.length > 0);
  const candidatos = new Set<string>();
  for (const d of itens) {
    const nome = normalizar(d.nome);
    // (a) nome completo do item contido no texto ("quero o departamento pessoal").
    if (nome.length >= 3 && t.includes(nome)) {
      candidatos.add(d.id);
      continue;
    }
    // (b) alguma palavra significativa do nome casa com um token do cliente
    //     (igual ou prefixo em qualquer direção, ambos >=3 chars).
    const palavrasNome = nome.split(/\s+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
    let casou = false;
    for (const w of palavrasNome) {
      for (const tok of tokens) {
        if (tok.length < 3 || STOPWORDS.has(tok)) continue;
        if (w === tok || w.startsWith(tok) || tok.startsWith(w)) {
          casou = true;
          break;
        }
      }
      if (casou) break;
    }
    if (casou) candidatos.add(d.id);
  }
  if (candidatos.size === 1) return [...candidatos][0];
  if (candidatos.size > 1) return null; // ambíguo: cliente citou mais de um setor.

  // 4) Número solto em meio ao texto ("opção 2", "quero a 3") — só se houver
  //    exatamente um número e nenhum nome tiver casado acima.
  const numeros = tokens.map((tok) => tok.replace(/\D/g, "")).filter((x) => x !== "");
  if (numeros.length === 1) {
    const idx = parseInt(numeros[0], 10) - 1;
    if (idx >= 0 && idx < itens.length) return itens[idx].id;
  }

  return null;
}

// Resolve um item a partir do CLIQUE numa opção da lista interativa. A uazapi
// devolve o id da opção em media_metadata.selected_id no formato "<prefixo><uuid>"
// (ver opcoesDeDepartamentos/opcoesDeColaboradores). É a fonte mais confiável: o
// texto (content) da resposta de lista costuma chegar vazio. Só resolve se o item
// ainda existir na lista atual (`itens`).
function selectedIdComPrefixo(
  meta: Record<string, unknown> | null | undefined,
  prefixo: string,
  itens: ItemMenu[],
): string | null {
  if (!ehListReply(meta)) return null;
  const sel = typeof meta!.selected_id === "string" ? (meta!.selected_id as string) : null;
  if (!sel || !sel.startsWith(prefixo)) return null;
  const id = sel.slice(prefixo.length);
  return itens.some((d) => d.id === id) ? id : null;
}

// Percorre o lote de inbounds procurando a primeira que resolve para um item do
// menu. Prioridade: (1) clique numa opção (selected_id) — confiável, pois o
// content textual pode chegar vazio; (2) texto livre (número/nome/prefixo).
// Compartilhado pelos passos de departamento (cliente e sessão) e de colaborador.
function resolverItemDoLote(
  lote: InboundMsg[],
  itens: ItemMenu[],
  prefixo: string,
): { itemId: string | null; msgResolvidaId: string | null; resolvidoPorClique: boolean; textosVistos: number } {
  let itemId: string | null = null;
  let msgResolvidaId: string | null = null;
  let resolvidoPorClique = false;
  let textosVistos = 0;
  for (const m of lote) {
    const viaClique = selectedIdComPrefixo(m.media_metadata, prefixo, itens);
    if (viaClique) { itemId = viaClique; msgResolvidaId = m.id; resolvidoPorClique = true; break; }
    const temTexto = !!(m.content && m.content.trim());
    // Resposta de lista que não resolveu conta como tentativa (dispara "não
    // entendi"); pura mídia (sticker/áudio etc.) é ignorada sem consumir tentativa.
    if (!temTexto && !ehListReply(m.media_metadata)) continue;
    textosVistos++;
    if (temTexto) {
      const r = identificarPorTexto(m.content ?? "", itens);
      if (r) { itemId = r; msgResolvidaId = m.id; break; }
    }
  }
  return { itemId, msgResolvidaId, resolvidoPorClique, textosVistos };
}

// Indica se a inbound é resposta de uma lista interativa (clique numa opção),
// mesmo que não resolva para um departamento ativo. Serve para contá-la como
// tentativa (dispara "não entendi") em vez de tratá-la como pura mídia.
function ehListReply(meta: Record<string, unknown> | null | undefined): boolean {
  return !!meta && (meta as { kind?: unknown }).kind === "list_reply";
}

async function carregarConfig(): Promise<Config> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from("system_config").select("chave, valor")
    .in("chave", [
      "delay_anti_flood_triagem", "triagem_max_tentativas",
      "tempo_abandono_triagem",
      "triagem_lembrete_ativo", "triagem_lembrete_minutos",
    ]);
  const m = new Map((data ?? []).map((r) => [r.chave as string, r.valor as string | null]));
  return {
    delaySeg: parseInt(m.get("delay_anti_flood_triagem") ?? "8", 10) || 8,
    maxTentativas: parseInt(m.get("triagem_max_tentativas") ?? "3", 10) || 3,
    abandonoMin: parseInt(m.get("tempo_abandono_triagem") ?? "30", 10) || 30,
    lembreteAtivo: (m.get("triagem_lembrete_ativo") ?? "true") === "true",
    lembreteMin: parseInt(m.get("triagem_lembrete_minutos") ?? "30", 10) || 30,
  };
}

async function carregarDepartamentos(): Promise<Departamento[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("departments").select("id, nome")
    .eq("ativo", true).neq("id", TRIAGEM_DEPT_ID).order("nome", { ascending: true });
  if (error) throw error;
  return (data ?? []) as Departamento[];
}

async function nomeDept(deptId: string): Promise<string> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from("departments").select("nome").eq("id", deptId).maybeSingle();
  return (data as { nome: string } | null)?.nome ?? "";
}

// Colaboradores ativos (não-sistema) de um departamento, para o passo de
// escolha de pessoa no fluxo de sessão. Ordem por nome (igual ao menu de deps).
async function carregarColaboradores(deptId: string): Promise<Colaborador[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("users").select("id, nome")
    .eq("department_id", deptId).eq("ativo", true).eq("is_system_user", false)
    .order("nome", { ascending: true });
  if (error) throw error;
  return (data ?? []) as Colaborador[];
}

// Nome cadastrado na Lista de Sessões para o número do cliente (saudação
// personalizada). Vazio se o número não estiver na lista ou sem nome.
async function nomeSessao(clientId: string): Promise<string> {
  const supabase = getSupabaseAdmin();
  const { data: c } = await supabase.from("clients")
    .select("numero_whatsapp").eq("id", clientId).maybeSingle();
  const numero = (c as { numero_whatsapp: string } | null)?.numero_whatsapp;
  if (!numero) return "";
  const { data } = await supabase.from("sessoes_triagem")
    .select("nome").eq("numero_whatsapp", numero).eq("ativo", true).limit(1).maybeSingle();
  return ((data as { nome: string | null } | null)?.nome ?? "").trim();
}

function primeiroNome(nome: string): string {
  return nome.trim().split(/\s+/)[0] ?? "";
}

// Todas as versões de um template: `texto` (versão 1) + variações cadastradas.
interface VersoesTemplate {
  companyId: string;
  versoes: string[]; // sempre >= 1 elemento (o texto principal)
}
type TemplatesMap = Map<string, VersoesTemplate>;

async function carregarTemplates(chaves: string[]): Promise<TemplatesMap> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("templates_mensagem")
    .select("company_id, chave, texto, variacoes")
    .in("chave", chaves).eq("ativo", true);
  if (error) throw error;
  const map: TemplatesMap = new Map();
  for (const r of data ?? []) {
    const texto = (r.texto as string | null) ?? "";
    const variacoes = ((r.variacoes as string[] | null) ?? [])
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0);
    map.set(r.chave as string, {
      companyId: r.company_id as string,
      versoes: [texto, ...variacoes],
    });
  }
  return map;
}

/**
 * Escolhe qual versão do template enviar para `destino` (telefone), alternando
 * as variações em round-robin para não repetir o mesmo texto duas vezes
 * seguidas ao mesmo contato. Se o template tem só uma versão, retorna ela sem
 * tocar em estado (comportamento idêntico ao de antes). A rotação é
 * best-effort: qualquer falha na leitura/gravação do estado cai na versão
 * principal, sem quebrar o envio.
 */
async function escolherTexto(
  templates: TemplatesMap, chave: string, destino: string,
): Promise<string | undefined> {
  const info = templates.get(chave);
  if (!info || info.versoes.length === 0) return undefined;
  if (info.versoes.length === 1) return info.versoes[0];

  const supabase = getSupabaseAdmin();
  const n = info.versoes.length;
  try {
    const { data } = await supabase.from("template_rotacao")
      .select("ultimo_indice")
      .eq("company_id", info.companyId).eq("destino", destino).eq("chave", chave)
      .maybeSingle();
    const ultimo = typeof data?.ultimo_indice === "number" ? data.ultimo_indice : -1;
    const proximo = ((ultimo % n) + n + 1) % n; // sempre != último, dentro de [0, n)
    await supabase.from("template_rotacao").upsert({
      company_id: info.companyId, destino, chave, ultimo_indice: proximo,
    }, { onConflict: "company_id,destino,chave" });
    return info.versoes[proximo] ?? info.versoes[0];
  } catch (e) {
    log({ funcao: FUNCAO, evento: "rotacao_template_falhou", status: "erro",
      erro_msg: e instanceof Error ? e.message : String(e) });
    return info.versoes[0];
  }
}

async function ultimaMsgInbound(atendimentoId: string): Promise<InboundMsg | null> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from("mensagens").select("id, content, created_at, media_metadata")
    .eq("atendimento_id", atendimentoId).eq("direction", "inbound")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  return data as InboundMsg | null;
}

/**
 * Retorna todas as inbounds posteriores à última processada (ou todas, se nenhuma
 * foi processada ainda), em ordem cronológica crescente. Permite que o bot
 * encontre uma resposta válida mesmo que o cliente tenha enviado mídia/texto extra
 * logo em seguida (caso contrário, a última inbound seria mídia sem content e a
 * resposta numérica seria silenciosamente descartada).
 */
async function inboundsDesdeUltimaProcessada(
  atendimentoId: string,
  lastProcessedId: string | null,
): Promise<InboundMsg[]> {
  const supabase = getSupabaseAdmin();
  let cutoff: string | null = null;
  if (lastProcessedId) {
    const { data: ref } = await supabase.from("mensagens")
      .select("created_at").eq("id", lastProcessedId).maybeSingle();
    cutoff = (ref as { created_at: string } | null)?.created_at ?? null;
  }
  let q = supabase.from("mensagens").select("id, content, created_at, media_metadata")
    .eq("atendimento_id", atendimentoId).eq("direction", "inbound");
  if (cutoff) q = q.gt("created_at", cutoff);
  const { data, error } = await q.order("created_at", { ascending: true }).limit(50);
  if (error) return [];
  return (data ?? []) as InboundMsg[];
}

async function marcarInboundProcessada(atendimentoId: string, msgId: string): Promise<void> {
  await getSupabaseAdmin().from("atendimentos")
    .update({ triagem_last_processed_msg_id: msgId }).eq("id", atendimentoId);
}

async function encerrarPorLoopSuspeito(at: Atendimento): Promise<void> {
  await getSupabaseAdmin().from("atendimentos").update({
    status: "encerrado", closed_at: new Date().toISOString(),
    close_reason: "manual_supervisor", triagem_estagio: "concluida",
  }).eq("id", at.id);
  log({ funcao: FUNCAO, evento: "triagem_loop_suspeito", status: "erro",
    atendimento_id: at.id, erro_msg: `tentativas >= ${LOOP_HARD_LIMIT}`,
    extra: { tentativas: at.triagem_tentativas } });
}

// O bot envia primeiro e grava depois. Desde que o webhook passou a receber o
// eco dos envios feitos pela API, existe uma corrida: se o eco chegar antes
// deste INSERT, a linha já existe (gravada como 'externo') e o UNIQUE de
// zapi_message_id estoura. Isso NÃO é falha de envio — a mensagem saiu. Então
// corrigimos a linha que o eco criou e seguimos o fluxo da triagem.
function ehConflitoDeEco(error: { code?: string; message?: string }): boolean {
  return error.code === "23505" ||
    /duplicate key|uniq_mensagens_zapi_message_id/i.test(error.message ?? "");
}

async function corrigirLinhaDoEco(
  at: Atendimento,
  zapiMsgId: string | null,
  campos: Record<string, unknown>,
): Promise<void> {
  if (!zapiMsgId) return;
  const supabase = getSupabaseAdmin();
  await supabase
    .from("mensagens")
    .update({ sender_type: "bot", sent_by_user_id: BOT_USER_ID, ...campos })
    .eq("zapi_message_id", zapiMsgId);
  log({
    funcao: FUNCAO,
    evento: "persistencia_eco_corrigida",
    status: "ok",
    atendimento_id: at.id,
    extra: { zapi_message_id: zapiMsgId },
  });
}

async function enviarEPersistir(at: Atendimento, telefone: string, texto: string): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  let zapiMsgId: string | null = null;
  try {
    const resp = await enviarTexto({ telefone: telefoneZapi(telefone), mensagem: texto }) as Record<string, unknown> | null;
    zapiMsgId = (resp?.messageId as string | undefined) ?? (resp?.id as string | undefined) ?? null;
  } catch (e) {
    const erro = e instanceof ZapiError ? `zapi_${e.status}` : String(e);
    log({ funcao: FUNCAO, evento: "envio_zapi_falhou", status: "erro", atendimento_id: at.id, erro_msg: erro });
    return false;
  }
  const { error } = await supabase.from("mensagens").insert({
    atendimento_id: at.id, client_id: at.client_id, department_id: null,
    direction: "outbound", sender_type: "bot", sent_by_user_id: BOT_USER_ID,
    tipo: "texto", content: texto, status_envio: "enviado", zapi_message_id: zapiMsgId,
  });
  if (error) {
    if (ehConflitoDeEco(error)) {
      await corrigirLinhaDoEco(at, zapiMsgId, { content: texto });
      return true;
    }
    log({ funcao: FUNCAO, evento: "persistencia_falhou", status: "erro", atendimento_id: at.id, erro_msg: error.message });
    return false;
  }
  return true;
}

// Limite do WhatsApp para mensagens interativas tipo "List".
const LIST_MAX_OPCOES = 10;
const LIST_TITULO = "Atendimento Almore";

/**
 * Limpa do template os placeholders de "lista numerada" — quando a mensagem
 * vai como List interativo, o WhatsApp já renderiza as opções como botão
 * "Ver opções", então a numeração textual fica redundante.
 */
function corpoSemListaNumerada(texto: string, vars: Record<string, string>): string {
  const limpo = texto.replace(/\{\{\s*(?:lista_departamentos|lista_colaboradores)\s*\}\}/g, "");
  return aplicarTemplate(limpo, vars).replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Envia mensagem como List interativo (botão "Ver opções") e persiste a
 * outbound em `mensagens` como tipo='texto'. Faz fallback para texto plano
 * se a lista tiver menos de 2 ou mais de 10 opções (limite do WhatsApp).
 *
 * Retorna `true` se enviou (via list ou fallback), `false` em erro de envio.
 */
async function enviarListaEPersistir(
  at: Atendimento,
  telefone: string,
  corpo: string,
  textoFallback: string,
  buttonLabel: string,
  opcoes: OpcaoLista[],
): Promise<boolean> {
  // Fallback: poucas/muitas opções → manda texto plano antigo.
  if (opcoes.length < 2 || opcoes.length > LIST_MAX_OPCOES) {
    return await enviarEPersistir(at, telefone, textoFallback);
  }

  const supabase = getSupabaseAdmin();
  let zapiMsgId: string | null = null;
  try {
    const resp = await enviarListaOpcoes({
      telefone: telefoneZapi(telefone),
      mensagem: corpo,
      tituloLista: LIST_TITULO,
      buttonLabel,
      opcoes,
    }) as Record<string, unknown> | null;
    zapiMsgId = (resp?.messageId as string | undefined) ?? (resp?.id as string | undefined) ?? null;
  } catch (e) {
    const erro = e instanceof ZapiError ? `zapi_${e.status}` : String(e);
    log({
      funcao: FUNCAO,
      evento: "envio_lista_falhou",
      status: "erro",
      atendimento_id: at.id,
      erro_msg: erro,
    });
    // Fallback resiliente: se a Z-API rejeitar a lista, ainda mandamos o texto.
    return await enviarEPersistir(at, telefone, textoFallback);
  }

  const metaLista = {
    kind: "lista_opcoes",
    titulo: LIST_TITULO,
    button_label: buttonLabel,
    opcoes: opcoes.map((o) => ({
      id: o.id,
      title: o.title,
      ...(o.description ? { description: o.description } : {}),
    })),
  };

  // Persiste como tipo='texto' com o corpo (sem a lista numerada). A inbox
  // continua exibindo a pergunta normalmente; as opções ficam só no WhatsApp.
  const { error } = await supabase.from("mensagens").insert({
    atendimento_id: at.id,
    client_id: at.client_id,
    department_id: null,
    direction: "outbound",
    sender_type: "bot",
    sent_by_user_id: BOT_USER_ID,
    tipo: "texto",
    content: corpo,
    status_envio: "enviado",
    zapi_message_id: zapiMsgId,
    media_metadata: metaLista,
  });
  if (error) {
    if (ehConflitoDeEco(error)) {
      await corrigirLinhaDoEco(at, zapiMsgId, { content: corpo, media_metadata: metaLista });
      return true;
    }
    log({
      funcao: FUNCAO,
      evento: "persistencia_lista_falhou",
      status: "erro",
      atendimento_id: at.id,
      erro_msg: error.message,
    });
    return false;
  }
  return true;
}

function opcoesDeDepartamentos(deps: Departamento[]): OpcaoLista[] {
  return deps.map((d) => ({ id: `dep_${d.id}`, title: d.nome }));
}

function opcoesDeColaboradores(cols: Colaborador[]): OpcaoLista[] {
  return cols.map((c) => ({ id: `col_${c.id}`, title: c.nome }));
}

async function getTelefone(clientId: string): Promise<string | null> {
  const { data } = await getSupabaseAdmin().from("clients")
    .select("numero_whatsapp").eq("id", clientId).maybeSingle();
  return (data as { numero_whatsapp: string } | null)?.numero_whatsapp ?? null;
}

/** Envia a confirmação de encaminhamento ao departamento (template editável). */
async function enviarConfirmacao(
  at: Atendimento, telefone: string, templates: TemplatesMap, deptNome: string,
): Promise<void> {
  const tpl = await escolherTexto(templates, "triagem_confirmacao", telefone);
  if (!tpl) return; // Confirmação é opcional; ausência não bloqueia a finalização.
  const texto = aplicarTemplate(tpl, { departamento: deptNome });
  await enviarEPersistir(at, telefone, texto);
}

// =============== Continuidade RN-05.6 ===============
// Retorna true se aplicou continuidade (caller deve sair).
async function aplicarContinuidadeSeAplicavel(at: Atendimento, inbound: InboundMsg): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const { data: rpcData, error: rpcErr } = await supabase
    .rpc("dentro_da_janela_continuidade", { p_client_id: at.client_id });
  if (rpcErr) {
    log({ funcao: FUNCAO, evento: "continuidade_rpc_erro", status: "erro", atendimento_id: at.id, erro_msg: rpcErr.message });
    return false;
  }
  const userId = rpcData as string | null;
  if (!userId) return false;

  // Buscar o atendimento encerrado mais recente do mesmo cliente atendido por esse user.
  const { data: prev } = await supabase.from("atendimentos")
    .select("current_department_id")
    .eq("client_id", at.client_id).eq("assigned_to", userId).eq("status", "encerrado")
    .order("closed_at", { ascending: false }).limit(1).maybeSingle();

  const deptId = (prev as { current_department_id: string | null } | null)?.current_department_id ?? null;
  if (!deptId) {
    // Sem dept herdável → não aplica continuidade.
    return false;
  }

  const nowIso = new Date().toISOString();
  await supabase.from("atendimentos").update({
    status: "reservado",
    assigned_to: userId,
    current_department_id: deptId,
    triagem_estagio: "concluida",
    assigned_at: nowIso,
    triagem_finished_at: nowIso,
    triagem_last_processed_msg_id: inbound.id,
  }).eq("id", at.id);

  // Carimba mensagens da triagem (department_id NULL).
  await supabase.from("mensagens").update({ department_id: deptId })
    .eq("atendimento_id", at.id).is("department_id", null);

  log({ funcao: FUNCAO, evento: "continuidade_aplicada", status: "ok",
    atendimento_id: at.id, extra: { assigned_to: userId, dept_id: deptId } });
  return true;
}

// =============== Encaminhamento geral (sem departamento) ===============
// Caso de borda: nenhum departamento cadastrado. Não deixamos a conversa sumir —
// mantemos em em_triagem (dept NULL é permitido pelo CHECK só nesse status) com a
// triagem concluída, então ela aparece em Pendentes para um humano assumir.
async function encaminharPendentesGeral(
  at: Atendimento, telefone: string, templates: TemplatesMap, inboundId: string,
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const boas = await escolherTexto(templates, "triagem_boas_vindas", telefone);
  if (boas) await enviarEPersistir(at, telefone, boas);
  await enviarConfirmacao(at, telefone, templates, "nosso atendimento");

  await supabase.from("atendimentos").update({
    triagem_estagio: "concluida",
    triagem_finished_at: new Date().toISOString(),
    triagem_last_processed_msg_id: inboundId,
  }).eq("id", at.id);

  log({ funcao: FUNCAO, evento: "triagem_pendentes_geral", status: "ok",
    atendimento_id: at.id, extra: { motivo: "sem_departamentos" } });
}

// =============== Estágio: aguardando_inicio ===============
async function processarAguardandoInicio(
  at: Atendimento, inbound: InboundMsg,
  templates: TemplatesMap, deps: Departamento[],
): Promise<void> {
  const cron = iniciarCronometro();
  const supabase = getSupabaseAdmin();

  // Fluxo interno (Lista de Sessões): saudação personalizada + escolha de setor.
  if (at.is_sessao) return await processarSessaoInicio(at, inbound, templates, deps);

  // RN-05.6 — continuidade do mesmo dia útil.
  if (await aplicarContinuidadeSeAplicavel(at, inbound)) return;

  const telefone = await getTelefone(at.client_id);
  if (!telefone) return;

  // Borda: nenhum departamento cadastrado → Pendentes geral.
  if (deps.length === 0) {
    await encaminharPendentesGeral(at, telefone, templates, inbound.id);
    return;
  }

  const boas = await escolherTexto(templates, "triagem_boas_vindas", telefone);
  if (!boas) {
    log({ funcao: FUNCAO, evento: "template_ausente", status: "erro",
      atendimento_id: at.id, erro_msg: "triagem_boas_vindas" });
    return;
  }
  if (!(await enviarEPersistir(at, telefone, boas))) return;

  // Borda: um único departamento → pula o menu e roteia direto.
  if (deps.length === 1) {
    const only = deps[0];
    await enviarConfirmacao(at, telefone, templates, only.nome);
    await finalizarTriagem(at, only.id, inbound.id);
    log({ funcao: FUNCAO, evento: "departamento_unico_auto", status: "ok",
      atendimento_id: at.id, duracao_ms: cron(), extra: { dept_id: only.id } });
    return;
  }

  const pergunta = await escolherTexto(templates, "triagem_pergunta_departamento", telefone);
  if (!pergunta) {
    log({ funcao: FUNCAO, evento: "template_ausente", status: "erro",
      atendimento_id: at.id, erro_msg: "triagem_pergunta_departamento" });
    return;
  }
  {
    const vars = { lista_departamentos: formatarLista(deps) };
    const corpo = corpoSemListaNumerada(pergunta, vars);
    const fallback = aplicarTemplate(pergunta, vars);
    if (!(await enviarListaEPersistir(at, telefone, corpo, fallback, "Ver setores", opcoesDeDepartamentos(deps)))) return;
  }

  await supabase.from("atendimentos").update({
    triagem_estagio: "aguardando_departamento",
    triagem_tentativas: 0,
    triagem_last_processed_msg_id: inbound.id,
  }).eq("id", at.id);

  log({ funcao: FUNCAO, evento: "boas_vindas_enviadas", status: "ok",
    atendimento_id: at.id, duracao_ms: cron() });
}

// =============== Estágio: aguardando_departamento ===============
async function processarAguardandoDepartamento(
  at: Atendimento, inbound: InboundMsg,
  templates: TemplatesMap, deps: Departamento[],
  cfg: Config,
): Promise<void> {
  // Fluxo interno (Lista de Sessões): depois do departamento vem a escolha do
  // colaborador, então tem terminal e templates próprios.
  if (at.is_sessao) return await processarSessaoDepartamento(at, inbound, templates, deps, cfg);

  const cron = iniciarCronometro();
  const supabase = getSupabaseAdmin();

  // Coleta todas as inbounds desde a última processada (inclui a `inbound` passada).
  const novas = await inboundsDesdeUltimaProcessada(at.id, at.triagem_last_processed_msg_id);
  const lote = novas.length > 0 ? novas : [inbound];
  const ultimoIdLote = lote[lote.length - 1].id;

  const { itemId: deptId, msgResolvidaId, resolvidoPorClique, textosVistos } =
    resolverItemDoLote(lote, deps, "dep_");

  if (deptId) {
    const nome = await nomeDept(deptId);
    // A resposta de lista chega com content vazio; grava o nome do departamento
    // escolhido para a inbox exibir a opção em vez de uma mensagem vazia.
    if (resolvidoPorClique && msgResolvidaId) {
      await supabase.from("mensagens").update({ content: nome }).eq("id", msgResolvidaId);
    }
    const telefone = await getTelefone(at.client_id);
    if (telefone) await enviarConfirmacao(at, telefone, templates, nome);
    await finalizarTriagem(at, deptId, ultimoIdLote);
    log({ funcao: FUNCAO, evento: "departamento_identificado", status: "ok",
      atendimento_id: at.id, duracao_ms: cron(), extra: { dept_id: deptId, via: resolvidoPorClique ? "clique" : "texto" } });
    return;
  }

  // Sem texto nem clique no lote → não consome tentativa, só marca como processado.
  if (textosVistos === 0) {
    await marcarInboundProcessada(at.id, ultimoIdLote);
    log({ funcao: FUNCAO, evento: "departamento_apenas_midia", status: "ok",
      atendimento_id: at.id, duracao_ms: cron() });
    return;
  }

  const novasTent = at.triagem_tentativas + 1;
  const telefone = await getTelefone(at.client_id);

  // Esgotou as tentativas → encaminha para Pendentes geral (não some, humano assume).
  if (novasTent >= cfg.maxTentativas) {
    if (telefone) await encaminharPendentesGeral(at, telefone, templates, ultimoIdLote);
    else await marcarInboundProcessada(at.id, ultimoIdLote);
    log({ funcao: FUNCAO, evento: "departamento_max_tentativas", status: "ok",
      atendimento_id: at.id, duracao_ms: cron(), extra: { tentativas: novasTent } });
    return;
  }

  if (!telefone) { await marcarInboundProcessada(at.id, ultimoIdLote); return; }

  const erro = await escolherTexto(templates, "triagem_erro_formato", telefone);
  const pergunta = await escolherTexto(templates, "triagem_pergunta_departamento", telefone);
  if (!erro || !pergunta) { await marcarInboundProcessada(at.id, ultimoIdLote); return; }

  await enviarEPersistir(at, telefone, erro);
  {
    const vars = { lista_departamentos: formatarLista(deps) };
    const corpo = corpoSemListaNumerada(pergunta, vars);
    const fallback = aplicarTemplate(pergunta, vars);
    await enviarListaEPersistir(at, telefone, corpo, fallback, "Ver setores", opcoesDeDepartamentos(deps));
  }

  await supabase.from("atendimentos").update({
    triagem_tentativas: novasTent, triagem_last_processed_msg_id: ultimoIdLote,
  }).eq("id", at.id);

  log({ funcao: FUNCAO, evento: "departamento_nao_identificado", status: "ok",
    atendimento_id: at.id, duracao_ms: cron(), extra: { tentativas: novasTent } });
}

// =============== Finalização da triagem (RN-06) ===============
// Roteia o atendimento já com o departamento definido: último atendente do
// departamento (continuidade) → senão Pendentes daquele departamento.
async function finalizarTriagem(
  at: Atendimento, deptId: string, inboundId: string,
): Promise<void> {
  const supabase = getSupabaseAdmin();

  // 1) Carimba mensagens da triagem.
  await supabase.from("mensagens").update({ department_id: deptId })
    .eq("atendimento_id", at.id).is("department_id", null);

  // 2) Roteamento — RN-06.2: último atendente do cliente naquele departamento.
  let assignedTo: string | null = null;
  let routing: "ultimo_atendente" | "pendente" = "pendente";
  {
    const { data: rpcData, error: rpcErr } = await supabase
      .rpc("ultimo_atendente_no_departamento", { p_client_id: at.client_id, p_department_id: deptId });
    if (!rpcErr && rpcData) {
      assignedTo = rpcData as string;
      routing = "ultimo_atendente";
    }
  }

  // 3) Atualiza atendimento.
  const nowIso = new Date().toISOString();
  const update: Record<string, unknown> = {
    current_department_id: deptId,
    triagem_estagio: "concluida",
    triagem_finished_at: nowIso,
    triagem_last_processed_msg_id: inboundId,
  };
  if (assignedTo) {
    update.status = "reservado";
    update.assigned_to = assignedTo;
    update.assigned_at = nowIso;
  } else {
    update.status = "pendente";
    update.assigned_to = null;
  }
  await supabase.from("atendimentos").update(update).eq("id", at.id);

  log({ funcao: FUNCAO, evento: "triagem_concluida", status: "ok",
    atendimento_id: at.id,
    extra: { routing_decision: routing, assigned_to: assignedTo, dept_id: deptId } });
}

// =====================================================================
// Fluxo da Lista de Sessões (VIPs internos): saudação personalizada →
// escolha do departamento → escolha do COLABORADOR → reserva direta.
// Reaproveita todo o maquinário de menu/lote da triagem de cliente; muda
// só os templates e o terminal (reserva para a pessoa escolhida).
// =====================================================================

// Envia o menu de colaboradores do departamento e move para
// 'aguardando_colaborador'. Bordas: 0 colaboradores → cai em Pendentes do
// próprio departamento (fluxo cliente); 1 colaborador → reserva direto.
async function enviarMenuColaboradores(
  at: Atendimento, telefone: string, deptId: string,
  templates: TemplatesMap, inboundId: string,
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const cols = await carregarColaboradores(deptId);
  const deptNomeStr = await nomeDept(deptId);

  if (cols.length === 0) {
    // Ninguém disponível no setor → não some: vira Pendente daquele departamento.
    await finalizarTriagem(at, deptId, inboundId);
    log({ funcao: FUNCAO, evento: "sessao_dept_sem_colaboradores", status: "ok",
      atendimento_id: at.id, extra: { dept_id: deptId } });
    return;
  }
  if (cols.length === 1) {
    await finalizarSessao(at, deptId, cols[0], telefone, templates, inboundId);
    return;
  }

  const pergunta = await escolherTexto(templates, "sessao_pergunta_colaborador", telefone);
  if (!pergunta) {
    // Sem template não dá para perguntar → cai em Pendente do departamento.
    await finalizarTriagem(at, deptId, inboundId);
    log({ funcao: FUNCAO, evento: "template_ausente", status: "erro",
      atendimento_id: at.id, erro_msg: "sessao_pergunta_colaborador" });
    return;
  }
  const vars = { departamento: deptNomeStr, lista_colaboradores: formatarLista(cols) };
  const corpo = corpoSemListaNumerada(pergunta, vars);
  const fallback = aplicarTemplate(pergunta, vars);
  if (!(await enviarListaEPersistir(at, telefone, corpo, fallback, "Ver pessoas", opcoesDeColaboradores(cols)))) return;

  await supabase.from("atendimentos").update({
    current_department_id: deptId,
    triagem_estagio: "aguardando_colaborador",
    triagem_tentativas: 0,
    triagem_last_processed_msg_id: inboundId,
  }).eq("id", at.id);

  log({ funcao: FUNCAO, evento: "sessao_menu_colaboradores", status: "ok",
    atendimento_id: at.id, extra: { dept_id: deptId, colaboradores: cols.length } });
}

// Reserva o atendimento direto para o colaborador escolhido.
async function finalizarSessao(
  at: Atendimento, deptId: string, col: Colaborador,
  telefone: string, templates: TemplatesMap, inboundId: string,
): Promise<void> {
  const supabase = getSupabaseAdmin();

  // Carimba as mensagens da triagem com o departamento.
  await supabase.from("mensagens").update({ department_id: deptId })
    .eq("atendimento_id", at.id).is("department_id", null);

  const nowIso = new Date().toISOString();
  await supabase.from("atendimentos").update({
    current_department_id: deptId,
    assigned_to: col.id,
    status: "reservado",
    assigned_at: nowIso,
    triagem_estagio: "concluida",
    triagem_finished_at: nowIso,
    triagem_last_processed_msg_id: inboundId,
  }).eq("id", at.id);

  const tpl = await escolherTexto(templates, "sessao_confirmacao", telefone);
  if (tpl) await enviarEPersistir(at, telefone, aplicarTemplate(tpl, { colaborador: col.nome }));

  log({ funcao: FUNCAO, evento: "sessao_concluida", status: "ok",
    atendimento_id: at.id, extra: { dept_id: deptId, assigned_to: col.id } });
}

// =============== Sessão · Estágio: aguardando_inicio ===============
async function processarSessaoInicio(
  at: Atendimento, inbound: InboundMsg,
  templates: TemplatesMap, deps: Departamento[],
): Promise<void> {
  const cron = iniciarCronometro();
  const supabase = getSupabaseAdmin();

  const telefone = await getTelefone(at.client_id);
  if (!telefone) return;

  // Saudação personalizada com o nome cadastrado na Lista de Sessões.
  const nome = await nomeSessao(at.client_id);
  const boasTpl = await escolherTexto(templates, "sessao_boas_vindas", telefone);
  const saudacao = boasTpl
    ? (nome ? aplicarTemplate(boasTpl, { nome: primeiroNome(nome) }) : "Olá! 👋")
    : null;
  if (saudacao && !(await enviarEPersistir(at, telefone, saudacao))) return;

  // Borda: nenhum departamento → Pendentes geral (não some).
  if (deps.length === 0) {
    await encaminharPendentesGeral(at, telefone, templates, inbound.id);
    return;
  }
  // Borda: um único departamento → pula o menu de setor e já pergunta a pessoa.
  if (deps.length === 1) {
    await enviarMenuColaboradores(at, telefone, deps[0].id, templates, inbound.id);
    log({ funcao: FUNCAO, evento: "sessao_dept_unico_auto", status: "ok",
      atendimento_id: at.id, duracao_ms: cron(), extra: { dept_id: deps[0].id } });
    return;
  }

  const pergunta = await escolherTexto(templates, "sessao_pergunta_departamento", telefone);
  if (!pergunta) {
    log({ funcao: FUNCAO, evento: "template_ausente", status: "erro",
      atendimento_id: at.id, erro_msg: "sessao_pergunta_departamento" });
    return;
  }
  {
    const vars = { lista_departamentos: formatarLista(deps) };
    const corpo = corpoSemListaNumerada(pergunta, vars);
    const fallback = aplicarTemplate(pergunta, vars);
    if (!(await enviarListaEPersistir(at, telefone, corpo, fallback, "Ver setores", opcoesDeDepartamentos(deps)))) return;
  }

  await supabase.from("atendimentos").update({
    triagem_estagio: "aguardando_departamento",
    triagem_tentativas: 0,
    triagem_last_processed_msg_id: inbound.id,
  }).eq("id", at.id);

  log({ funcao: FUNCAO, evento: "sessao_boas_vindas_enviadas", status: "ok",
    atendimento_id: at.id, duracao_ms: cron() });
}

// =============== Sessão · Estágio: aguardando_departamento ===============
// Igual ao passo do cliente na resolução, mas o terminal é o menu de
// colaboradores (não a finalização direta).
async function processarSessaoDepartamento(
  at: Atendimento, inbound: InboundMsg,
  templates: TemplatesMap, deps: Departamento[], cfg: Config,
): Promise<void> {
  const cron = iniciarCronometro();
  const supabase = getSupabaseAdmin();

  const novas = await inboundsDesdeUltimaProcessada(at.id, at.triagem_last_processed_msg_id);
  const lote = novas.length > 0 ? novas : [inbound];
  const ultimoIdLote = lote[lote.length - 1].id;

  const { itemId: deptId, msgResolvidaId, resolvidoPorClique, textosVistos } =
    resolverItemDoLote(lote, deps, "dep_");

  if (deptId) {
    const nome = await nomeDept(deptId);
    if (resolvidoPorClique && msgResolvidaId) {
      await supabase.from("mensagens").update({ content: nome }).eq("id", msgResolvidaId);
    }
    const telefone = await getTelefone(at.client_id);
    if (!telefone) { await marcarInboundProcessada(at.id, ultimoIdLote); return; }
    await enviarMenuColaboradores(at, telefone, deptId, templates, ultimoIdLote);
    log({ funcao: FUNCAO, evento: "sessao_departamento_identificado", status: "ok",
      atendimento_id: at.id, duracao_ms: cron(), extra: { dept_id: deptId, via: resolvidoPorClique ? "clique" : "texto" } });
    return;
  }

  if (textosVistos === 0) {
    await marcarInboundProcessada(at.id, ultimoIdLote);
    return;
  }

  const novasTent = at.triagem_tentativas + 1;
  const telefone = await getTelefone(at.client_id);

  // Esgotou tentativas → Pendentes geral (humano assume), não some.
  if (novasTent >= cfg.maxTentativas) {
    if (telefone) await encaminharPendentesGeral(at, telefone, templates, ultimoIdLote);
    else await marcarInboundProcessada(at.id, ultimoIdLote);
    return;
  }

  if (!telefone) { await marcarInboundProcessada(at.id, ultimoIdLote); return; }

  const erro = await escolherTexto(templates, "triagem_erro_formato", telefone);
  const pergunta = await escolherTexto(templates, "sessao_pergunta_departamento", telefone);
  if (!erro || !pergunta) { await marcarInboundProcessada(at.id, ultimoIdLote); return; }

  await enviarEPersistir(at, telefone, erro);
  {
    const vars = { lista_departamentos: formatarLista(deps) };
    const corpo = corpoSemListaNumerada(pergunta, vars);
    const fallback = aplicarTemplate(pergunta, vars);
    await enviarListaEPersistir(at, telefone, corpo, fallback, "Ver setores", opcoesDeDepartamentos(deps));
  }

  await supabase.from("atendimentos").update({
    triagem_tentativas: novasTent, triagem_last_processed_msg_id: ultimoIdLote,
  }).eq("id", at.id);

  log({ funcao: FUNCAO, evento: "sessao_departamento_nao_identificado", status: "ok",
    atendimento_id: at.id, duracao_ms: cron(), extra: { tentativas: novasTent } });
}

// =============== Sessão · Estágio: aguardando_colaborador ===============
async function processarAguardandoColaborador(
  at: Atendimento, inbound: InboundMsg,
  templates: TemplatesMap, cfg: Config,
): Promise<void> {
  const cron = iniciarCronometro();
  const supabase = getSupabaseAdmin();

  const deptId = at.current_department_id;
  if (!deptId) {
    // Estado inconsistente (colaborador sem departamento) → volta ao início.
    await supabase.from("atendimentos").update({ triagem_estagio: "aguardando_inicio" }).eq("id", at.id);
    return;
  }
  const cols = await carregarColaboradores(deptId);
  if (cols.length === 0) {
    // O setor esvaziou desde o menu → cai em Pendente do departamento.
    await finalizarTriagem(at, deptId, inbound.id);
    return;
  }

  const novas = await inboundsDesdeUltimaProcessada(at.id, at.triagem_last_processed_msg_id);
  const lote = novas.length > 0 ? novas : [inbound];
  const ultimoIdLote = lote[lote.length - 1].id;

  const { itemId: colId, msgResolvidaId, resolvidoPorClique, textosVistos } =
    resolverItemDoLote(lote, cols, "col_");

  if (colId) {
    const col = cols.find((c) => c.id === colId)!;
    if (resolvidoPorClique && msgResolvidaId) {
      await supabase.from("mensagens").update({ content: col.nome }).eq("id", msgResolvidaId);
    }
    const telefone = await getTelefone(at.client_id);
    if (!telefone) { await marcarInboundProcessada(at.id, ultimoIdLote); return; }
    await finalizarSessao(at, deptId, col, telefone, templates, ultimoIdLote);
    log({ funcao: FUNCAO, evento: "sessao_colaborador_identificado", status: "ok",
      atendimento_id: at.id, duracao_ms: cron(), extra: { assigned_to: colId, via: resolvidoPorClique ? "clique" : "texto" } });
    return;
  }

  if (textosVistos === 0) {
    await marcarInboundProcessada(at.id, ultimoIdLote);
    return;
  }

  const novasTent = at.triagem_tentativas + 1;
  const telefone = await getTelefone(at.client_id);

  // Esgotou tentativas → cai em Pendente do departamento (não some).
  if (novasTent >= cfg.maxTentativas) {
    if (telefone) await finalizarTriagem(at, deptId, ultimoIdLote);
    else await marcarInboundProcessada(at.id, ultimoIdLote);
    return;
  }

  if (!telefone) { await marcarInboundProcessada(at.id, ultimoIdLote); return; }

  const erro = await escolherTexto(templates, "triagem_erro_formato", telefone);
  const pergunta = await escolherTexto(templates, "sessao_pergunta_colaborador", telefone);
  if (!erro || !pergunta) { await marcarInboundProcessada(at.id, ultimoIdLote); return; }

  await enviarEPersistir(at, telefone, erro);
  {
    const vars = { departamento: await nomeDept(deptId), lista_colaboradores: formatarLista(cols) };
    const corpo = corpoSemListaNumerada(pergunta, vars);
    const fallback = aplicarTemplate(pergunta, vars);
    await enviarListaEPersistir(at, telefone, corpo, fallback, "Ver pessoas", opcoesDeColaboradores(cols));
  }

  await supabase.from("atendimentos").update({
    triagem_tentativas: novasTent, triagem_last_processed_msg_id: ultimoIdLote,
  }).eq("id", at.id);

  log({ funcao: FUNCAO, evento: "sessao_colaborador_nao_identificado", status: "ok",
    atendimento_id: at.id, duracao_ms: cron(), extra: { tentativas: novasTent } });
}

// =============== Abandono ===============
async function varrerAbandono(cfg: Config): Promise<number> {
  const supabase = getSupabaseAdmin();
  // Kill-switch: por padrão DESLIGADO. Só executa se system_config.triagem_abandono_ativo = 'true'.
  // Decisão arquitetural (13/05/2026): encerramento automático em em_triagem é destrutivo
  // (sem mensagem ao cliente, sem timeline). Mantemos atendimentos em em_triagem indefinidamente
  // até intervenção humana.
  {
    const { data: cfgRow } = await supabase.from("system_config")
      .select("valor").eq("chave", "triagem_abandono_ativo").maybeSingle();
    const ativo = (cfgRow?.valor ?? "false") === "true";
    if (!ativo) {
      log({ funcao: FUNCAO, evento: "varrerAbandono_desligado", status: "ok" });
      return 0;
    }
  }
  const limiteIso = new Date(Date.now() - cfg.abandonoMin * 60_000).toISOString();
  const { data, error } = await supabase.from("atendimentos")
    .select("id, last_message_at, created_at")
    .eq("status", "em_triagem")
    .lt("last_message_at", limiteIso)
    .limit(100);
  if (error) {
    log({ funcao: FUNCAO, evento: "abandono_query_erro", status: "erro", erro_msg: error.message });
    return 0;
  }
  const lista = (data ?? []) as Array<{ id: string; last_message_at: string }>;
  let n = 0;
  for (const a of lista) {
    const silencioMin = Math.round((Date.now() - new Date(a.last_message_at).getTime()) / 60_000);
    await supabase.from("atendimentos").update({
      status: "encerrado", closed_at: new Date().toISOString(),
      close_reason: "automatico_inatividade", triagem_estagio: "concluida",
    }).eq("id", a.id);
    log({ funcao: FUNCAO, evento: "triagem_abandonada", status: "ok",
      atendimento_id: a.id, extra: { tempo_silencio_min: silencioMin } });
    n++;
  }
  return n;
}

// =============== Lembrete de triagem sem resposta ===============
async function varrerLembretes(cfg: Config): Promise<number> {
  if (!cfg.lembreteAtivo) return 0;
  const supabase = getSupabaseAdmin();

  // Só dispara em horário comercial.
  const { data: horCom } = await supabase
    .rpc("esta_em_horario_comercial", { ts: new Date().toISOString() });
  if (horCom !== true) return 0;

  const LEMBRETE_IDADE_MAX_HORAS = 12;
  const agora = Date.now();
  const limiteIso = new Date(agora - cfg.lembreteMin * 60_000).toISOString();
  // Janela máxima de idade: não enviar lembrete para silêncios muito antigos
  // (ex.: mensagem de ontem). O "reiniciar ao virar o dia" cobre esse caso.
  const idadeMaxIso = new Date(agora - LEMBRETE_IDADE_MAX_HORAS * 3600_000).toISOString();
  const { data, error } = await supabase.from("atendimentos")
    .select("id, client_id, last_message_at, current_department_id")
    .eq("status", "em_triagem")
    .eq("triagem_estagio", "aguardando_departamento")
    .is("triagem_lembrete_enviado_at", null)
    .lt("last_message_at", limiteIso)
    .gt("last_message_at", idadeMaxIso)
    .limit(50);
  if (error) {
    log({ funcao: FUNCAO, evento: "lembrete_query_erro", status: "erro", erro_msg: error.message });
    return 0;
  }
  const lista = (data ?? []) as Array<{
    id: string; client_id: string; last_message_at: string; current_department_id: string | null;
  }>;
  if (lista.length === 0) return 0;

  const templates = await carregarTemplates(["triagem_lembrete_sem_resposta"]);
  if (!templates.has("triagem_lembrete_sem_resposta")) {
    log({ funcao: FUNCAO, evento: "lembrete_template_ausente", status: "erro" });
    return 0;
  }

  let n = 0;
  for (const a of lista) {
    // Guard: se já existe qualquer resposta humana (atendente pelo sistema OU
    // mensagem fromMe externa registrada via webhook), não enviar lembrete.
    // Cobre o caso "atendido por fora do sistema".
    const { count: respostasHumanas } = await supabase.from("mensagens")
      .select("id", { count: "exact", head: true })
      .eq("atendimento_id", a.id)
      .eq("direction", "outbound")
      .in("sender_type", ["atendente", "externo"]);
    if ((respostasHumanas ?? 0) > 0) {
      log({ funcao: FUNCAO, evento: "lembrete_pulado_ja_respondido", status: "ok",
        atendimento_id: a.id });
      continue;
    }

    const telefone = await getTelefone(a.client_id);
    if (!telefone) continue;
    const tpl = await escolherTexto(templates, "triagem_lembrete_sem_resposta", telefone);
    if (!tpl) continue;
    const fakeAt: Atendimento = {
      id: a.id, client_id: a.client_id,
      triagem_estagio: "aguardando_departamento",
      triagem_tentativas: 0,
      current_department_id: a.current_department_id,
      triagem_last_processed_msg_id: null,
      is_sessao: false,
    };
    const ok = await enviarEPersistir(fakeAt, telefone, tpl);
    if (!ok) continue;
    await supabase.from("atendimentos")
      .update({ triagem_lembrete_enviado_at: new Date().toISOString() })
      .eq("id", a.id);
    log({ funcao: FUNCAO, evento: "lembrete_enviado", status: "ok",
      atendimento_id: a.id,
      extra: { silencio_min: Math.round((Date.now() - new Date(a.last_message_at).getTime()) / 60_000) } });
    n++;
  }
  return n;
}

// =============== Loop principal ===============
async function executar(): Promise<{ processados: number; pulados_anti_flood: number; pulados_idempotencia: number; abandonados: number; lembretes: number }> {
  const supabase = getSupabaseAdmin();

  if (!(await botEstaAtivo())) {
    log({ funcao: FUNCAO, evento: "triagem_pulada_kill_switch", status: "ok" });
    return { processados: 0, pulados_anti_flood: 0, pulados_idempotencia: 0, abandonados: 0, lembretes: 0 };
  }

  const cfg = await carregarConfig();
  const botAtivadoEm = await getBotAtivadoEm();
  const abandonados = await varrerAbandono(cfg);
  const lembretes = await varrerLembretes(cfg);

  const limiteIso = new Date(Date.now() - cfg.delaySeg * 1000).toISOString();

  const { data: atendimentos, error } = await supabase.from("atendimentos")
    .select("id, client_id, triagem_estagio, triagem_tentativas, current_department_id, triagem_last_processed_msg_id, is_sessao")
    .eq("status", "em_triagem")
    .in("triagem_estagio", ["aguardando_inicio", "aguardando_departamento", "aguardando_colaborador"])
    .order("created_at", { ascending: true }).limit(50);

  if (error) {
    log({ funcao: FUNCAO, evento: "query_atendimentos_falhou", status: "erro", erro_msg: error.message });
    return { processados: 0, pulados_anti_flood: 0, pulados_idempotencia: 0, abandonados, lembretes };
  }
  const lista = (atendimentos ?? []) as Atendimento[];
  if (lista.length === 0) return { processados: 0, pulados_anti_flood: 0, pulados_idempotencia: 0, abandonados, lembretes };

  const deps = await carregarDepartamentos();
  const templates = await carregarTemplates([
    "triagem_boas_vindas", "triagem_pergunta_departamento",
    "triagem_confirmacao", "triagem_erro_formato",
    "sessao_boas_vindas", "sessao_pergunta_departamento",
    "sessao_pergunta_colaborador", "sessao_confirmacao",
  ]);

  let processados = 0, pulados_anti_flood = 0, pulados_idempotencia = 0;

  for (const at of lista) {
    try {
      if (at.triagem_tentativas >= LOOP_HARD_LIMIT) { await encerrarPorLoopSuspeito(at); continue; }

      const inbound = await ultimaMsgInbound(at.id);
      if (!inbound) continue;

      // Regra anti-disparo-em-massa pós-religação: ignora inbound que chegou
      // ANTES da última transição off→on do bot. Atendimento permanece em
      // em_triagem para tratamento humano; sweep de abandono encerra depois.
      if (botAtivadoEm && inbound.created_at < botAtivadoEm) {
        await marcarInboundProcessada(at.id, inbound.id);
        log({
          funcao: FUNCAO,
          evento: "triagem_pulada_pre_reativacao",
          status: "ok",
          atendimento_id: at.id,
          extra: { inbound_em: inbound.created_at, bot_ativado_em: botAtivadoEm },
        });
        continue;
      }
      if (at.triagem_last_processed_msg_id === inbound.id) {
        pulados_idempotencia++;
        log({ funcao: FUNCAO, evento: "triagem_inbound_ja_processada", status: "ok", atendimento_id: at.id });
        continue;
      }

      if (inbound.created_at > limiteIso) {
        pulados_anti_flood++;
        log({ funcao: FUNCAO, evento: "triagem_anti_flood", status: "ok", atendimento_id: at.id });
        continue;
      }

      if (at.triagem_estagio === "aguardando_inicio") {
        await processarAguardandoInicio(at, inbound, templates, deps);
      } else if (at.triagem_estagio === "aguardando_departamento") {
        await processarAguardandoDepartamento(at, inbound, templates, deps, cfg);
      } else if (at.triagem_estagio === "aguardando_colaborador") {
        await processarAguardandoColaborador(at, inbound, templates, cfg);
      }
      processados++;
    } catch (e) {
      log({ funcao: FUNCAO, evento: "atendimento_erro", status: "erro",
        atendimento_id: at.id, erro_msg: e instanceof Error ? e.message : String(e) });
    }
  }

  return { processados, pulados_anti_flood, pulados_idempotencia, abandonados, lembretes };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  const cron = iniciarCronometro();
  try {
    const r = await executar();
    log({ funcao: FUNCAO, evento: "execucao_concluida", status: "ok", duracao_ms: cron(),
      extra: { processados: r.processados, pulados_anti_flood: r.pulados_anti_flood,
        pulados_idempotencia: r.pulados_idempotencia, abandonados: r.abandonados, lembretes: r.lembretes } });
    return new Response(JSON.stringify({ ok: true, ...r }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  } catch (e) {
    log({ funcao: FUNCAO, evento: "execucao_falhou", status: "erro", duracao_ms: cron(),
      erro_msg: e instanceof Error ? e.message : String(e) });
    return new Response(JSON.stringify({ ok: false }), {
      status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }
});
