// Edge Function: mensagem-acao
// Apagar para todos e editar mensagem já enviada — os dois recursos nativos do
// WhatsApp, expostos pela uazapi em POST /message/delete e POST /message/edit.
//
// Contrato com o frontend:
//   POST { acao: "apagar", mensagem_ids: string[] }   (1..10 ids)
//     → 200 { ok: true, resultados: [{ mensagem_id, ok, motivo?, detalhe? }] }
//   POST { acao: "editar", mensagem_id: string, texto: string }
//     → 200 { ok: true, mensagem_id, editada_em, conteudo }
//     → 200 { ok: false, motivo, detalhe }   (recusa de negócio, não erro HTTP)
//
// Duas decisões que valem explicação:
//
// 1. SÍNCRONO, ao contrário do send-whatsapp-message. Lá a resposta rápida vale
//    mais que o desfecho (a bolha já está na tela em "enviando"). Aqui o produto
//    pede o oposto: quem clicou precisa saber AGORA se aquela mensagem foi
//    apagada ou se o prazo do WhatsApp já tinha passado. Por isso o lote é
//    pequeno e existe um prazo interno (ORCAMENTO_MS) — o que não couber volta
//    como "tempo_esgotado" em vez de ficar sem resposta.
//
// 2. A JANELA É REVALIDADA AQUI. O frontend também sabe as regras (para
//    desabilitar o botão), mas ele não é autoridade: o relógio dele pode estar
//    errado e a requisição pode ser forjada. Fonte da verdade: ./_shared/janelas-whatsapp.ts.

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";
import { exigirMembroAtivo } from "../_shared/empresa.ts";
import {
  deletarMensagem,
  editarMensagem,
  ZapiError,
} from "../_shared/uazapi-client.ts";
import {
  type AcaoMensagem,
  avaliarAcao,
  type MensagemAvaliavel,
  type MotivoBloqueio,
} from "../_shared/janelas-whatsapp.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const FUNCAO = "mensagem-acao";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** Teto do lote. Cada item é uma ida à uazapi; lote grande estoura o prazo. */
const MAX_IDS_POR_LOTE = 10;

/**
 * Prazo interno do lote. A uazapi tem timeout de 20s por requisição, então um
 * lote cheio de chamadas lentas passaria de 3 minutos e o navegador desistiria
 * antes — sem resposta, o atendente não saberia o que foi apagado e o que não.
 *
 * O laço só COMEÇA um item se ainda couber PIOR_CASO_CHAMADA_MS, então o teto
 * real da resposta é este valor: aceita novos itens até ~25s e o último pode
 * levar mais 20s.
 */
const ORCAMENTO_MS = 45_000;

/**
 * Pior caso de UMA chamada à uazapi: REQUEST_TIMEOUT_MS do uazapi-client. O
 * orçamento é conferido ANTES de cada item, então sem descontar isso o último
 * item aceito ainda poderia estourar muito além de ORCAMENTO_MS.
 */
const PIOR_CASO_CHAMADA_MS = 20_000;

const MAX_TEXTO_EDICAO = 4_096;
const BUCKET_MIDIA = "mensagens-midia";

/**
 * Teto por atendente por hora. O limite de 10 por lote é da requisição, não da
 * pessoa: um loop de requisições apagaria tudo que a empresa mandou nas últimas
 * 60h, sem volta. Aqui não existe "tentar de novo depois" que conserte, então o
 * teto é bem abaixo de qualquer uso legítimo (corrigir um punhado de mensagens).
 */
const MAX_APAGADAS_POR_HORA = 40;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Janela em que a linha do eco da edição pode ser considerada duplicata. O eco
 * chega segundos depois da chamada; qualquer coisa mais antiga com aquele id é
 * outra mensagem, e apagar seria perda de dado.
 */
const JANELA_ECO_MS = 120_000;

/** Motivos que não vêm da avaliação de janela, e sim da execução. */
type MotivoExecucao =
  | "falha_whatsapp"
  | "tempo_esgotado"
  | "mensagem_nao_encontrada"
  | "sem_permissao";

type Motivo = MotivoBloqueio | MotivoExecucao | "limite_por_hora";

interface ResultadoItem {
  mensagem_id: string;
  ok: boolean;
  motivo?: Motivo;
  detalhe?: string;
}

