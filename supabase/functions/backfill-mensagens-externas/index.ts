// Edge Function: backfill-mensagens-externas
//
// Recupera as mensagens que o outro sistema (contabilidade) enviou pela MESMA
// instância uazapi enquanto o webhook ainda descartava os eventos
// `wasSentByApi`. Elas nunca chegaram no nosso banco: o cliente respondia e o
// atendente via a resposta sem a mensagem que a originou.
//
// Como funciona: para cada cliente com atendimento na janela, lê o histórico do
// chat na uazapi (`POST /message/find`), descarta o que já existe (pelo
// `zapi_message_id`) e grava o que falta — com
// `created_at` = hora REAL da mensagem no WhatsApp, para ela aparecer no lugar
// certo da conversa, e não no fim.
//
// Também recupera mensagens RECEBIDAS (`incluir_inbound: true`). Elas sempre
// foram gravadas pelo webhook, MENOS quando ele errava ao resolver o cliente —
// foi o que aconteceu com um número que tinha registro duplicado nas duas formas
// brasileiras (com/sem nono dígito): o webhook devolvia
// `conflito_identidade_cliente` e descartava a mensagem em silêncio.
//
// Contrato:
//   POST { dias?, limite_clientes?, offset?, dry_run?, incluir_inbound?, client_id? }
//   (Authorization: JWT de superadmin)
//   → { ok, dry_run, clientes_analisados, proximo_offset, tem_mais, encontradas,
//       inseridas, puladas, erros, detalhes[] }
//
// Idempotente: rodar duas vezes não duplica (o UNIQUE de zapi_message_id e a
// checagem prévia barram). Comece com dry_run:true para ver o que viria.
//
// NÃO cria cliente nem atendimento: se a mensagem antiga não tem onde encaixar,
// ela é pulada. Backfill é para dar contexto a conversas que existem, não para
// inventar atendimento retroativo.

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";
import { buscarMensagensDoChat } from "../_shared/uazapi-client.ts";
import { baixarESalvarMidia } from "../_shared/midia-mensagem.ts";
import {
  dataDaMensagem,
  parseMensagem,
  TIPOS_COM_DOWNLOAD,
} from "../_shared/mensagem-uazapi.ts";
import {
  idsPossiveis,
  inteiroNoIntervalo,
  papelDaMensagemBackfill,
  usaJanelaDuplicata,
} from "./logic.ts";

const FUNCAO = "backfill-mensagens-externas";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Limites: a função tem orçamento de tempo. Lotes pequenos, chamados em
// sequência pelo operador, são mais previsíveis que um lote grande que estoura.
const DIAS_PADRAO = 7;
const DIAS_MAX = 90;
const LIMITE_CLIENTES_PADRAO = 25;
const LIMITE_CLIENTES_MAX = 100;
const MSGS_POR_CHAT = 100;
// Quantos clientes processar ao mesmo tempo (cada um é 1 chamada à uazapi).
const CONCORRENCIA = 3;
// Duas mensagens outbound do mesmo cliente, mesmo tipo, dentro desta janela são
// tratadas como a MESMA (proteção contra formato de id divergente).
const JANELA_DUPLICATA_MS = 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// Compara segredos em tempo constante (não sai no primeiro byte diferente).
function comparaConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface Payload {
  dias?: number;
  limite_clientes?: number;
  offset?: number;
  dry_run?: boolean;
  /** Inclui números que também são de colaborador (traz aviso interno junto). */
  incluir_colaboradores?: boolean;
  /** Recupera também as mensagens RECEBIDAS do cliente, não só as que saíram. */
  incluir_inbound?: boolean;
  /** Limita a um único cliente — use sempre que estiver consertando um caso. */
  client_id?: string;
}

interface ClienteAlvo {
  id: string;
  numero: string;
}

interface ResultadoCliente {
  client_id: string;
  encontradas: number;
  inseridas: number;
  puladas: number;
  erro?: string;
  /** Só em dry_run: o que entraria. Mensagem não pode ser apagada depois. */
  amostra?: {
    quando: string;
    direcao: "inbound" | "outbound";
    tipo: string;
    arquivo: string | null;
    previa: string | null;
  }[];
}

