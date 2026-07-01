import { supabase } from "@/integrations/supabase/client";

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

// ============ Assuntos ============

export interface SubjectRow {
  id: string;
  nome: string;
  cor: string;
  department_id: string;
  department_nome: string;
  department_cor: string;
}

export async function fetchSubjects(): Promise<SubjectRow[]> {
  const { data, error } = await supabase
    .from("subjects")
    .select("id, nome, cor, department_id, departments:department_id(nome, cor)")
    .order("nome");
  if (error) throw error;
  return (data ?? []).map((s) => {
    const dept = s.departments as { nome: string; cor: string } | null;
    return {
      id: s.id,
      nome: s.nome,
      cor: s.cor ?? FALLBACK_COR,
      department_id: s.department_id,
      department_nome: dept?.nome ?? "—",
      department_cor: dept?.cor ?? FALLBACK_COR,
    };
  });
}

export async function createSubject(input: { nome: string; cor: string; department_id: string }) {
  const { error } = await supabase.from("subjects").insert({
    nome: input.nome.trim(),
    cor: input.cor,
    department_id: input.department_id,
  });
  if (error) throw error;
}

export async function updateSubject(
  id: string,
  input: { nome: string; cor: string; department_id: string },
) {
  const { error } = await supabase
    .from("subjects")
    .update({
      nome: input.nome.trim(),
      cor: input.cor,
      department_id: input.department_id,
    })
    .eq("id", id);
  if (error) throw error;
}

export async function checkSubjectDeletable(id: string): Promise<{ ok: boolean; reason?: string }> {
  const { count, error } = await supabase
    .from("atendimentos")
    .select("id", { count: "exact", head: true })
    .eq("subject_id", id);
  if (error) throw error;
  if ((count ?? 0) > 0)
    return {
      ok: false,
      reason: `Existem ${count} atendimento(s) vinculado(s) a este assunto.`,
    };
  return { ok: true };
}

export async function deleteSubject(id: string) {
  const check = await checkSubjectDeletable(id);
  if (!check.ok) throw new Error(check.reason);
  const { error } = await supabase.from("subjects").delete().eq("id", id);
  if (error) throw error;
}

// ============ Colaboradores ============

export type ColaboradorStatus = "ativo" | "indisponivel" | "inativo";

export type PapelColaborador = "dono" | "administrador" | "colaborador";

export interface ColaboradorRow {
  id: string;
  nome: string;
  email: string | null;
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
  const [usersRes, membersRes] = await Promise.all([
    supabase
      .from("users")
      .select(
        "id, nome, email, ativo, disponivel, is_superadmin, department_id, created_at, departments:department_id(nome, cor)",
      )
      .eq("is_system_user", false)
      .order("nome"),
    supabase.from("company_members").select("user_id, role").eq("ativo", true),
  ]);
  if (usersRes.error) throw usersRes.error;
  if (membersRes.error) throw membersRes.error;

  const roleByUser = new Map<string, PapelColaborador>();
  for (const m of membersRes.data ?? []) {
    roleByUser.set(m.user_id as string, m.role as PapelColaborador);
  }

