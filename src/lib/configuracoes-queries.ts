import { supabase } from "@/integrations/supabase/client";
import { normalizarE164 } from "./phone";

export const TRIAGEM_DEPT_ID = "00000000-0000-0000-0000-000000000010";
export const FALLBACK_COR = "#64748b";

// ============ Departamentos ============

export interface DepartmentRow {
  id: string;
  nome: string;
  cor: string;
  ativo: boolean;
  colaboradores: number;
}

export async function fetchDepartments(): Promise<DepartmentRow[]> {
  const [deptsRes, usersRes] = await Promise.all([
    supabase.from("departments").select("id, nome, cor, ativo").order("nome"),
    supabase.from("users").select("department_id").eq("ativo", true).eq("is_system_user", false),
  ]);
  if (deptsRes.error) throw deptsRes.error;
  if (usersRes.error) throw usersRes.error;

  const counts = new Map<string, number>();
  for (const u of usersRes.data ?? []) {
    if (!u.department_id) continue;
    counts.set(u.department_id, (counts.get(u.department_id) ?? 0) + 1);
  }
  return (deptsRes.data ?? []).map((d) => ({
    id: d.id,
    nome: d.nome,
    cor: d.cor ?? FALLBACK_COR,
    ativo: d.ativo,
    colaboradores: counts.get(d.id) ?? 0,
  }));
}

export async function createDepartment(input: { nome: string; cor: string }) {
  const { error } = await supabase.from("departments").insert({
    nome: input.nome.trim(),
    cor: input.cor,
  });
  if (error) throw error;
}

export async function updateDepartment(id: string, input: { nome: string; cor: string }) {
  if (id === TRIAGEM_DEPT_ID) throw new Error("Departamento de sistema não pode ser editado.");
  const { error } = await supabase
    .from("departments")
    .update({ nome: input.nome.trim(), cor: input.cor })
    .eq("id", id);
  if (error) throw error;
}

export async function checkDepartmentDeletable(
  id: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (id === TRIAGEM_DEPT_ID)
    return { ok: false, reason: "Departamento de sistema não pode ser excluído." };

  const [usersRes, atendRes] = await Promise.all([
    supabase.from("users").select("id", { count: "exact", head: true }).eq("department_id", id),
    supabase
      .from("atendimentos")
      .select("id", { count: "exact", head: true })
      .eq("current_department_id", id)
      .in("status", ["em_triagem", "reservado", "em_atendimento"]),
  ]);
  if (usersRes.error) throw usersRes.error;
  if (atendRes.error) throw atendRes.error;

  if ((usersRes.count ?? 0) > 0)
    return {
      ok: false,
      reason: `Existem ${usersRes.count} colaborador(es) vinculado(s) a este departamento.`,
    };
  if ((atendRes.count ?? 0) > 0)
    return {
      ok: false,
      reason: `Existem ${atendRes.count} atendimento(s) em aberto neste departamento.`,
    };
  return { ok: true };
}

export async function deleteDepartment(id: string) {
  const check = await checkDepartmentDeletable(id);
  if (!check.ok) throw new Error(check.reason);
  const { error } = await supabase.from("departments").delete().eq("id", id);
  if (error) throw error;
}

export async function setDepartmentAtivo(id: string, ativo: boolean) {
  if (id === TRIAGEM_DEPT_ID) throw new Error("Departamento de sistema não pode ser alterado.");
  const { error } = await supabase.from("departments").update({ ativo }).eq("id", id);
  if (error) throw error;
}

// ============ Colaboradores ============

export type ColaboradorStatus = "ativo" | "indisponivel" | "inativo";

export type PapelColaborador = "dono" | "administrador" | "colaborador";

export interface ColaboradorRow {
  id: string;
  nome: string;
  email: string | null;
  whatsapp: string | null;
  ativo: boolean;
  disponivel: boolean;
  is_superadmin: boolean;
  role: PapelColaborador | null;
  department_id: string | null;
  department_nome: string;
  department_cor: string;
  created_at: string;
  status: ColaboradorStatus;
}

