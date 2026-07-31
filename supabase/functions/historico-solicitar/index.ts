// Edge Function: historico-solicitar
//
// PEDE ao WhatsApp as mensagens ANTERIORES ao dia em que o sistema começou a
// gravar. Quem GRAVA é a webhook-historico: /message/history-sync é assíncrono,
// as mensagens voltam depois no evento `history` do webhook.
//
// Por que não usar o backfill que já existe: backfill-mensagens-externas lê
// POST /message/find, e a uazapi só guarda 7 dias ("mensagens mais antigas do
// que 7 dias são excluídas durante a madrugada", doc de /instance/connect).
// Para alcançar o passado, o pedido tem que ir ao WhatsApp.
//
// Como funciona, por cliente:
//   1. acha a mensagem MAIS ANTIGA que já temos dele (é o "dia X" dele);
//   2. abre um pedido em historico_import_pedidos com a janela [desde, ate);
//   3. chama /message/history-sync com essa mensagem como âncora.
// Rodar de novo depois anda mais para trás: a âncora passa a ser a mensagem
// mais antiga já importada.
//
// Contrato:
//   POST { dias?, limite_clientes?, offset?, count?, janela_horas?, dry_run?,
//          registrar_webhook?, incluir_colaboradores? }
//   → { ok, dry_run, clientes_analisados, pedidos, proximo_offset, tem_mais, ... }
//
// PRÉ-REQUISITO: o celular precisa estar com o WhatsApp aberto (ou ativo em
// segundo plano) para o WhatsApp entregar o histórico. E ele só devolve o que
// ainda existe no aparelho.

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";
import {
  garantirWebhookHistorico,
  solicitarHistoricoChat,
  UazapiError,
  verWebhook,
} from "../_shared/uazapi-client.ts";
import { buscarMensagensDoChat } from "../_shared/uazapi-client.ts";
import { chatIdDoNumero, inteiroNoIntervalo, messageidCru } from "../_shared/historico.ts";

const FUNCAO = "historico-solicitar";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DIAS_PADRAO = 30;
const DIAS_MAX = 365;
const LIMITE_CLIENTES_PADRAO = 25;
const LIMITE_CLIENTES_MAX = 100;
const COUNT_PADRAO = 100; // teto da uazapi
const JANELA_HORAS_PADRAO = 12;
const JANELA_HORAS_MAX = 72;
// Cada cliente é 1 chamada à uazapi. Poucos em paralelo: um pedido de histórico
// põe carga no celular do outro lado, não só na API.
const CONCORRENCIA = 3;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function comparaConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface Payload {
  /** Diagnóstico: devolve os webhooks registrados na uazapi e para aí. */
  ver_webhook?: boolean;
  /** Diagnóstico: lista o que a uazapi TEM deste chat (janela de datas). */
  ver_chat?: string;
  dias?: number;
  limite_clientes?: number;
  offset?: number;
  count?: number;
  janela_horas?: number;
  dry_run?: boolean;
  registrar_webhook?: boolean;
  incluir_colaboradores?: boolean;
}

interface ClienteAlvo {
  id: string;
  company_id: string;
  numero: string;
}

interface ResultadoCliente {
  client_id: string;
  chatid: string;
  ate?: string;
  desde?: string;
  ancora?: string | null;
  pedido: boolean;
  motivo?: string;
  erro?: string;
}

/**
 * Clientes que já têm atendimento — são os únicos onde o histórico tem onde
 * encaixar (`mensagens.atendimento_id` é NOT NULL, e importar não cria
 * atendimento retroativo).
 */
async function clientesComAtendimento(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  incluirColaboradores: boolean,
): Promise<ClienteAlvo[]> {
  const { data, error } = await supabase
    .from("atendimentos")
    .select("client_id, created_at, clients:client_id(numero_whatsapp, company_id)")
    .order("created_at", { ascending: true })
    .limit(5000);
  if (error) throw new Error(`select_atendimentos: ${error.message}`);

  // Números de colaborador ficam de fora por padrão: o histórico deles é cheio
  // de notificação interna do sistema ("Novo atendimento pra você"), que não é
  // conversa com cliente. Mesmo critério do backfill de mensagens externas.
  const numerosInternos = new Set<string>();
  if (!incluirColaboradores) {
    const { data: users } = await supabase
      .from("users")
      .select("whatsapp")
      .not("whatsapp", "is", null);
    for (const u of (users ?? []) as { whatsapp: string | null }[]) {
      const d = String(u.whatsapp ?? "").replace(/\D/g, "");
      if (d) numerosInternos.add(d);
    }
  }

  const vistos = new Set<string>();
  const alvos: ClienteAlvo[] = [];
  for (const linha of (data ?? []) as unknown as {
    client_id: string;
    clients: { numero_whatsapp?: string; company_id?: string } | null;
  }[]) {
    const id = linha.client_id;
    if (!id || vistos.has(id)) continue;
    vistos.add(id);
    const numero = (linha.clients?.numero_whatsapp ?? "").replace(/\D/g, "");
    const companyId = linha.clients?.company_id ?? "";
    if (!numero || !companyId) continue;
    if (numerosInternos.has(numero)) continue;
    alvos.push({ id, company_id: companyId, numero });
  }
  return alvos;
}