interface LinhaMensagem {
  id: string;
  atendimento_id: string;
  company_id: string;
  created_at: string;
  direction: string;
  sender_type: string;
  tipo: string;
  status_envio: string;
  apagada_em: string | null;
  zapi_message_id: string | null;
  content: string | null;
  media_metadata: Record<string, unknown> | null;
}

const COLUNAS_MENSAGEM =
  "id, atendimento_id, company_id, created_at, direction, sender_type, tipo, status_envio, apagada_em, zapi_message_id, content, media_metadata";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

/** Erro técnico da uazapi → frase curta para o atendente. */
function detalheFalha(err: unknown): string {
  if (err instanceof ZapiError) {
    if (err.status === 404) return "O WhatsApp não encontrou mais essa mensagem.";
    if (err.status === 429) return "WhatsApp ocupado (limite de requisições). Tente de novo.";
    if (err.status === 401 || err.status === 403) {
      return "WhatsApp recusou a credencial (verifique a conexão).";
    }
    if (err.status >= 500) return "WhatsApp indisponível.";
    try {
      const j = JSON.parse(err.body) as { error?: string; message?: string };
      const msg = j.error ?? j.message;
      if (typeof msg === "string" && msg.trim()) return msg.slice(0, 140);
    } catch {
      // corpo não-JSON: cai no genérico
    }
    return `WhatsApp recusou a operação (HTTP ${err.status}).`;
  }
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || /timeout|abort/i.test(err.message)) {
      return "Tempo esgotado falando com o WhatsApp.";
    }
  }
  // Genérico de propósito: `err.message` de falha de fetch costuma carregar a
  // URL da uazapi, e isso não tem por que aparecer na tela do atendente. O
  // detalhe técnico fica no log.
  return "Não conseguimos falar com o WhatsApp.";
}

function paraAvaliavel(m: LinhaMensagem): MensagemAvaliavel {
  const meta = m.media_metadata as { kind?: string; origem?: string } | null;
  return {
    criadaEm: m.created_at,
    direction: m.direction,
    senderType: m.sender_type,
    tipo: m.tipo,
    statusEnvio: m.status_envio,
    apagadaEm: m.apagada_em,
    temIdWhatsapp: !!m.zapi_message_id,
    ehListaOpcoes: meta?.kind === "lista_opcoes",
    // `origem` só existe nas linhas 'externo' e é gravada exclusivamente pelo
    // webhook — ver a trava de media_metadata em
    // protect_mensagem_immutable_fields. É ela que libera apagar o que saiu do
    // celular da empresa sem liberar o que o outro sistema mandou.
    origemExterna: typeof meta?.origem === "string" ? meta.origem : null,
  };
}

/**
 * Quais atendimentos este usuário pode mexer.
 *
 * Mesma régua do send-whatsapp-message: o responsável, ou quem é superadmin, ou
 * quem tem 'force_close'. Coerente por construção — quem pode ENVIAR em nome do
 * atendimento pode desfazer o que foi enviado.
 */
async function atendimentosPermitidos(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  atendimentoIds: string[],
): Promise<Set<string>> {
  const [{ data: userRow }, { data: permRow }, { data: atends }] = await Promise.all([
    supabase.from("users").select("is_superadmin").eq("id", userId).maybeSingle(),
    supabase
      .from("user_permissions")
      .select("permission")
      .eq("user_id", userId)
      .eq("permission", "force_close")
      .maybeSingle(),
    // company_id aqui é defesa em profundidade: as mensagens já vêm filtradas
    // por empresa, mas o cliente é service_role (RLS não ajuda) e não convém que
    // o isolamento multiempresa dependa de um único filtro.
    supabase
      .from("atendimentos")
      .select("id, assigned_to")
      .eq("company_id", companyId)
      .in("id", atendimentoIds),
  ]);

  const bypass = userRow?.is_superadmin === true || !!permRow;
  const permitidos = new Set<string>();
  for (const a of atends ?? []) {
    if (bypass || a.assigned_to === userId) permitidos.add(a.id as string);
  }
  return permitidos;
}

/**
 * Esvazia o conteúdo da mensagem apagada.
 *
 * Some com media_url e storage_path para nenhuma tela do sistema conseguir
 * renderizar o que o cliente não vê mais, e guarda `apagada: true` no metadata
 * para o histórico registrar que ali havia algo. O arquivo no bucket é removido
 * em seguida (best-effort) — falhar nisso não desfaz o apagar, só deixa um
 * órfão em bucket privado.
 */