export async function fetchColaboradores(): Promise<ColaboradorRow[]> {
  // Papel canônico vem de company_members (query à parte: o embed reverso não
  // está nos tipos gerados). is_superadmin permanece para o gate das telas.
  // whatsapp (PII/LGPD) NÃO é mais selecionável direto da tabela users — vem por
  // uma RPC SECURITY DEFINER que só devolve o número para admin (e a própria linha).
  const [usersRes, membersRes, whatsappRes] = await Promise.all([
    supabase
      .from("users")
      .select(
        "id, nome, email, ativo, disponivel, is_superadmin, department_id, created_at, departments:department_id(nome, cor)",
      )
      .eq("is_system_user", false)
      .order("nome"),
    supabase.from("company_members").select("user_id, role").eq("ativo", true),
    supabase.rpc("admin_list_user_whatsapps"),
  ]);
  if (usersRes.error) throw usersRes.error;
  if (membersRes.error) throw membersRes.error;
  if (whatsappRes.error) throw whatsappRes.error;

  const roleByUser = new Map<string, PapelColaborador>();
  for (const m of membersRes.data ?? []) {
    roleByUser.set(m.user_id as string, m.role as PapelColaborador);
  }

  const whatsappByUser = new Map<string, string | null>();
  for (const w of whatsappRes.data ?? []) {
    whatsappByUser.set(w.id, w.whatsapp ?? null);
  }

  return (usersRes.data ?? []).map((u) => {
    const dept = u.departments as { nome: string; cor: string } | null;
    let status: ColaboradorStatus = "inativo";
    if (u.ativo) status = u.disponivel ? "ativo" : "indisponivel";
    return {
      id: u.id,
      nome: u.nome,
      email: u.email,
      whatsapp: whatsappByUser.get(u.id) ?? null,
      ativo: u.ativo,
      disponivel: u.disponivel,
      is_superadmin: u.is_superadmin,
      role: roleByUser.get(u.id) ?? (u.is_superadmin ? "administrador" : "colaborador"),
      department_id: u.department_id,
      department_nome: dept?.nome ?? "—",
      department_cor: dept?.cor ?? FALLBACK_COR,
      created_at: u.created_at,
      status,
    };
  });
}

export async function updateColaborador(
  id: string,
  input: {
    nome: string;
    department_id: string | null;
    ativo: boolean;
    disponivel: boolean;
    whatsapp: string | null;
  },
) {
  // Normaliza defensivamente para E.164 (bate com a CHECK do banco).
  const whatsapp = input.whatsapp ? normalizarE164(input.whatsapp) : null;
  const { error } = await supabase
    .from("users")
    .update({
      nome: input.nome.trim(),
      department_id: input.department_id,
      ativo: input.ativo,
      disponivel: input.disponivel,
      whatsapp,
    })
    .eq("id", id);
  if (error) throw error;
}

export async function setColaboradorAtivo(id: string, ativo: boolean) {
  const { error } = await supabase.from("users").update({ ativo }).eq("id", id);
  if (error) throw error;
}