/** Clientes com atendimento na janela — só eles têm conversa onde encaixar. */
async function clientesComAtendimento(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  desde: string,
  incluirColaboradores: boolean,
): Promise<ClienteAlvo[]> {
  const { data, error } = await supabase
    .from("atendimentos")
    .select("client_id, created_at, clients:client_id(numero_whatsapp)")
    .gte("created_at", desde)
    .order("created_at", { ascending: true })
    .limit(2000);

  if (error) throw new Error(`select_atendimentos: ${error.message}`);

  // Números de colaborador ficam de fora por padrão: o histórico deles está
  // cheio de notificação interna do sistema ("Novo atendimento pra você"), que
  // não é conversa com cliente. O webhook resolve isso por MENSAGEM
  // (envios_internos_whatsapp), mas essa tabela só existe a partir de
  // 30/07/2026 — para o passado não há como separar aviso de documento, então
  // aqui o corte continua sendo por número. Use `incluir_colaboradores: true`
  // para revisar esses casos manualmente (sempre com dry_run antes).
  const numerosInternos = new Set<string>();
  if (!incluirColaboradores) {
    const { data: users } = await supabase.from("users").select("whatsapp").not(
      "whatsapp",
      "is",
      null,
    );
    for (const u of (users ?? []) as { whatsapp: string | null }[]) {
      const d = String(u.whatsapp ?? "").replace(/\D/g, "");
      if (d) numerosInternos.add(d);
    }
  }

  const vistos = new Set<string>();
  const alvos: ClienteAlvo[] = [];
  for (const linha of (data ?? []) as unknown as {
    client_id: string;
    clients: { numero_whatsapp?: string } | null;
  }[]) {
    const id = linha.client_id;
    if (!id || vistos.has(id)) continue;
    const numero = (linha.clients?.numero_whatsapp ?? "").replace(/\D/g, "");
    if (!numero) continue;
    if (numerosInternos.has(numero)) {
      vistos.add(id);
      continue;
    }
    vistos.add(id);
    alvos.push({ id, numero });
  }
  return alvos;
}

/**
 * Atendimento onde a mensagem antiga encaixa: o que estava aberto naquele
 * momento. Se a mensagem é anterior a todos (caso típico — o documento saiu
 * ANTES de o cliente responder e abrir o atendimento), usa o mais antigo, que é
 * justamente a conversa que ficou sem contexto.
 */