  return (usersRes.data ?? []).map((u) => {
    const dept = u.departments as { nome: string; cor: string } | null;
    let status: ColaboradorStatus = "inativo";
    if (u.ativo) status = u.disponivel ? "ativo" : "indisponivel";
    return {
      id: u.id,
      nome: u.nome,
      email: u.email,
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
  input: { nome: string; department_id: string | null; ativo: boolean; disponivel: boolean },
) {
  const { error } = await supabase
    .from("users")
    .update({
      nome: input.nome.trim(),
      department_id: input.department_id,
      ativo: input.ativo,
      disponivel: input.disponivel,
    })
    .eq("id", id);
  if (error) throw error;
}

export async function setColaboradorAtivo(id: string, ativo: boolean) {
  const { error } = await supabase.from("users").update({ ativo }).eq("id", id);
  if (error) throw error;
}

export async function criarColaborador(input: {
  nome: string;
  email: string;
  password: string;
  role: "administrador" | "colaborador";
  department_id: string | null;
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
  ativo: boolean;
  updated_at: string;
  updated_by: string | null;
  updated_by_nome: string | null;
}

// Variáveis que cada template realmente recebe nas Edge Functions.
// Templates não listados aqui (ou com [] aqui) não recebem nenhuma variável
// no código atual — não exibimos sugestões para evitar placeholders mortos.
export const TEMPLATE_VARS: Record<string, string[]> = {
  triagem_boas_vindas: [],
  triagem_pergunta_departamento: ["lista_departamentos"],
  triagem_pergunta_assunto: ["departamento", "lista_assuntos"],
  triagem_erro_formato: [],
  triagem_lembrete_sem_resposta: [],
  notificacao_luana: ["nome_cliente", "telefone", "departamento", "assunto", "tempo_aguardando"],
  encerramento: [],
  fora_horario: [],
  repasse: [],
};

export const TEMPLATE_VAR_DESC: Record<string, string> = {
  nome_cliente: "Nome do cliente (ou número se não tiver nome cadastrado)",
  telefone: "Número do cliente em formato internacional",
  departamento: "Nome do departamento atual do atendimento",
  assunto: "Nome do assunto identificado na triagem",
  tempo_aguardando: 'Tempo de espera formatado (ex: "1h 23min")',
  lista_departamentos: "Lista formatada dos departamentos ativos",
  lista_assuntos: "Lista formatada dos assuntos do departamento",
};

export const TEMPLATE_LABEL: Record<string, string> = {
  triagem_boas_vindas: "Boas-vindas",
  triagem_pergunta_departamento: "Pergunta de departamento",
  triagem_pergunta_assunto: "Pergunta de assunto",
  triagem_erro_formato: "Erro de formato (triagem)",
  triagem_lembrete_sem_resposta: "Lembrete na triagem sem resposta",
  notificacao_luana: "Notificação ao administrador",
  encerramento: "Encerramento",
  fora_horario: "Fora do horário",
  repasse: "Aviso de repasse",
};

export async function fetchTemplates(): Promise<TemplateRow[]> {
  const { data, error } = await supabase
    .from("templates_mensagem")
    .select("id, chave, texto, ativo, updated_at, updated_by")
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
    ativo: t.ativo,
    updated_at: t.updated_at,
    updated_by: t.updated_by,
    updated_by_nome: t.updated_by ? (nameMap.get(t.updated_by) ?? null) : null,
  }));
}

export async function updateTemplateTexto(id: string, texto: string) {
  const { data: auth } = await supabase.auth.getUser();
  const { error } = await supabase
    .from("templates_mensagem")
    .update({ texto, updated_by: auth.user?.id ?? null })
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

export type TempoUnit = "segundos" | "minutos" | ""; /* sem unidade */

export interface TempoMeta {
  chave: string;
  label: string;
  unit: TempoUnit;
  min: number;
  max: number;
}

export const TEMPOS: TempoMeta[] = [
  {
    chave: "delay_anti_flood_triagem",
    label: "Delay anti-flood da triagem",
    unit: "segundos",
    min: 1,
    max: 300,
  },
  {
    chave: "tempo_reserva_especialista",
    label: "Tempo de reserva do especialista",
    unit: "minutos",
    min: 1,
    max: 1440,
  },
  {
    chave: "tempo_reserva_ultimo_atendente",
    label: "Tempo de reserva do último atendente",
    unit: "minutos",
    min: 1,
    max: 1440,
  },
  {
    chave: "tempo_notificacao_luana",
    label: "Tempo até notificar o administrador",
    unit: "minutos",
    min: 1,
    max: 1440,
  },
  {
    chave: "intervalo_repeticao_notificacao_luana",
    label: "Intervalo de repetição da notificação ao administrador",
    unit: "minutos",
    min: 1,
    max: 1440,
  },
  {
    chave: "tempo_encerramento_automatico",
    label: "Tempo para encerramento automático",
    unit: "minutos",
    min: 1,
    max: 10080,
  },
  {
    chave: "tempo_novo_atendimento",
    label: "Tempo para considerar novo atendimento",
    unit: "minutos",
    min: 1,
    max: 1440,
  },
  {
    chave: "tempo_abandono_triagem",
    label: "Tempo de abandono na triagem",
    unit: "minutos",
    min: 1,
    max: 1440,
  },
  {
    chave: "triagem_max_tentativas",
    label: "Máx. de tentativas na triagem",
    unit: "",
    min: 1,
    max: 10,
  },
];

export interface TempoRow extends TempoMeta {
  valor: number;
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
    return {
      ...meta,
      valor: row?.valor ? Number(row.valor) : 0,
      descricao: row?.descricao ?? null,
    };
  });
}