// Troca o papel de um colaborador existente (admin ↔ colaborador). Passa pela
// Edge Function porque muda o gate de acesso (users.is_superadmin) + o papel
// canônico (company_members) de forma consistente e só permite ao dono.
export async function alterarPapelColaborador(input: {
  user_id: string;
  role: "administrador" | "colaborador";
  department_id: string | null;
}) {
  const { data, error } = await supabase.functions.invoke("alterar-papel-colaborador", {
    body: input,
  });
  if (error) {
    const ctx = (error as { context?: { body?: unknown } }).context;
    throw new Error(
      (typeof ctx?.body === "string" && ctx.body) || error.message || "Falha ao alterar papel",
    );
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

export async function criarColaborador(input: {
  nome: string;
  email: string;
  password: string;
  role: "administrador" | "colaborador";
  department_id: string | null;
  whatsapp: string | null;
}) {
  const { data, error } = await supabase.functions.invoke("criar-colaborador", {
    body: input,
  });
  if (error) {
    // A edge function devolve o motivo no corpo mesmo em erro HTTP.
    const ctx = (error as { context?: { body?: unknown } }).context;
    throw new Error(
      (typeof ctx?.body === "string" && ctx.body) || error.message || "Falha ao criar",
    );
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

// ============ Templates ============

export interface TemplateRow {
  id: string;
  chave: string;
  texto: string;
  // Versões alternativas do mesmo texto (até 2). O `texto` é a versão 1; o bot
  // alterna entre [texto, ...variacoes] para não repetir a mesma mensagem
  // duas vezes seguidas ao mesmo contato.
  variacoes: string[];
  ativo: boolean;
  updated_at: string;
  updated_by: string | null;
  updated_by_nome: string | null;
}

// Máximo de variações além do texto principal (total de 3 versões).
export const MAX_VARIACOES = 2;

// Variáveis que cada template realmente recebe nas Edge Functions.
// Templates não listados aqui (ou com [] aqui) não recebem nenhuma variável
// no código atual — não exibimos sugestões para evitar placeholders mortos.
export const TEMPLATE_VARS: Record<string, string[]> = {
  triagem_boas_vindas: [],
  triagem_pergunta_departamento: ["lista_departamentos"],
  triagem_confirmacao: ["departamento"],
  triagem_erro_formato: [],
  triagem_lembrete_sem_resposta: [],
  sessao_boas_vindas: ["nome"],
  sessao_pergunta_departamento: ["lista_departamentos"],
  sessao_pergunta_colaborador: ["departamento", "lista_colaboradores"],
  sessao_confirmacao: ["colaborador"],
  notificacao_admin: ["nome_cliente", "telefone", "departamento", "tempo_aguardando"],
  notificacao_colaborador: ["nome_cliente", "telefone", "departamento"],
  encerramento: [],
  fora_horario: [],
  repasse: [],
};

export const TEMPLATE_VAR_DESC: Record<string, string> = {
  nome_cliente: "Nome do cliente (ou número se não tiver nome cadastrado)",
  telefone: "Número do cliente em formato internacional",
  departamento: "Nome do departamento atual do atendimento",
  tempo_aguardando: 'Tempo de espera formatado (ex: "1h 23min")',
  lista_departamentos: "Lista formatada dos departamentos ativos",
  nome: "Primeiro nome cadastrado na Lista de Sessões",
  colaborador: "Nome do colaborador escolhido no fluxo de sessão",
  lista_colaboradores: "Lista formatada dos colaboradores do departamento escolhido",
};

export const TEMPLATE_LABEL: Record<string, string> = {
  triagem_boas_vindas: "Boas-vindas",
  triagem_pergunta_departamento: "Pergunta de departamento",
  triagem_confirmacao: "Confirmação de encaminhamento",
  triagem_erro_formato: "Erro de formato (triagem)",
  triagem_lembrete_sem_resposta: "Lembrete na triagem sem resposta",
  sessao_boas_vindas: "Sessão · Boas-vindas (personalizada)",
  sessao_pergunta_departamento: "Sessão · Pergunta de departamento",
  sessao_pergunta_colaborador: "Sessão · Pergunta de colaborador",
  sessao_confirmacao: "Sessão · Confirmação de encaminhamento",
  notificacao_admin: "Notificação ao administrador",
  notificacao_colaborador: "Aviso ao colaborador (novo pendente)",
  encerramento: "Encerramento",
  fora_horario: "Fora do horário",
  repasse: "Aviso de repasse",
};

export async function fetchTemplates(): Promise<TemplateRow[]> {
  const { data, error } = await supabase
    .from("templates_mensagem")
    .select("id, chave, texto, variacoes, ativo, updated_at, updated_by")
    .order("chave");
  if (error) throw error;

  const userIds = Array.from(
    new Set((data ?? []).map((t) => t.updated_by).filter((x): x is string => !!x)),
  );
  let nameMap = new Map<string, string>();
  if (userIds.length) {
    const { data: users } = await supabase.from("users").select("id, nome").in("id", userIds);
    nameMap = new Map((users ?? []).map((u) => [u.id, u.nome]));
  }
  return (data ?? []).map((t) => ({
    id: t.id,
    chave: t.chave,
    texto: t.texto,
    variacoes: t.variacoes ?? [],
    ativo: t.ativo,
    updated_at: t.updated_at,
    updated_by: t.updated_by,
    updated_by_nome: t.updated_by ? (nameMap.get(t.updated_by) ?? null) : null,
  }));
}

// Salva o texto principal e as variações. Descarta variações em branco e
// limita ao máximo permitido antes de gravar.
export async function updateTemplate(id: string, texto: string, variacoes: string[]) {
  const { data: auth } = await supabase.auth.getUser();
  const limpas = variacoes.map((v) => v.trim()).filter((v) => v.length > 0).slice(0, MAX_VARIACOES);
  const { error } = await supabase
    .from("templates_mensagem")
    .update({ texto, variacoes: limpas, updated_by: auth.user?.id ?? null })
    .eq("id", id);
  if (error) throw error;
}

export async function setTemplateAtivo(id: string, ativo: boolean) {
  const { data: auth } = await supabase.auth.getUser();
  const { error } = await supabase
    .from("templates_mensagem")
    .update({ ativo, updated_by: auth.user?.id ?? null })
    .eq("id", id);
  if (error) throw error;
}

export async function createTemplate(input: { chave: string; texto: string }) {
  const { data: auth } = await supabase.auth.getUser();
  const { error } = await supabase.from("templates_mensagem").insert({
    chave: input.chave.trim(),
    texto: input.texto,
    ativo: true,
    updated_by: auth.user?.id ?? null,
  });
  if (error) throw error;
}

// ============ Horário comercial ============

export interface BusinessHoursRow {
  id: string;
  dia_semana: number; // 0=Dom .. 6=Sáb
  inicio: string; // "HH:MM"
  fim: string;
}

export const DIAS_SEMANA = [
  { num: 0, label: "Domingo" },
  { num: 1, label: "Segunda" },
  { num: 2, label: "Terça" },
  { num: 3, label: "Quarta" },
  { num: 4, label: "Quinta" },
  { num: 5, label: "Sexta" },
  { num: 6, label: "Sábado" },
] as const;

function trimSeconds(t: string): string {
  return t.length >= 5 ? t.slice(0, 5) : t;
}

export async function fetchBusinessHours(): Promise<BusinessHoursRow[]> {
  const { data, error } = await supabase
    .from("business_hours")
    .select("id, dia_semana, inicio, fim")
    .order("dia_semana")
    .order("inicio");
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id,
    dia_semana: r.dia_semana,
    inicio: trimSeconds(r.inicio),
    fim: trimSeconds(r.fim),
  }));
}

function toMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

export async function addBusinessHoursSlot(input: {
  dia_semana: number;
  inicio: string;
  fim: string;
}) {
  if (toMinutes(input.fim) <= toMinutes(input.inicio)) {
    throw new Error("Horário final deve ser maior que o inicial.");
  }
  const existing = await fetchBusinessHours();
  const sameDay = existing.filter((s) => s.dia_semana === input.dia_semana);
  for (const s of sameDay) {
    const overlap =
      toMinutes(input.inicio) < toMinutes(s.fim) && toMinutes(s.inicio) < toMinutes(input.fim);
    if (overlap) throw new Error("A faixa se sobrepõe a uma faixa existente neste dia.");
  }
  const { error } = await supabase.from("business_hours").insert({
    dia_semana: input.dia_semana,
    inicio: input.inicio,
    fim: input.fim,
  });
  if (error) throw error;
}

export async function removeBusinessHoursSlot(id: string) {
  const { error } = await supabase.from("business_hours").delete().eq("id", id);
  if (error) throw error;
}

// ============ Feriados ============

export interface HolidayRow {
  id: string;
  data: string; // "YYYY-MM-DD"
  descricao: string | null;
  inicio_override: string | null;
  fim_override: string | null;
}

export async function fetchHolidays(): Promise<HolidayRow[]> {
  const { data, error } = await supabase
    .from("holidays")
    .select("id, data, descricao, inicio_override, fim_override")
    .order("data", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((h) => ({
    id: h.id,
    data: h.data,
    descricao: h.descricao,
    inicio_override: h.inicio_override ? trimSeconds(h.inicio_override) : null,
    fim_override: h.fim_override ? trimSeconds(h.fim_override) : null,
  }));
}

export async function createHoliday(input: {
  data: string;
  descricao: string;
  inicio_override: string | null;
  fim_override: string | null;
}) {
  if (input.inicio_override && input.fim_override) {
    if (toMinutes(input.fim_override) <= toMinutes(input.inicio_override)) {
      throw new Error("Horário final deve ser maior que o inicial.");
    }
  }
  const { error } = await supabase.from("holidays").insert({
    data: input.data,
    descricao: input.descricao.trim() || null,
    inicio_override: input.inicio_override,
    fim_override: input.fim_override,
  });
  if (error) throw error;
}

export async function updateHoliday(
  id: string,
  input: {
    data: string;
    descricao: string;
    inicio_override: string | null;
    fim_override: string | null;
  },
) {
  if (input.inicio_override && input.fim_override) {
    if (toMinutes(input.fim_override) <= toMinutes(input.inicio_override)) {
      throw new Error("Horário final deve ser maior que o inicial.");
    }
  }
  const { error } = await supabase
    .from("holidays")
    .update({
      data: input.data,
      descricao: input.descricao.trim() || null,
      inicio_override: input.inicio_override,
      fim_override: input.fim_override,
    })
    .eq("id", id);
  if (error) throw error;
}

export async function deleteHoliday(id: string) {
  const { error } = await supabase.from("holidays").delete().eq("id", id);
  if (error) throw error;
}

// ============ Tempos (system_config) ============

export type TempoUnit = "segundos" | "minutos" | "minutos úteis" | ""; /* sem unidade */

/** Seções da aba Tempos. A ordem aqui é a ordem exibida na tela. */
export const TEMPO_GRUPOS = [
  {
    id: "triagem",
    titulo: "Bot de triagem",
    descricao: "Como o bot conversa com o cliente antes de entregar para uma pessoa.",
  },
  {
    id: "avisos",
    titulo: "Avisos internos no WhatsApp",
    descricao: "Quando a equipe é cobrada por cliente esperando sem atendimento.",
  },
  {
    id: "encerramento",
    titulo: "Encerramento",
    descricao: "Quando um atendimento é fechado sozinho por inatividade.",
  },
] as const;

export type TempoGrupoId = (typeof TEMPO_GRUPOS)[number]["id"];

export interface TempoMeta {
  chave: string;
  label: string;
  unit: TempoUnit;
  min: number;
  max: number;
  grupo: TempoGrupoId;
  /** Presente = o ajuste não tem efeito hoje; a tela mostra o motivo. */
  inativo?: string;
}

export const TEMPOS: TempoMeta[] = [
  {
    chave: "delay_anti_flood_triagem",
    label: "Esperar o cliente terminar de digitar",
    unit: "segundos",
    min: 1,
    max: 300,
    grupo: "triagem",
  },
  {
    chave: "triagem_max_tentativas",
    label: "Tentativas antes do bot desistir e chamar uma pessoa",
    unit: "",
    min: 1,
    max: 10,
    grupo: "triagem",
  },
  {
    chave: "tempo_abandono_triagem",
    label: "Encerrar triagem quando o cliente para de responder",
    unit: "minutos",
    min: 1,
    max: 1440,
    grupo: "triagem",
  },
  {
    chave: "tempo_alerta_atendimento_parado",
    label: "Avisar o responsável do setor: cliente esperando sem atendimento",
    unit: "minutos úteis",
    min: 1,
    max: 1440,
    grupo: "avisos",
  },
  {
    chave: "intervalo_repeticao_alerta_atendimento_parado",
    label: "Cobrar de novo o responsável do setor",
    unit: "minutos",
    min: 1,
    max: 1440,
    grupo: "avisos",
  },
  {
    chave: "tempo_notificacao_admin",
    label: "Avisar o número do administrador: cliente pendente",
    unit: "minutos",
    min: 1,
    max: 1440,
    grupo: "avisos",
    inativo:
      "Sem efeito: não há número de administrador cadastrado, então esse aviso nunca é enviado.",
  },
  {
    chave: "intervalo_repeticao_notificacao_admin",
    label: "Cobrar de novo o número do administrador",
    unit: "minutos",
    min: 1,
    max: 1440,
    grupo: "avisos",
    inativo:
      "Sem efeito: não há número de administrador cadastrado, então esse aviso nunca é enviado.",
  },
  {
    chave: "tempo_encerramento_automatico",
    label: "Encerrar atendimento parado por inatividade",
    unit: "minutos",
    min: 1,
    max: 10080,
    grupo: "encerramento",
  },
];

export interface TempoRow extends TempoMeta {
  /** null = chave ausente em system_config (não configurada). Nunca falseie como 0. */
  valor: number | null;
  descricao: string | null;
}

export async function fetchTempos(): Promise<TempoRow[]> {
  const chaves = TEMPOS.map((t) => t.chave);
  const { data, error } = await supabase
    .from("system_config")
    .select("chave, valor, descricao")
    .in("chave", chaves);
  if (error) throw error;
  const map = new Map((data ?? []).map((r) => [r.chave, r]));
  return TEMPOS.map((meta) => {
    const row = map.get(meta.chave);
    const n = Number.parseInt((row?.valor ?? "").trim(), 10);
    return {
      ...meta,
      valor: Number.isFinite(n) ? n : null,
      descricao: row?.descricao ?? null,
    };
  });
}

export async function updateTempo(chave: string, valor: number) {
  const { data: auth } = await supabase.auth.getUser();
  // `.select()` é obrigatório aqui: sem ele um UPDATE que não casa nenhuma linha
  // volta sem erro e o save "dá certo" sem gravar nada — foi exatamente esse
  // silêncio que escondeu a aba Tempos zerada.
  const { data, error } = await supabase
    .from("system_config")
    .update({ valor: String(valor), updated_by: auth.user?.id ?? null })
    .eq("chave", chave)
    .select("chave");
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error(
      `Configuração "${chave}" não existe em system_config — nada foi salvo.`,
    );
  }
}

// ============ Operação (kill switch) ============

export interface OperacaoConfig {
  bot_ativo: boolean;
  bot_ativacao_programada: string | null;
  bot_ativado_em: string | null;
  pendentes_abertos_a_todos: boolean;
  triagem_reinicia_ao_virar_dia: boolean;
  triagem_lembrete_ativo: boolean;
  triagem_lembrete_minutos: number;
  notificar_colaboradores_pendente: boolean;
}

export async function fetchOperacaoConfig(): Promise<OperacaoConfig> {
  const { data, error } = await supabase
    .from("system_config")
    .select("chave, valor")
    .in("chave", [
      "bot_ativo",
      "bot_ativacao_programada",
      "bot_ativado_em",
      "pendentes_abertos_a_todos",
      "triagem_reinicia_ao_virar_dia",
      "triagem_lembrete_ativo",
      "triagem_lembrete_minutos",
      "notificar_colaboradores_pendente",
    ]);
  if (error) throw error;
  const map = new Map((data ?? []).map((r) => [r.chave, r.valor]));
  return {
    bot_ativo: map.get("bot_ativo") === "true",
    bot_ativacao_programada: map.get("bot_ativacao_programada") || null,
    bot_ativado_em: map.get("bot_ativado_em") || null,
    pendentes_abertos_a_todos: map.get("pendentes_abertos_a_todos") === "true",
    triagem_reinicia_ao_virar_dia: (map.get("triagem_reinicia_ao_virar_dia") ?? "true") === "true",
    triagem_lembrete_ativo: (map.get("triagem_lembrete_ativo") ?? "true") === "true",
    triagem_lembrete_minutos: parseInt(map.get("triagem_lembrete_minutos") ?? "30", 10) || 30,
    notificar_colaboradores_pendente: map.get("notificar_colaboradores_pendente") === "true",
  };
}

export async function setTriagemReiniciaAoVirarDia(ativo: boolean) {
  const { data: auth } = await supabase.auth.getUser();
  const { error } = await supabase
    .from("system_config")
    .update({ valor: String(ativo), updated_by: auth.user?.id ?? null })
    .eq("chave", "triagem_reinicia_ao_virar_dia");
  if (error) throw error;
}

export async function setTriagemLembreteAtivo(ativo: boolean) {
  const { data: auth } = await supabase.auth.getUser();
  const { error } = await supabase
    .from("system_config")
    .update({ valor: String(ativo), updated_by: auth.user?.id ?? null })
    .eq("chave", "triagem_lembrete_ativo");
  if (error) throw error;
}

export async function setNotificarColaboradoresPendente(ativo: boolean) {
  const { data: auth } = await supabase.auth.getUser();
  const { error } = await supabase
    .from("system_config")
    .update({ valor: String(ativo), updated_by: auth.user?.id ?? null })
    .eq("chave", "notificar_colaboradores_pendente");
  if (error) throw error;
}

export async function setTriagemLembreteMinutos(minutos: number) {
  const v = Math.max(5, Math.min(240, Math.round(minutos)));
  const { data: auth } = await supabase.auth.getUser();
  const { error } = await supabase
    .from("system_config")
    .update({ valor: String(v), updated_by: auth.user?.id ?? null })
    .eq("chave", "triagem_lembrete_minutos");
  if (error) throw error;
}

export async function setBotAtivo(ativo: boolean) {
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id ?? null;
  const { error } = await supabase
    .from("system_config")
    .update({ valor: String(ativo), updated_by: userId })
    .eq("chave", "bot_ativo");
  if (error) throw error;
  // Toda transição manual para ON precisa carimbar bot_ativado_em, senão
  // o triagem-bot não tem como ignorar o backlog antigo e dispara em massa.
  if (ativo) {
    const nowIso = new Date().toISOString();
    const { error: e2 } = await supabase
      .from("system_config")
      .update({ valor: nowIso, updated_by: userId })
      .eq("chave", "bot_ativado_em");
    if (e2) throw e2;
  }
}

export async function setBotAtivacaoProgramada(data: string | null) {
  const { data: auth } = await supabase.auth.getUser();
  const { error } = await supabase
    .from("system_config")
    .update({ valor: data, updated_by: auth.user?.id ?? null })
    .eq("chave", "bot_ativacao_programada");
  if (error) throw error;
}

// ============ Modo emergência: pendentes abertos a todos ============

export async function fetchPendentesAbertosATodos(): Promise<boolean> {
  const { data, error } = await supabase
    .from("system_config")
    .select("valor")
    .eq("chave", "pendentes_abertos_a_todos")
    .maybeSingle();
  if (error) throw error;
  return data?.valor === "true";
}

export async function setPendentesAbertosATodos(ativo: boolean) {
  const { data: auth } = await supabase.auth.getUser();
  const { error } = await supabase
    .from("system_config")
    .update({ valor: String(ativo), updated_by: auth.user?.id ?? null })
    .eq("chave", "pendentes_abertos_a_todos");
  if (error) throw error;
}