function metadataAposApagar(meta: Record<string, unknown> | null): Record<string, unknown> {
  const { storage_path: _descartado, ...resto } = meta ?? {};
  return { ...resto, apagada: true };
}

async function removerArquivoDoBucket(
  supabase: SupabaseClient,
  meta: Record<string, unknown> | null,
): Promise<void> {
  const path = typeof meta?.storage_path === "string" ? meta.storage_path : null;
  if (!path) return;
  const { error } = await supabase.storage.from(BUCKET_MIDIA).remove([path]);
  if (error) {
    log({
      funcao: FUNCAO,
      evento: "remocao_arquivo_falhou",
      status: "erro",
      erro_msg: error.message,
    });
  }
}

// ————————————————————————————————————————————————————————————————
// APAGAR PARA TODOS
// ————————————————————————————————————————————————————————————————

async function apagarUma(
  supabase: SupabaseClient,
  userId: string,
  m: LinhaMensagem,
): Promise<ResultadoItem> {
  const elegivel = avaliarAcao("apagar", paraAvaliavel(m), Date.now());
  if (!elegivel.pode) return { mensagem_id: m.id, ok: false, motivo: elegivel.motivo };

  try {
    await deletarMensagem({ zapiMessageId: m.zapi_message_id as string });
  } catch (err) {
    log({
      funcao: FUNCAO,
      evento: "apagar_uazapi_falhou",
      status: "erro",
      mensagem_id: m.id,
      erro_msg: err instanceof Error ? err.message : String(err),
      extra: { uazapi_status: err instanceof ZapiError ? err.status : null },
    });
    return {
      mensagem_id: m.id,
      ok: false,
      motivo: "falha_whatsapp",
      detalhe: detalheFalha(err),
    };
  }

  // Apagou no WhatsApp. Daqui para baixo, falha de banco não desfaz nada — o
  // webhook `messages_update` com status Deleted carimba a linha de qualquer
  // forma, então o pior caso é a bolha demorar um instante para mudar.
  const { error } = await supabase
    .from("mensagens")
    .update({
      apagada_em: new Date().toISOString(),
      apagada_por_user_id: userId,
      content: null,
      media_url: null,
      // Guarda o que o cliente viu antes de o conteúdo sumir. É a única coisa
      // que sobra para responder "o que foi mandado?" depois de um apagar.
      conteudo_anterior: m.content,
      media_metadata: metadataAposApagar(m.media_metadata),
    })
    .eq("id", m.id)
    .eq("company_id", m.company_id)
    .is("apagada_em", null);

  if (error) {
    log({
      funcao: FUNCAO,
      evento: "apagar_update_falhou",
      status: "erro",
      mensagem_id: m.id,
      erro_msg: error.message,
    });
  }

  await removerArquivoDoBucket(supabase, m.media_metadata);

  // `sender_type` + `origem` no log porque agora existe um caso em que quem
  // apaga NÃO é quem escreveu: mensagem que saiu do celular da empresa. Sem
  // isso não dá para auditar depois o que foi apagado vindo de fora do sistema.
  log({
    funcao: FUNCAO,
    evento: "mensagem_apagada",
    status: "ok",
    mensagem_id: m.id,
    extra: {
      sender_type: m.sender_type,
      origem: (m.media_metadata as { origem?: string } | null)?.origem ?? null,
    },
  });
  return { mensagem_id: m.id, ok: true };
}

// ————————————————————————————————————————————————————————————————
// EDITAR
// ————————————————————————————————————————————————————————————————

/**
 * Grava o texto novo, o carimbo de edição e o ID NOVO que o WhatsApp gerou.
 *
 * O id novo é obrigatório para a mensagem continuar viva: é ele que os eventos
 * seguintes de status e o apagar-depois vão citar. Só que o eco da própria
 * edição volta pelo webhook com esse mesmo id, e se chegar antes deste UPDATE
 * ele insere uma linha nova (duas bolhas iguais na tela) e o UNIQUE derruba o
 * UPDATE. Nesse caso a linha do eco é removida — ela é, por construção, a
 * duplicata da mensagem que acabamos de editar — e o UPDATE é repetido.
 */