export async function updateTempo(chave: string, valor: number) {
  const { data: auth } = await supabase.auth.getUser();
  const { error } = await supabase
    .from("system_config")
    .update({ valor: String(valor), updated_by: auth.user?.id ?? null })
    .eq("chave", chave);
  if (error) throw error;
}

// ============ Roteamento (especialista_routing) ============

export interface RoutingRow {
  id: string;
  ativo: boolean;
  subject_id: string;
  subject_nome: string;
  subject_dept_nome: string;
  subject_dept_cor: string;
  user_id: string;
  user_nome: string;
  user_dept_nome: string;
  user_dept_cor: string;
}

export async function fetchRoutings(): Promise<RoutingRow[]> {
  const { data, error } = await supabase
    .from("especialista_routing")
    .select(
      "id, ativo, subject_id, user_id, subjects:subject_id(nome, departments:department_id(nome, cor)), users!especialista_routing_user_id_fkey(nome, departments:department_id(nome, cor))",
    )
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((r) => {
    const s = r.subjects as unknown as {
      nome: string;
      departments: { nome: string; cor: string } | null;
    } | null;
    const u = r.users as unknown as {
      nome: string;
      departments: { nome: string; cor: string } | null;
    } | null;
    return {
      id: r.id,
      ativo: r.ativo,
      subject_id: r.subject_id,
      subject_nome: s?.nome ?? "—",
      subject_dept_nome: s?.departments?.nome ?? "—",
      subject_dept_cor: s?.departments?.cor ?? FALLBACK_COR,
      user_id: r.user_id,
      user_nome: u?.nome ?? "—",
      user_dept_nome: u?.departments?.nome ?? "—",
      user_dept_cor: u?.departments?.cor ?? FALLBACK_COR,
    };
  });
}

export async function fetchSubjectsAtivos() {
  const { data, error } = await supabase
    .from("subjects")
    .select("id, nome, departments:department_id(nome, cor)")
    .eq("ativo", true)
    .order("nome");
  if (error) throw error;
  return (data ?? []).map((s) => {
    const d = s.departments as { nome: string; cor: string } | null;
    return {
      id: s.id,
      nome: s.nome,
      department_nome: d?.nome ?? "—",
      department_cor: d?.cor ?? FALLBACK_COR,
    };
  });
}

export async function fetchUsersAtivos() {
  const { data, error } = await supabase
    .from("users")
    .select("id, nome, departments:department_id(nome, cor)")
    .eq("is_system_user", false)
    .eq("ativo", true)
    .order("nome");
  if (error) throw error;
  return (data ?? []).map((u) => {
    const d = u.departments as { nome: string; cor: string } | null;
    return {
      id: u.id,
      nome: u.nome,
      department_nome: d?.nome ?? "—",
      department_cor: d?.cor ?? FALLBACK_COR,
    };
  });
}

export async function createRouting(input: { subject_id: string; user_id: string }) {
  const { data: auth } = await supabase.auth.getUser();
  const { error } = await supabase.from("especialista_routing").insert({
    subject_id: input.subject_id,
    user_id: input.user_id,
    ativo: true,
    created_by: auth.user?.id ?? null,
  });
  if (error) {
    if (error.code === "23505" || /unique|duplicate/i.test(error.message)) {
      throw new Error("Já existe um roteamento ativo para este assunto.");
    }
    throw error;
  }
}

export async function updateRouting(id: string, input: { user_id?: string; ativo?: boolean }) {
  const patch: { user_id?: string; ativo?: boolean } = {};
  if (input.user_id !== undefined) patch.user_id = input.user_id;
  if (input.ativo !== undefined) patch.ativo = input.ativo;
  const { error } = await supabase.from("especialista_routing").update(patch).eq("id", id);
  if (error) {
    if (error.code === "23505" || /unique|duplicate/i.test(error.message)) {
      throw new Error("Já existe um roteamento ativo para este assunto.");
    }
    throw error;
  }
}

export async function deleteRouting(id: string) {
  const { error } = await supabase.from("especialista_routing").delete().eq("id", id);
  if (error) throw error;
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