async function atendimentoParaMomento(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  clientId: string,
  quando: string,
): Promise<{ id: string; current_department_id: string | null } | null> {
  const { data: anterior } = await supabase
    .from("atendimentos")
    .select("id, current_department_id")
    .eq("client_id", clientId)
    .lte("created_at", quando)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (anterior) return anterior as { id: string; current_department_id: string | null };

  const { data: maisAntigo } = await supabase
    .from("atendimentos")
    .select("id, current_department_id")
    .eq("client_id", clientId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return (maisAntigo as { id: string; current_department_id: string | null } | null) ?? null;
}

async function processarCliente(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  cliente: ClienteAlvo,
  desdeMs: number,
  dryRun: boolean,
  incluirInbound: boolean,
): Promise<ResultadoCliente> {
  const r: ResultadoCliente = { client_id: cliente.id, encontradas: 0, inseridas: 0, puladas: 0 };

  let mensagens: Record<string, unknown>[];
  try {
    mensagens = await buscarMensagensDoChat({
      chatid: `${cliente.numero}@s.whatsapp.net`,
      limit: MSGS_POR_CHAT,
    });
  } catch (err) {
    r.erro = err instanceof Error ? err.message.slice(0, 140) : "falha_uazapi";
    return r;
  }

  // O que SAIU do nosso número (fromMe) é o caso original: o webhook descartava
  // esses eventos. A mensagem recebida só entra sob pedido explícito, para
  // consertar um cliente cujo inbound o webhook errou ao resolver.
  const candidatas = mensagens.filter((m) => {
    if (m.fromMe !== true && !incluirInbound) return false;
    const iso = dataDaMensagem(m);
    if (!iso) return false;
    return Date.parse(iso) >= desdeMs;
  });
  r.encontradas = candidatas.length;
  if (candidatas.length === 0) return r;

  const todosIds = [...new Set(candidatas.flatMap((m) => idsPossiveis(m).todos))];
  if (todosIds.length === 0) {
    r.puladas = candidatas.length;
    return r;
  }

  const { data: existentes, error: errExist } = await supabase
    .from("mensagens")
    .select("zapi_message_id")
    .in("zapi_message_id", todosIds);
  if (errExist) {
    r.erro = `select_existentes: ${errExist.message.slice(0, 100)}`;
    return r;
  }
  const jaTemos = new Set(
    ((existentes ?? []) as { zapi_message_id: string | null }[])
      .map((l) => l.zapi_message_id)
      .filter((v): v is string => !!v),
  );

  // Da mais antiga para a mais nova: se duas caírem no mesmo atendimento, a
  // ordem de inserção acompanha a ordem real da conversa.
  const faltando = candidatas
    .filter((m) => {
      const { preferido, todos } = idsPossiveis(m);
      return preferido !== null && !todos.some((id) => jaTemos.has(id));
    })
    .sort((a, b) => Date.parse(dataDaMensagem(a)!) - Date.parse(dataDaMensagem(b)!));

  for (const msg of faltando) {
    const uazapiId = idsPossiveis(msg).preferido!;
    const quando = dataDaMensagem(msg)!;

    const parsed = parseMensagem(msg);
    if (!parsed) {
      r.puladas++;
      continue;
    }

    const papel = papelDaMensagemBackfill(msg.fromMe === true);

    // Segunda rede contra duplicata: se já existe mensagem do mesmo cliente, na
    // mesma direção, mesmo tipo, no mesmo instante, é a MESMA mensagem gravada
    // com outro formato de id. Preferimos pular do que duplicar a conversa.
    if (usaJanelaDuplicata(papel.direction)) {
      const janelaIni = new Date(Date.parse(quando) - JANELA_DUPLICATA_MS).toISOString();
      const janelaFim = new Date(Date.parse(quando) + JANELA_DUPLICATA_MS).toISOString();
      const { data: parecida } = await supabase
        .from("mensagens")
        .select("id")
        .eq("client_id", cliente.id)
        .eq("direction", papel.direction)
        .eq("tipo", parsed.tipo)
        .gte("created_at", janelaIni)
        .lte("created_at", janelaFim)
        .limit(1)
        .maybeSingle();
      if (parecida?.id) {
        r.puladas++;
        continue;
      }
    }

    const atend = await atendimentoParaMomento(supabase, cliente.id, quando);
    if (!atend) {
      r.puladas++;
      continue;
    }

    if (dryRun) {
      r.inseridas++;
      // Sem a amostra, aplicar seria às cegas — e o trigger de `mensagens`
      // impede DELETE, então não há como desfazer um backfill errado.
      (r.amostra ??= []).push({
        quando,
        direcao: papel.direction,
        tipo: parsed.tipo,
        arquivo: (parsed.media_metadata?.file_name as string | undefined) ?? null,
        previa: parsed.content ? parsed.content.slice(0, 60) : null,
      });
      continue;
    }

    // `origem: api_externa` marca o que SAIU por fora do Chat — é o que
    // autoriza apagar para todos. Mensagem recebida não leva essa marca.
    const meta = papel.direction === "outbound"
      ? { ...(parsed.media_metadata ?? {}), origem: "api_externa", backfill: true }
      : { ...(parsed.media_metadata ?? {}), backfill: true };
    const { data: nova, error: errIns } = await supabase
      .from("mensagens")
      .insert({
        atendimento_id: atend.id,
        client_id: cliente.id,
        department_id: atend.current_department_id,
        direction: papel.direction,
        sender_type: papel.sender_type,
        sent_by_user_id: null,
        tipo: parsed.tipo,
        content: parsed.content,
        media_url: parsed.media_url,
        media_metadata: meta,
        zapi_message_id: uazapiId,
        status_envio: "enviado",
        status_whatsapp: papel.status_whatsapp,
        created_at: quando,
      })
      .select("id")
      .maybeSingle();

    if (errIns) {
      // 23505 = alguém (webhook ou execução anterior) gravou no meio do caminho.
      const ehUnique = errIns.code === "23505" || /duplicate key/i.test(errIns.message);
      if (ehUnique) {
        r.puladas++;
        continue;
      }
      r.erro = `insert: ${errIns.message.slice(0, 100)}`;
      return r;
    }
    if (!nova?.id) {
      r.puladas++;
      continue;
    }
    r.inseridas++;

    if (TIPOS_COM_DOWNLOAD.has(parsed.tipo)) {
      // Aguarda de propósito: o objetivo do backfill é o ARQUIVO aparecer. Sem
      // esperar, a função poderia encerrar antes do upload terminar.
      await baixarESalvarMidia({
        funcao: FUNCAO,
        mensagemId: nova.id as string,
        atendimentoId: atend.id,
        clientId: cliente.id,
        zapiMessageId: uazapiId,
        urlOriginal: parsed.media_url,
        tipo: parsed.tipo,
        metaInicial: meta,
      });
    }
  }

  return r;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ ok: false, erro: "method_not_allowed" }, 405);

  const cron = iniciarCronometro();
  const supabase = getSupabaseAdmin();

  // Autorização: dois caminhos, os dois administrativos.
  //   a) header `x-backfill-secret` = secret BACKFILL_SECRET — operação de
  //      manutenção, rodada por scripts/backfill-mensagens-externas.sh.
  //   b) JWT de superadmin — pela aplicação.
  // Atendente comum não passa: isto lê o histórico inteiro de conversas na
  // uazapi e escreve em `mensagens`.
  const segredoEsperado = Deno.env.get("BACKFILL_SECRET") ?? "";
  const segredoRecebido = req.headers.get("x-backfill-secret") ?? "";
  const ehOperador = segredoEsperado !== "" &&
    comparaConstante(segredoRecebido, segredoEsperado);

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
    // sem corpo → usa os padrões
  }

  const dias = inteiroNoIntervalo(payload.dias, DIAS_PADRAO, 1, DIAS_MAX);
  const limiteClientes = inteiroNoIntervalo(
    payload.limite_clientes,
    LIMITE_CLIENTES_PADRAO,
    1,
    LIMITE_CLIENTES_MAX,
  );
  const offset = inteiroNoIntervalo(payload.offset, 0, 0, 100000);
  // dry_run é o PADRÃO: rodar sem querer não escreve nada.
  const dryRun = payload.dry_run !== false;
  const incluirColaboradores = payload.incluir_colaboradores === true;
  const incluirInbound = payload.incluir_inbound === true;
  // client_id malformado NÃO pode virar "roda em todo mundo": quem passa esse
  // campo está consertando UM caso, e o silêncio aqui rodaria o backfill no
  // lote inteiro. Falha explícita.
  const clienteUnico = payload.client_id === undefined || payload.client_id === null
    ? null
    : typeof payload.client_id === "string" && UUID_RE.test(payload.client_id)
    ? payload.client_id
    : undefined;
  if (clienteUnico === undefined) {
    return jsonResponse({ ok: false, erro: "client_id_invalido" }, 400);
  }

  const desdeMs = Date.now() - dias * 24 * 60 * 60 * 1000;
  const desde = new Date(desdeMs).toISOString();

  try {
    const encontrados = await clientesComAtendimento(supabase, desde, incluirColaboradores);
    const todos = clienteUnico ? encontrados.filter((c) => c.id === clienteUnico) : encontrados;
    const lote = todos.slice(offset, offset + limiteClientes);

    const resultados: ResultadoCliente[] = [];
    for (let i = 0; i < lote.length; i += CONCORRENCIA) {
      const fatia = lote.slice(i, i + CONCORRENCIA);
      const parciais = await Promise.all(
        fatia.map((c) => processarCliente(supabase, c, desdeMs, dryRun, incluirInbound)),
      );
      resultados.push(...parciais);
    }

    const soma = (campo: "encontradas" | "inseridas" | "puladas") =>
      resultados.reduce((acc, r) => acc + r[campo], 0);
    const erros = resultados.filter((r) => r.erro);

    const resposta = {
      ok: true,
      dry_run: dryRun,
      dias,
      incluir_colaboradores: incluirColaboradores,
      incluir_inbound: incluirInbound,
      client_id: clienteUnico,
      clientes_analisados: lote.length,
      clientes_no_periodo: todos.length,
      proximo_offset: offset + lote.length,
      tem_mais: offset + lote.length < todos.length,
      encontradas: soma("encontradas"),
      inseridas: soma("inseridas"),
      puladas: soma("puladas"),
      erros: erros.length,
      detalhes: resultados.filter((r) => r.erro || r.inseridas > 0),
      amostra: resultados.flatMap((r) => r.amostra ?? []).slice(0, 40),
    };

    log({
      funcao: FUNCAO,
      evento: "backfill_concluido",
      status: "ok",
      duracao_ms: cron(),
      extra: {
        dry_run: dryRun,
        clientes: lote.length,
        inseridas: resposta.inseridas,
        erros: erros.length,
      },
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