async function gravarEdicao(
  supabase: SupabaseClient,
  m: LinhaMensagem,
  texto: string,
  novoId: string | null,
): Promise<{ ok: boolean; editadaEm: string; erro?: string }> {
  const editadaEm = new Date().toISOString();
  const patch: Record<string, unknown> = {
    content: texto,
    editada_em: editadaEm,
    // Trilha: sem isto a edição apagaria para sempre o texto que o cliente já
    // tinha lido.
    conteudo_anterior: m.content,
  };
  if (novoId && novoId !== m.zapi_message_id) patch.zapi_message_id = novoId;

  const primeira = await supabase.from("mensagens").update(patch).eq("id", m.id)
    .eq("company_id", m.company_id);
  if (!primeira.error) return { ok: true, editadaEm };

  const ehUnique = primeira.error.code === "23505" ||
    /duplicate key/i.test(primeira.error.message);
  if (!ehUnique || !novoId) {
    return { ok: false, editadaEm, erro: primeira.error.message };
  }

  const { data: eco } = await supabase
    .from("mensagens")
    .select("id, sender_type, atendimento_id, created_at")
    .eq("zapi_message_id", novoId)
    .neq("id", m.id)
    .maybeSingle();

  // Três condições, não uma. Este é o único DELETE físico em `mensagens` do
  // sistema, e o alvo vem de um id devolvido pela uazapi — a premissa "é a
  // duplicata da edição" tem que ser verificada, não assumida. Recente porque o
  // eco chega em segundos: qualquer linha mais velha com aquele id é outra
  // mensagem, e apagá-la seria perda de dado irreversível.
  const ecoRecente = !!eco &&
    Date.now() - new Date(eco.created_at as string).getTime() < JANELA_ECO_MS;

  if (eco && ecoRecente && eco.sender_type === "externo" &&
      eco.atendimento_id === m.atendimento_id) {
    const { error: errDel } = await supabase
      .from("mensagens")
      .delete()
      .eq("id", eco.id)
      .eq("company_id", m.company_id);
    if (errDel) {
      // Sem isto o código seguia como se tivesse apagado, o segundo UPDATE
      // falhava igual e a duplicata ficava na conversa sem nenhum registro de
      // por quê.
      log({
        funcao: FUNCAO,
        evento: "eco_da_edicao_remocao_falhou",
        status: "erro",
        mensagem_id: m.id,
        erro_msg: errDel.message,
        extra: { eco_id: eco.id },
      });
    } else {
      log({
        funcao: FUNCAO,
        evento: "eco_da_edicao_removido",
        status: "ok",
        mensagem_id: m.id,
        extra: { eco_id: eco.id },
      });
      const segunda = await supabase
        .from("mensagens")
        .update(patch)
        .eq("id", m.id)
        .eq("company_id", m.company_id);
      if (!segunda.error) return { ok: true, editadaEm };
    }
  } else if (eco) {
    log({
      funcao: FUNCAO,
      evento: "eco_da_edicao_nao_reconhecido",
      status: "erro",
      mensagem_id: m.id,
      extra: { eco_id: eco.id, recente: ecoRecente, sender_type: eco.sender_type },
    });
  }

  // Último recurso: grava texto e carimbo mantendo o id antigo. A mensagem fica
  // correta na tela; o que se perde é o vínculo com os próximos eventos dela.
  const semId = await supabase
    .from("mensagens")
    .update({ content: texto, editada_em: editadaEm, conteudo_anterior: m.content })
    .eq("id", m.id)
    .eq("company_id", m.company_id);
  log({
    funcao: FUNCAO,
    evento: "edicao_sem_trocar_id",
    status: "erro",
    mensagem_id: m.id,
    erro_msg: primeira.error.message,
  });
  return semId.error
    ? { ok: false, editadaEm, erro: semId.error.message }
    : { ok: true, editadaEm };
}