async function processarCliente(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  cliente: ClienteAlvo,
  dias: number,
  count: number,
  janelaHoras: number,
  dryRun: boolean,
): Promise<ResultadoCliente> {
  const chatid = chatIdDoNumero(cliente.numero);
  if (!chatid) return { client_id: cliente.id, chatid: "", pedido: false, motivo: "numero_invalido" };

  // "Dia X" deste cliente = a mensagem mais antiga que temos dele. É daí que o
  // pedido anda para trás. Numa segunda rodada isso já inclui o que foi
  // importado, então a âncora naturalmente recua.
  const { data: maisAntiga, error: errMsg } = await supabase
    .from("mensagens")
    .select("created_at, zapi_message_id, direction")
    .eq("client_id", cliente.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (errMsg) {
    return { client_id: cliente.id, chatid, pedido: false, erro: `select_mensagens: ${errMsg.message.slice(0, 100)}` };
  }
  if (!maisAntiga?.created_at) {
    // Sem nenhuma mensagem não há teto para a janela nem âncora: pular é melhor
    // que puxar histórico solto que não sabemos onde encaixar.
    return { client_id: cliente.id, chatid, pedido: false, motivo: "sem_mensagem_base" };
  }

  const ate = new Date(maisAntiga.created_at as string).toISOString();
  const desde = new Date(Date.parse(ate) - dias * 24 * 60 * 60 * 1000).toISOString();
  const ancora = messageidCru(maisAntiga.zapi_message_id as string | null);

  if (dryRun) {
    return { client_id: cliente.id, chatid, ate, desde, ancora, pedido: false, motivo: "dry_run" };
  }

  // O pedido é gravado ANTES da chamada: é ele que autoriza a webhook-historico
  // a aceitar o lote. Se gravássemos depois, um retorno rápido chegaria sem
  // pedido aberto e seria descartado.
  const expiraEm = new Date(Date.now() + janelaHoras * 60 * 60 * 1000).toISOString();
  const { data: pedidoRow, error: errPedido } = await supabase
    .from("historico_import_pedidos")
    .insert({
      company_id: cliente.company_id,
      client_id: cliente.id,
      chatid,
      ancora_messageid: ancora,
      desde,
      ate,
      expira_em: expiraEm,
    })
    .select("id")
    .maybeSingle();
  const pedidoId = (pedidoRow?.id as string | undefined) ?? "";
  if (errPedido) {
    return { client_id: cliente.id, chatid, pedido: false, erro: `insert_pedido: ${errPedido.message.slice(0, 100)}` };
  }

  try {
    await solicitarHistoricoChat({
      chatid,
      messageid: ancora,
      // A âncora que vale é o TIMESTAMP: o messageid antigo já não existe mais
      // no banco da uazapi (ela guarda 7 dias), e sozinho ele dá 400.
      timestampSegundos: Math.floor(Date.parse(ate) / 1000),
      fromMe: (maisAntiga.direction as string) === "outbound",
      count,
    });
  } catch (err) {
    // Pedido que não saiu não pode ficar com janela aberta: ela autorizaria a
    // webhook-historico a aceitar um lote que ninguém pediu.
    await supabase.from("historico_import_pedidos").delete().eq("id", pedidoId);
    const detalhe = err instanceof UazapiError && err.body ? ` — ${err.body.slice(0, 200)}` : "";
    return {
      client_id: cliente.id,
      chatid,
      ate,
      desde,
      ancora,
      pedido: false,
      erro: (err instanceof Error ? err.message.slice(0, 140) : "falha_uazapi") + detalhe,
    };
  }

  return { client_id: cliente.id, chatid, ate, desde, ancora, pedido: true };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ ok: false, erro: "method_not_allowed" }, 405);

  const cron = iniciarCronometro();
  const supabase = getSupabaseAdmin();

  // Autorização (mesma do backfill): secret de operador OU JWT de superadmin.
  // Isto abre janela para gravar mensagem com data e autoria arbitrárias —
  // atendente comum não passa.
  const segredoEsperado = Deno.env.get("BACKFILL_SECRET") ?? "";
  const segredoRecebido = req.headers.get("x-backfill-secret") ?? "";
  const ehOperador = segredoEsperado !== "" && comparaConstante(segredoRecebido, segredoEsperado);

  if (!ehOperador) {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
    if (!jwt) return jsonResponse({ ok: false, erro: "unauthorized" }, 401);
    const { data: userRes, error: errUser } = await supabase.auth.getUser(jwt);
    if (errUser || !userRes?.user) return jsonResponse({ ok: false, erro: "unauthorized" }, 401);
    const { data: quem } = await supabase
      .from("users")
      .select("is_superadmin, ativo")
      .eq("id", userRes.user.id)
      .maybeSingle();
    if (quem?.is_superadmin !== true || quem?.ativo !== true) {
      return jsonResponse({ ok: false, erro: "forbidden" }, 403);
    }
  }

  let payload: Payload = {};
  try {
    payload = ((await req.json()) ?? {}) as Payload;
  } catch {
    // sem corpo → padrões
  }

  const dias = inteiroNoIntervalo(payload.dias, DIAS_PADRAO, 1, DIAS_MAX);
  const limiteClientes = inteiroNoIntervalo(
    payload.limite_clientes,
    LIMITE_CLIENTES_PADRAO,
    1,
    LIMITE_CLIENTES_MAX,
  );
  const offset = inteiroNoIntervalo(payload.offset, 0, 0, 100000);
  const count = inteiroNoIntervalo(payload.count, COUNT_PADRAO, 1, 100);
  const janelaHoras = inteiroNoIntervalo(payload.janela_horas, JANELA_HORAS_PADRAO, 1, JANELA_HORAS_MAX);
  // dry_run é o PADRÃO: rodar sem querer não abre janela nem cutuca o celular.
  const dryRun = payload.dry_run !== false;
  const incluirColaboradores = payload.incluir_colaboradores === true;

  try {
    // Diagnóstico puro: sem isso, descobrir se o webhook de `history` ficou de
    // fato registrado exigiria o token da instância na mão de alguém.
    if (payload.ver_webhook === true) {
      return jsonResponse({ ok: true, webhooks: await verWebhook() });
    }

    // Diagnóstico: o que a uazapi tem deste chat agora. Serve para saber se o
    // history-sync já populou o banco dela (a doc diz que o resultado também
    // fica em /message/find) — se ficar, dá para ler de lá em vez de depender
    // da entrega do webhook.
    if (typeof payload.ver_chat === "string" && payload.ver_chat.trim() !== "") {
      const msgs = await buscarMensagensDoChat({ chatid: payload.ver_chat.trim(), limit: 200 });
      const datas = msgs
        .map((m) => (typeof m.messageTimestamp === "number" ? m.messageTimestamp : Number(m.messageTimestamp)))
        .filter((n) => Number.isFinite(n) && n > 0)
        .map((n) => new Date(n < 1e12 ? n * 1000 : n).toISOString())
        .sort();
      return jsonResponse({
        ok: true,
        total: msgs.length,
        mais_antiga: datas[0] ?? null,
        mais_nova: datas[datas.length - 1] ?? null,
      });
    }

    // Registro do webhook dedicado ao evento `history`. Sem ele o lote não chega
    // a lugar nenhum — a instância está registrada só com
    // ["messages","messages_update","connection"].
    let webhook: { criado: boolean; ja_existia: boolean } | { erro: string } | null = null;
    if (payload.registrar_webhook === true) {
      const base = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
      const url = `${base}/functions/v1/webhook-historico`;
      try {
        webhook = await garantirWebhookHistorico(url);
      } catch (err) {
        webhook = { erro: err instanceof Error ? err.message.slice(0, 140) : "falha_webhook" };
      }
    }

    const todos = await clientesComAtendimento(supabase, incluirColaboradores);
    const lote = todos.slice(offset, offset + limiteClientes);

    const resultados: ResultadoCliente[] = [];
    for (let i = 0; i < lote.length; i += CONCORRENCIA) {
      const fatia = lote.slice(i, i + CONCORRENCIA);
      const parciais = await Promise.all(
        fatia.map((c) => processarCliente(supabase, c, dias, count, janelaHoras, dryRun)),
      );
      resultados.push(...parciais);
    }

    const erros = resultados.filter((r) => r.erro);
    const resposta = {
      ok: true,
      dry_run: dryRun,
      dias,
      count,
      janela_horas: janelaHoras,
      webhook,
      clientes_analisados: lote.length,
      clientes_no_total: todos.length,
      proximo_offset: offset + lote.length,
      tem_mais: offset + lote.length < todos.length,
      pedidos: resultados.filter((r) => r.pedido).length,
      erros: erros.length,
      detalhes: resultados.slice(0, 60),
      aviso: dryRun
        ? "dry_run: nenhum pedido enviado. Rode com dry_run:false para pedir de verdade."
        : "Pedido enviado. As mensagens chegam depois, no evento `history` — mantenha o WhatsApp aberto no celular.",
    };

    log({
      funcao: FUNCAO,
      evento: "historico_solicitado",
      status: "ok",
      duracao_ms: cron(),
      extra: { dry_run: dryRun, clientes: lote.length, pedidos: resposta.pedidos, erros: erros.length },
    });

    return jsonResponse(resposta);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log({
      funcao: FUNCAO,
      evento: "erro_inesperado",
      status: "erro",
      duracao_ms: cron(),
      erro_msg: msg.slice(0, 200),
    });
    return jsonResponse({ ok: false, erro: "erro_interno" }, 500);
  }
});
