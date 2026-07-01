// Edge Function: triagem-bot (Partes A + B).
// Cron a cada 10s. Cobre o ciclo completo de triagem:
//  - Continuidade do mesmo dia útil (RN-05.6) curto-circuita boas-vindas.
//  - aguardando_inicio: envia boas-vindas + pergunta departamento.
//  - aguardando_departamento: identifica dept (matching numero/exato/parcial).
//  - aguardando_assunto: pergunta assunto, identifica, finaliza.
//  - Finalização: carimba mensagens, roteia (especialista → último atendente → pendente).
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
  | "aguardando_assunto"
  | "concluida";

interface Atendimento {
  id: string;
  client_id: string;
  triagem_estagio: Estagio;
  triagem_tentativas: number;
  current_department_id: string | null;
  triagem_last_processed_msg_id: string | null;
}

interface Departamento { id: string; nome: string; }
interface Subject { id: string; nome: string; department_id: string; }
interface InboundMsg { id: string; content: string | null; created_at: string; }

interface Config {
  delaySeg: number;
  maxTentativas: number;
  deptDefault: string;
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

function identificarPorTexto<T extends { id: string; nome: string }>(texto: string, itens: T[]): string | null {
  const t = normalizar(texto);
  if (!t) return null;
  if (/^\d+$/.test(t)) {
    const idx = parseInt(t, 10) - 1;
    return idx >= 0 && idx < itens.length ? itens[idx].id : null;
  }
  const exato = itens.find((d) => normalizar(d.nome) === t);
  if (exato) return exato.id;
  const parciais = itens.filter((d) => normalizar(d.nome).startsWith(t));
  if (parciais.length === 1) return parciais[0].id;
  if (parciais.length === 0) {
    const inc = itens.filter((d) => normalizar(d.nome).includes(t));
    if (inc.length === 1) return inc[0].id;
  }
  return null;
}

async function carregarConfig(): Promise<Config> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from("system_config").select("chave, valor")
    .in("chave", [
      "delay_anti_flood_triagem", "triagem_max_tentativas",
      "triagem_departamento_default", "tempo_abandono_triagem",
      "triagem_lembrete_ativo", "triagem_lembrete_minutos",
    ]);
  const m = new Map((data ?? []).map((r) => [r.chave as string, r.valor as string | null]));
  return {
    delaySeg: parseInt(m.get("delay_anti_flood_triagem") ?? "8", 10) || 8,
    maxTentativas: parseInt(m.get("triagem_max_tentativas") ?? "3", 10) || 3,
    deptDefault: m.get("triagem_departamento_default") ?? TRIAGEM_DEPT_ID,
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

async function carregarSubjectsPorDept(deptId: string): Promise<Subject[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("subjects").select("id, nome, department_id")
    .eq("ativo", true).eq("department_id", deptId).order("nome", { ascending: true });
  if (error) throw error;
  return (data ?? []) as Subject[];
}

async function nomeDept(deptId: string): Promise<string> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from("departments").select("nome").eq("id", deptId).maybeSingle();
  return (data as { nome: string } | null)?.nome ?? "";
}

async function carregarTemplates(chaves: string[]): Promise<Map<string, string>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("templates_mensagem").select("chave, texto")
    .in("chave", chaves).eq("ativo", true);
  if (error) throw error;
  return new Map((data ?? []).map((r) => [r.chave as string, r.texto as string]));
}

async function ultimaMsgInbound(atendimentoId: string): Promise<InboundMsg | null> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from("mensagens").select("id, content, created_at")
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
  let q = supabase.from("mensagens").select("id, content, created_at")
    .eq("atendimento_id", atendimentoId).eq("direction", "inbound");
  if (cutoff) q = q.gt("created_at", cutoff);
  const { data, error } = await q.order("created_at", { ascending: true }).limit(50);
  if (error) return [];
  return (data ?? []) as InboundMsg[];
}