async function editarUma(
  supabase: SupabaseClient,
  m: LinhaMensagem,
  texto: string,
): Promise<{ resposta: unknown; status: number }> {
  const elegivel = avaliarAcao("editar", paraAvaliavel(m), Date.now());
  if (!elegivel.pode) {
    return { resposta: { ok: false, motivo: elegivel.motivo }, status: 200 };
  }

  let novoId: string | null = null;
  try {
    const r = await editarMensagem({ zapiMessageId: m.zapi_message_id as string, texto });
    novoId = r.novoId;
  } catch (err) {
    log({
      funcao: FUNCAO,
      evento: "editar_uazapi_falhou",
      status: "erro",
      mensagem_id: m.id,
      erro_msg: err instanceof Error ? err.message : String(err),
      extra: { uazapi_status: err instanceof ZapiError ? err.status : null },
    });
    return {
      resposta: { ok: false, motivo: "falha_whatsapp", detalhe: detalheFalha(err) },
      status: 200,
    };
  }

  const gravado = await gravarEdicao(supabase, m, texto, novoId);
  if (!gravado.ok) {
    // Editou no WhatsApp mas não no banco: a tela ficaria mostrando o texto
    // antigo de uma mensagem que o cliente já vê diferente. É erro nosso, e 500
    // é o único jeito honesto de dizer isso.
    log({
      funcao: FUNCAO,
      evento: "editar_update_falhou",
      status: "erro",
      mensagem_id: m.id,
      erro_msg: gravado.erro,
    });
    return {
      resposta: {
        ok: false,
        motivo: "falha_whatsapp",
        detalhe: "A mensagem foi editada no WhatsApp, mas não conseguimos atualizar aqui.",
      },
      status: 500,
    };
  }

  log({
    funcao: FUNCAO,
    evento: "mensagem_editada",
    status: "ok",
    mensagem_id: m.id,
    extra: { trocou_id: !!novoId && novoId !== m.zapi_message_id },
  });
  return {
    resposta: {
      ok: true,
      mensagem_id: m.id,
      editada_em: gravado.editadaEm,
      conteudo: texto,
    },
    status: 200,
  };
}

// ————————————————————————————————————————————————————————————————
// HANDLER
// ————————————————————————————————————————————————————————————————

interface Payload {
  acao?: string;
  mensagem_ids?: unknown;
  mensagem_id?: unknown;
  texto?: unknown;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, erro: "method_not_allowed" }, 405);
  }

  const cron = iniciarCronometro();
  const supabase = getSupabaseAdmin();

  // 1) Autenticação.
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  if (!jwt) return jsonResponse({ ok: false, erro: "unauthorized" }, 401);

  const { data: userRes, error: errUser } = await supabase.auth.getUser(jwt);
  if (errUser || !userRes?.user) {
    log({
      funcao: FUNCAO,
      evento: "token_invalido",
      status: "erro",
      duracao_ms: cron(),
      erro_msg: errUser?.message,
    });
    return jsonResponse({ ok: false, erro: "unauthorized" }, 401);
  }
  const userId = userRes.user.id;

  // 2) Payload.
  let payload: Payload;
  try {
    payload = (await req.json()) as Payload;
  } catch {
    return jsonResponse({ ok: false, erro: "payload_invalido" }, 400);
  }

  const acao = payload.acao === "apagar" || payload.acao === "editar"
    ? (payload.acao as AcaoMensagem)
    : null;
  if (!acao) {
    return jsonResponse(
      { ok: false, erro: "payload_invalido", detalhe: "acao deve ser 'apagar' ou 'editar'" },
      400,
    );
  }

  let ids: string[];
  let textoEdicao = "";
  if (acao === "apagar") {
    const brutos = Array.isArray(payload.mensagem_ids) ? payload.mensagem_ids : [];
    // Exige UUID válido. Sem isso um id malformado faz o `.in()` estourar 22P02
    // e o lote INTEIRO volta 500 — derrubando os ids válidos junto.
    ids = Array.from(
      new Set(brutos.filter((v): v is string => typeof v === "string" && UUID_RE.test(v.trim()))),
    );
    if (ids.length === 0) {
      return jsonResponse(
        { ok: false, erro: "payload_invalido", detalhe: "mensagem_ids é obrigatório" },
        400,
      );
    }
    if (ids.length > MAX_IDS_POR_LOTE) {
      return jsonResponse(
        {
          ok: false,
          erro: "lote_grande",
          detalhe: `Apague no máximo ${MAX_IDS_POR_LOTE} mensagens por vez.`,
        },
        400,
      );
    }
  } else {
    const id = typeof payload.mensagem_id === "string" && UUID_RE.test(payload.mensagem_id.trim())
      ? payload.mensagem_id.trim()
      : "";
    textoEdicao = typeof payload.texto === "string" ? payload.texto.trim() : "";
    if (!id || !textoEdicao) {
      return jsonResponse(
        { ok: false, erro: "payload_invalido", detalhe: "mensagem_id e texto são obrigatórios" },
        400,
      );
    }
    if (textoEdicao.length > MAX_TEXTO_EDICAO) {
      return jsonResponse(
        { ok: false, erro: "payload_invalido", detalhe: "Texto muito longo." },
        400,
      );
    }
    ids = [id];
  }

  // 3) Empresa do usuário — nenhuma mensagem de outra empresa entra no lote.
  const membro = await exigirMembroAtivo(supabase, userId);
  if (!membro) return jsonResponse({ ok: false, erro: "forbidden" }, 403);

  // 4) Carrega as mensagens.
  const { data: linhas, error: errLinhas } = await supabase
    .from("mensagens")
    .select(COLUNAS_MENSAGEM)
    .in("id", ids)
    .eq("company_id", membro.companyId);

  if (errLinhas) {
    log({
      funcao: FUNCAO,
      evento: "leitura_mensagens",
      status: "erro",
      duracao_ms: cron(),
      erro_msg: errLinhas.message,
    });
    return jsonResponse({ ok: false, erro: "erro_interno" }, 500);
  }

  const porId = new Map<string, LinhaMensagem>();
  for (const l of (linhas ?? []) as unknown as LinhaMensagem[]) porId.set(l.id, l);

  // 5) Autorização por atendimento.
  const atendimentoIds = Array.from(new Set(Array.from(porId.values()).map((l) => l.atendimento_id)));
  const permitidos = atendimentoIds.length > 0
    ? await atendimentosPermitidos(supabase, userId, membro.companyId, atendimentoIds)
    : new Set<string>();

  // 6) Executa. A edição é sempre uma só; apagar percorre o lote na ordem
  //    recebida, respeitando o prazo interno.
  if (acao === "editar") {
    const m = porId.get(ids[0]);
    if (!m) return jsonResponse({ ok: false, motivo: "mensagem_nao_encontrada" }, 404);
    if (!permitidos.has(m.atendimento_id)) {
      return jsonResponse({ ok: false, motivo: "sem_permissao" }, 403);
    }
    const { resposta, status } = await editarUma(supabase, m, textoEdicao);
    return jsonResponse(resposta, status);
  }

  // Quantas este atendente já apagou na última hora. Apagar não tem volta, então
  // o freio é antes, não depois.
  const umaHoraAtras = new Date(Date.now() - 3_600_000).toISOString();
  const { count: apagadasNaHora } = await supabase
    .from("mensagens")
    .select("id", { count: "exact", head: true })
    .eq("apagada_por_user_id", userId)
    .gte("apagada_em", umaHoraAtras);

  let orcamentoRestante = Math.max(0, MAX_APAGADAS_POR_HORA - (apagadasNaHora ?? 0));

  const limite = Date.now() + ORCAMENTO_MS;
  const resultados: ResultadoItem[] = [];
  for (const id of ids) {
    const m = porId.get(id);
    if (!m) {
      resultados.push({ mensagem_id: id, ok: false, motivo: "mensagem_nao_encontrada" });
      continue;
    }
    if (!permitidos.has(m.atendimento_id)) {
      resultados.push({ mensagem_id: id, ok: false, motivo: "sem_permissao" });
      continue;
    }
    if (orcamentoRestante <= 0) {
      resultados.push({ mensagem_id: id, ok: false, motivo: "limite_por_hora" });
      continue;
    }
    // Desconta o pior caso: se o que resta do orçamento não cabe uma chamada
    // inteira, não começa — melhor devolver "tempo esgotado" do que deixar o
    // navegador desistir e o atendente sem saber o que foi apagado.
    if (Date.now() + PIOR_CASO_CHAMADA_MS > limite) {
      resultados.push({ mensagem_id: id, ok: false, motivo: "tempo_esgotado" });
      continue;
    }
    const r = await apagarUma(supabase, userId, m);
    if (r.ok) orcamentoRestante -= 1;
    resultados.push(r);
  }

  log({
    funcao: FUNCAO,
    evento: "lote_apagar_concluido",
    status: "ok",
    duracao_ms: cron(),
    extra: {
      pedidas: ids.length,
      apagadas: resultados.filter((r) => r.ok).length,
    },
  });

  return jsonResponse({ ok: true, resultados });
});