async function jaPerguntouAssunto(atendimentoId: string): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  // Heurística: existe alguma outbound do bot cujo content contém "qual assunto"
  // (substring estável dentro do template triagem_pergunta_assunto).
  const { data } = await supabase.from("mensagens").select("id")
    .eq("atendimento_id", atendimentoId).eq("direction", "outbound").eq("sender_type", "bot")
    .ilike("content", "%qual assunto%").limit(1);
  return (data ?? []).length > 0;
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
  const limpo = texto
    .replace(/\{\{\s*lista_departamentos\s*\}\}/g, "")
    .replace(/\{\{\s*lista_assuntos\s*\}\}/g, "");
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
    media_metadata: {
      kind: "lista_opcoes",
      titulo: LIST_TITULO,
      button_label: buttonLabel,
      opcoes: opcoes.map((o) => ({
        id: o.id,
        title: o.title,
        ...(o.description ? { description: o.description } : {}),
      })),
    },
  });
  if (error) {
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
function opcoesDeAssuntos(subjects: Subject[]): OpcaoLista[] {
  return subjects.map((s) => ({ id: `sub_${s.id}`, title: s.nome }));
}

async function getTelefone(clientId: string): Promise<string | null> {
  const { data } = await getSupabaseAdmin().from("clients")
    .select("numero_whatsapp").eq("id", clientId).maybeSingle();
  return (data as { numero_whatsapp: string } | null)?.numero_whatsapp ?? null;
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
    .select("current_department_id, subject_id")
    .eq("client_id", at.client_id).eq("assigned_to", userId).eq("status", "encerrado")
    .order("closed_at", { ascending: false }).limit(1).maybeSingle();

  const deptId = (prev as { current_department_id: string | null } | null)?.current_department_id ?? null;
  const subjectId = (prev as { subject_id: string | null } | null)?.subject_id ?? null;
  if (!deptId) {
    // Sem dept herdável → não aplica continuidade.
    return false;
  }

  const nowIso = new Date().toISOString();
  await supabase.from("atendimentos").update({
    status: "reservado",
    assigned_to: userId,
    current_department_id: deptId,
    subject_id: subjectId,
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

// =============== Estágio: aguardando_inicio ===============
async function processarAguardandoInicio(
  at: Atendimento, inbound: InboundMsg,
  templates: Map<string, string>, deps: Departamento[],
): Promise<void> {
  const cron = iniciarCronometro();
  const supabase = getSupabaseAdmin();

  // RN-05.6 — continuidade do mesmo dia útil.
  if (await aplicarContinuidadeSeAplicavel(at, inbound)) return;

  const telefone = await getTelefone(at.client_id);
  if (!telefone) return;

  const boas = templates.get("triagem_boas_vindas");
  const pergunta = templates.get("triagem_pergunta_departamento");
  if (!boas || !pergunta) {
    log({ funcao: FUNCAO, evento: "template_ausente", status: "erro",
      atendimento_id: at.id, erro_msg: "boas_vindas/pergunta_departamento" });
    return;
  }

  if (!(await enviarEPersistir(at, telefone, boas))) return;
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
  templates: Map<string, string>, deps: Departamento[],
  cfg: Config,
): Promise<void> {
  const cron = iniciarCronometro();
  const supabase = getSupabaseAdmin();

  // Coleta todas as inbounds desde a última processada (inclui a `inbound` passada).
  const novas = await inboundsDesdeUltimaProcessada(at.id, at.triagem_last_processed_msg_id);
  const lote = novas.length > 0 ? novas : [inbound];
  const ultimoIdLote = lote[lote.length - 1].id;

  // Procura a primeira inbound de texto que resolve para um departamento.
  let deptId: string | null = null;
  let textosVistos = 0;
  for (const m of lote) {
    if (!m.content || !m.content.trim()) continue;
    textosVistos++;
    const r = identificarPorTexto(m.content, deps);
    if (r) { deptId = r; break; }
  }

  if (deptId) {
    await supabase.from("atendimentos").update({
      current_department_id: deptId,
      triagem_estagio: "aguardando_assunto",
      triagem_tentativas: 0,
      triagem_last_processed_msg_id: ultimoIdLote,
    }).eq("id", at.id);
    log({ funcao: FUNCAO, evento: "departamento_identificado", status: "ok",
      atendimento_id: at.id, duracao_ms: cron(), extra: { dept_id: deptId } });
    return;
  }

  // Sem texto algum no lote → não consome tentativa, só marca como processado.
  if (textosVistos === 0) {
    await marcarInboundProcessada(at.id, ultimoIdLote);
    log({ funcao: FUNCAO, evento: "departamento_apenas_midia", status: "ok",
      atendimento_id: at.id, duracao_ms: cron() });
    return;
  }

  const novasTent = at.triagem_tentativas + 1;
  if (novasTent >= cfg.maxTentativas) {
    await supabase.from("atendimentos").update({
      current_department_id: cfg.deptDefault,
      triagem_estagio: "aguardando_assunto",
      triagem_tentativas: novasTent,
      triagem_last_processed_msg_id: ultimoIdLote,
    }).eq("id", at.id);
    log({ funcao: FUNCAO, evento: "triagem_max_tentativas_atingida", status: "ok",
      atendimento_id: at.id, duracao_ms: cron(), extra: { dept_default: cfg.deptDefault } });
    return;
  }

  const telefone = await getTelefone(at.client_id);
  if (!telefone) { await marcarInboundProcessada(at.id, ultimoIdLote); return; }

  const erro = templates.get("triagem_erro_formato");
  const pergunta = templates.get("triagem_pergunta_departamento");
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

// =============== Estágio: aguardando_assunto ===============
async function processarAguardandoAssunto(
  at: Atendimento, inbound: InboundMsg,
  templates: Map<string, string>, cfg: Config,
): Promise<void> {
  const cron = iniciarCronometro();
  const supabase = getSupabaseAdmin();

  if (!at.current_department_id) {
    log({ funcao: FUNCAO, evento: "aguardando_assunto_sem_dept", status: "erro", atendimento_id: at.id });
    await marcarInboundProcessada(at.id, inbound.id);
    return;
  }

  const subjects = await carregarSubjectsPorDept(at.current_department_id);
  if (subjects.length === 0) {
    // Departamento sem assuntos cadastrados: pula assunto e finaliza com subject NULL.
    log({ funcao: FUNCAO, evento: "departamento_sem_assuntos", status: "ok",
      atendimento_id: at.id, extra: { dept_id: at.current_department_id } });
    await finalizarTriagem(at, at.current_department_id, null, inbound.id);
    return;
  }

  // Primeira passagem: ainda não perguntamos sobre assunto neste atendimento.
  const jaPerguntou = await jaPerguntouAssunto(at.id);
  if (!jaPerguntou) {
    const telefone = await getTelefone(at.client_id);
    if (!telefone) return;
    const tpl = templates.get("triagem_pergunta_assunto");
    if (!tpl) {
      log({ funcao: FUNCAO, evento: "template_ausente", status: "erro",
        atendimento_id: at.id, erro_msg: "triagem_pergunta_assunto" });
      return;
    }
    const deptNome = await nomeDept(at.current_department_id);
    {
      const vars = { departamento: deptNome, lista_assuntos: formatarLista(subjects) };
      const corpo = corpoSemListaNumerada(tpl, vars);
      const fallback = aplicarTemplate(tpl, vars);
      await enviarListaEPersistir(at, telefone, corpo, fallback, "Ver assuntos", opcoesDeAssuntos(subjects));
    }
    await supabase.from("atendimentos").update({
      triagem_tentativas: 0, triagem_last_processed_msg_id: inbound.id,
    }).eq("id", at.id);
    log({ funcao: FUNCAO, evento: "pergunta_assunto_enviada", status: "ok",
      atendimento_id: at.id, duracao_ms: cron() });
    return;
  }

  // Passagens seguintes: cliente respondeu o assunto. Varre todas as inbounds
  // novas para não perder a resposta caso o cliente envie texto + mídia juntos.
  const novas = await inboundsDesdeUltimaProcessada(at.id, at.triagem_last_processed_msg_id);
  const lote = novas.length > 0 ? novas : [inbound];
  const ultimoIdLote = lote[lote.length - 1].id;

  let subjectId: string | null = null;
  let textosVistos = 0;
  for (const m of lote) {
    if (!m.content || !m.content.trim()) continue;
    textosVistos++;
    const r = identificarPorTexto(m.content, subjects);
    if (r) { subjectId = r; break; }
  }

  if (subjectId) {
    await finalizarTriagem(at, at.current_department_id, subjectId, ultimoIdLote);
    log({ funcao: FUNCAO, evento: "assunto_identificado", status: "ok",
      atendimento_id: at.id, duracao_ms: cron(), extra: { subject_id: subjectId } });
    return;
  }

  if (textosVistos === 0) {
    await marcarInboundProcessada(at.id, ultimoIdLote);
    log({ funcao: FUNCAO, evento: "assunto_apenas_midia", status: "ok",
      atendimento_id: at.id, duracao_ms: cron() });
    return;
  }

  const novasTent = at.triagem_tentativas + 1;
  if (novasTent >= cfg.maxTentativas) {
    // Fallback: primeiro assunto ativo do dept.
    const fallback = subjects[0].id;
    await finalizarTriagem(at, at.current_department_id, fallback, ultimoIdLote);
    log({ funcao: FUNCAO, evento: "assunto_max_tentativas_atingida", status: "ok",
      atendimento_id: at.id, duracao_ms: cron(), extra: { subject_fallback: fallback } });
    return;
  }

  const telefone = await getTelefone(at.client_id);
  if (!telefone) { await marcarInboundProcessada(at.id, ultimoIdLote); return; }
  const erro = templates.get("triagem_erro_formato");
  const tpl = templates.get("triagem_pergunta_assunto");
  if (!erro || !tpl) { await marcarInboundProcessada(at.id, ultimoIdLote); return; }
  const deptNome = await nomeDept(at.current_department_id);

  await enviarEPersistir(at, telefone, erro);
  {
    const vars = { departamento: deptNome, lista_assuntos: formatarLista(subjects) };
    const corpo = corpoSemListaNumerada(tpl, vars);
    const fallback = aplicarTemplate(tpl, vars);
    await enviarListaEPersistir(at, telefone, corpo, fallback, "Ver assuntos", opcoesDeAssuntos(subjects));
  }
  await supabase.from("atendimentos").update({
    triagem_tentativas: novasTent, triagem_last_processed_msg_id: ultimoIdLote,
  }).eq("id", at.id);

  log({ funcao: FUNCAO, evento: "assunto_nao_identificado", status: "ok",
    atendimento_id: at.id, duracao_ms: cron(), extra: { tentativas: novasTent } });
}

// =============== Finalização da triagem (RN-06) ===============
async function finalizarTriagem(
  at: Atendimento, deptId: string, subjectId: string | null, inboundId: string,
): Promise<void> {
  const supabase = getSupabaseAdmin();

  // 1) Carimba mensagens da triagem.
  await supabase.from("mensagens").update({ department_id: deptId })
    .eq("atendimento_id", at.id).is("department_id", null);

  // 2) Roteamento.
  let assignedTo: string | null = null;
  let routing: "especialista" | "ultimo_atendente" | "pendente" = "pendente";

  // RN-06.1 — especialista do assunto.
  if (subjectId) {
    const { data: routings } = await supabase.from("especialista_routing")
      .select("user_id").eq("subject_id", subjectId).eq("ativo", true);
    const userIds = (routings ?? []).map((r) => (r as { user_id: string }).user_id);
    if (userIds.length > 0) {
      const { data: validUsers } = await supabase.from("users").select("id")
        .in("id", userIds).eq("ativo", true).eq("disponivel", true).limit(1);
      const u = (validUsers ?? [])[0] as { id: string } | undefined;
      if (u) { assignedTo = u.id; routing = "especialista"; }
    }
  }

  // RN-06.2 — último atendente do departamento.
  if (!assignedTo) {
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
    triagem_estagio: "concluida",
    triagem_finished_at: nowIso,
    triagem_last_processed_msg_id: inboundId,
    subject_id: subjectId,
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
    extra: { routing_decision: routing, assigned_to: assignedTo, dept_id: deptId, subject_id: subjectId } });
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
    .in("triagem_estagio", ["aguardando_departamento", "aguardando_assunto"])
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
  const tpl = templates.get("triagem_lembrete_sem_resposta");
  if (!tpl) {
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
    const fakeAt: Atendimento = {
      id: a.id, client_id: a.client_id,
      triagem_estagio: "aguardando_departamento",
      triagem_tentativas: 0,
      current_department_id: a.current_department_id,
      triagem_last_processed_msg_id: null,
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
    .select("id, client_id, triagem_estagio, triagem_tentativas, current_department_id, triagem_last_processed_msg_id")
    .eq("status", "em_triagem")
    .in("triagem_estagio", ["aguardando_inicio", "aguardando_departamento", "aguardando_assunto"])
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
    "triagem_pergunta_assunto", "triagem_erro_formato",
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
        // Exceção: aguardando_assunto na primeira passagem precisa enviar pergunta
        // mesmo sem nova inbound (acabou de transicionar de aguardando_departamento).
        if (at.triagem_estagio === "aguardando_assunto" && !(await jaPerguntouAssunto(at.id))) {
          await processarAguardandoAssunto(at, inbound, templates, cfg);
          processados++;
          continue;
        }
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
      } else if (at.triagem_estagio === "aguardando_assunto") {
        await processarAguardandoAssunto(at, inbound, templates, cfg);
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
