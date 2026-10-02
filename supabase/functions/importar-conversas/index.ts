// Edge Function: importar-conversas
//
// Traz para o sistema as conversas que JÁ EXISTEM no WhatsApp conectado. Sem
// isso, a Inbox de um número recém-conectado fica vazia até cada cliente mandar
// mensagem de novo — o webhook só grava o que chega daqui para frente.
//
// Como funciona, por chat (do mais recente para o mais antigo):
//   1. lista os chats individuais na uazapi (POST /chat/find);
//   2. lê as mensagens do chat (POST /message/find) dentro da janela de dias;
//   3. cria o cliente, se não existir;
//   4. se as mensagens são anteriores a qualquer atendimento do cliente, cria UM
//      atendimento já ENCERRADO (close_reason = migracao_inicial). Encerrado de
//      propósito: não cai em Pendentes, não roda triagem, não notifica ninguém.
//      Quando o cliente escrever de novo, o webhook abre atendimento novo normal;
//   5. grava as mensagens com a data REAL e baixa a mídia (dentro do orçamento).
//
// LIMITE: a uazapi só guarda ~7 dias de mensagens. Mais antigo que isso, rode
// depois a historico-solicitar (pede ao celular) — ela precisa justamente de um
// atendimento existente para pendurar o histórico, que esta função cria.
//
// Contrato:
//   POST { dias?, limite_chats?, offset?, dry_run? }
//   Authorization: JWT de superadmin, OU chave de servidor (Bearer ou x-service-key).
//   → { ok, dry_run, chats_lidos, importados, mensagens_inseridas, proximo_offset, tem_mais, ... }
//
// Idempotente: o UNIQUE de zapi_message_id e a checagem prévia impedem duplicar.
// dry_run é o PADRÃO (mensagens não aceitam DELETE — confira antes de gravar).

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";
import { buscarMensagensDoChat, listarChats, statusInstancia } from "../_shared/uazapi-client.ts";
import { baixarESalvarMidia } from "../_shared/midia-mensagem.ts";
import { dataDaMensagem, parseMensagem, TIPOS_COM_DOWNLOAD } from "../_shared/mensagem-uazapi.ts";
import { idsPossiveis, inteiroNoIntervalo } from "../_shared/historico.ts";
import { atualizarFotoPerfil } from "../_shared/foto-perfil-sync.ts";
import { ehOperadorOuSuperadmin } from "../_shared/auth-operador.ts";
import { type AlvoChat, alvoDoChat, type AtendimentoRef, atendimentoDoMomento } from "./logic.ts";

const FUNCAO = "importar-conversas";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DIAS_PADRAO = 7;
const DIAS_MAX = 30;
const LIMITE_CHATS_PADRAO = 10;
const LIMITE_CHATS_MAX = 10;
const MSGS_POR_CHAT = 100;
// Prazo do lote, com folga para o limite de tempo da Edge Function. Passou
// disso, para ANTES de gravar a próxima mensagem e devolve o offset do chat
// atual: a próxima chamada retoma dele (a dedupe pula o que já entrou). Assim a
// mídia nunca fica para trás — mensagem só é gravada junto com o download.
const PRAZO_MS = 100_000;

type Supabase = ReturnType<typeof getSupabaseAdmin>;

interface ResultadoChat {
  numero: string;
  nome: string | null;
  encontradas: number;
  inseridas: number;
  /** Parou no meio por prazo: o chat precisa ser reprocessado. */
  interrompido?: boolean;
  erro?: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

/** Próprio número + números de colaboradores: chats que não são de cliente. */
async function numerosExcluidos(supabase: Supabase): Promise<Set<string>> {
  const excl = new Set<string>();
  const { data: users } = await supabase.from("users").select("whatsapp").not("whatsapp", "is", null);
  for (const u of (users ?? []) as { whatsapp: string | null }[]) {
    const d = String(u.whatsapp ?? "").replace(/\D/g, "");
    if (d) excl.add(d);
  }
  try {
    const st = await statusInstancia();
    if (st.numero) excl.add(st.numero);
  } catch {
    // sem status: segue só com os colaboradores
  }
  return excl;
}

async function garantirCliente(supabase: Supabase, alvo: AlvoChat): Promise<string> {
  const { data: c } = await supabase
    .from("clients")
    .select("id, nome, chat_lid")
    .eq("numero_whatsapp", alvo.numero)
    .maybeSingle();
  if (c) {
    const patch: Record<string, string> = {};
    if (!c.nome && alvo.nome) patch.nome = alvo.nome;
    if (!c.chat_lid && alvo.lid) patch.chat_lid = alvo.lid;
    if (Object.keys(patch).length > 0) await supabase.from("clients").update(patch).eq("id", c.id);
    return c.id as string;
  }

  const base = { numero_whatsapp: alvo.numero, nome: alvo.nome };
  let { data: novo, error } = await supabase
    .from("clients")
    .insert({ ...base, chat_lid: alvo.lid })
    .select("id")
    .single();
  // LID já usado por outro cadastro: cria sem ele em vez de perder a conversa.
  if (error && alvo.lid && /chat_lid/i.test(error.message)) {
    ({ data: novo, error } = await supabase.from("clients").insert(base).select("id").single());
  }
  if (error || !novo) throw new Error(`criar_cliente: ${error?.message ?? "sem id"}`);
  return novo.id as string;
}

async function atendimentosDoCliente(supabase: Supabase, clientId: string): Promise<AtendimentoRef[]> {
  const { data, error } = await supabase
    .from("atendimentos")
    .select("id, created_at, current_department_id")
    .eq("client_id", clientId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`select_atendimentos: ${error.message}`);
  return (data ?? []) as AtendimentoRef[];
}

/** Atendimento encerrado que abriga a conversa anterior ao sistema. */
async function criarAtendimentoMigracao(
  supabase: Supabase,
  clientId: string,
  desdeIso: string,
  ateIso: string,
): Promise<AtendimentoRef> {
  const { data, error } = await supabase
    .from("atendimentos")
    .insert({
      client_id: clientId,
      status: "encerrado",
      close_reason: "migracao_inicial",
      triagem_estagio: "concluida",
      created_at: desdeIso,
      closed_at: ateIso,
    })
    .select("id, created_at, current_department_id")
    .single();
  if (error || !data) throw new Error(`criar_atendimento: ${error?.message ?? "sem id"}`);
  return data as AtendimentoRef;
}

async function processarChat(
  supabase: Supabase,
  alvo: AlvoChat,
  desdeMs: number,
  dryRun: boolean,
  inicio: number,
): Promise<ResultadoChat> {
  const r: ResultadoChat = { numero: alvo.numero, nome: alvo.nome, encontradas: 0, inseridas: 0 };

  const brutas = await buscarMensagensDoChat({ chatid: alvo.chatid, limit: MSGS_POR_CHAT });
  const naJanela = brutas
    .map((m) => ({ m, quando: dataDaMensagem(m) }))
    .filter((x): x is { m: Record<string, unknown>; quando: string } =>
      x.quando !== null && Date.parse(x.quando) >= desdeMs
    )
    .sort((a, b) => Date.parse(a.quando) - Date.parse(b.quando));
  r.encontradas = naJanela.length;
  if (naJanela.length === 0) return r;

  const todosIds = [...new Set(naJanela.flatMap((x) => idsPossiveis(x.m).todos))];
  const { data: existentes, error: errExist } = await supabase
    .from("mensagens")
    .select("zapi_message_id")
    .in("zapi_message_id", todosIds);
  if (errExist) throw new Error(`select_existentes: ${errExist.message}`);
  const jaTemos = new Set(
    ((existentes ?? []) as { zapi_message_id: string | null }[]).map((l) => l.zapi_message_id),
  );
  const faltando = naJanela.filter((x) => {
    const { preferido, todos } = idsPossiveis(x.m);
    return preferido !== null && !todos.some((id) => jaTemos.has(id)) && parseMensagem(x.m) !== null;
  });
  if (faltando.length === 0) return r;

  if (dryRun) {
    r.inseridas = faltando.length;
    return r;
  }

  const clientId = await garantirCliente(supabase, alvo);
  await atualizarFotoPerfil(supabase, { tabela: "clients", id: clientId, urlConhecida: alvo.foto }, FUNCAO);
  let atendimentos = await atendimentosDoCliente(supabase, clientId);

  const primeira = faltando[0].quando;
  if (!atendimentoDoMomento(atendimentos, primeira)) {
    // Fecha no último instante ANTES do primeiro atendimento real (se houver).
    const corte = atendimentos[0] ? Date.parse(atendimentos[0].created_at) : Infinity;
    const anteriores = faltando.filter((x) => Date.parse(x.quando) < corte);
    const ultima = anteriores[anteriores.length - 1]?.quando ?? primeira;
    const migracao = await criarAtendimentoMigracao(supabase, clientId, primeira, ultima);
    atendimentos = [migracao, ...atendimentos];
  }

  for (const { m, quando } of faltando) {
    if (Date.now() - inicio > PRAZO_MS) {
      r.interrompido = true;
      return r;
    }
    const atend = atendimentoDoMomento(atendimentos, quando);
    const parsed = parseMensagem(m);
    const uazapiId = idsPossiveis(m).preferido;
    if (!atend || !parsed || !uazapiId) continue;

    const fromMe = m.fromMe === true;
    const meta = { ...(parsed.media_metadata ?? {}), origem: "importacao_inicial", historico_importado: true };
    const { data: nova, error: errIns } = await supabase
      .from("mensagens")
      .insert({
        atendimento_id: atend.id,
        client_id: clientId,
        department_id: atend.current_department_id,
        direction: fromMe ? "outbound" : "inbound",
        // 'externo' no que saiu do nosso número: não dispara a promoção de
        // status nem carimba primeira resposta de atendente.
        sender_type: fromMe ? "externo" : "cliente",
        sent_by_user_id: null,
        tipo: parsed.tipo,
        content: parsed.content,
        media_url: parsed.media_url,
        media_metadata: meta,
        zapi_message_id: uazapiId,
        status_envio: "enviado",
        status_whatsapp: fromMe ? "enviado" : null,
        created_at: quando,
      })
      .select("id")
      .maybeSingle();

    if (errIns) {
      // 23505 = o webhook gravou a mesma mensagem no meio do caminho.
      if (errIns.code === "23505" || /duplicate key/i.test(errIns.message)) continue;
      throw new Error(`insert_mensagem: ${errIns.message}`);
    }
    if (!nova?.id) continue;
    r.inseridas++;

    if (TIPOS_COM_DOWNLOAD.has(parsed.tipo)) {
      try {
        await baixarESalvarMidia({
          funcao: FUNCAO,
          mensagemId: nova.id as string,
          atendimentoId: atend.id,
          clientId,
          zapiMessageId: uazapiId,
          urlOriginal: parsed.media_url,
          tipo: parsed.tipo,
          metaInicial: meta,
        });
      } catch (err) {
        log({
          funcao: FUNCAO,
          evento: "midia_falhou",
          status: "erro",
          erro_msg: err instanceof Error ? err.message.slice(0, 140) : "falha_midia",
        });
      }
    }
  }
  return r;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ ok: false, erro: "method_not_allowed" }, 405);

  const cron = iniciarCronometro();
  const inicio = Date.now();
  const supabase = getSupabaseAdmin();

  if (!(await ehOperadorOuSuperadmin(req, supabase))) {
    return jsonResponse({ ok: false, erro: "unauthorized" }, 401);
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = ((await req.json()) ?? {}) as Record<string, unknown>;
  } catch {
    // sem corpo → padrões
  }
  const dias = inteiroNoIntervalo(payload.dias, DIAS_PADRAO, 1, DIAS_MAX);
  const limite = inteiroNoIntervalo(payload.limite_chats, LIMITE_CHATS_PADRAO, 1, LIMITE_CHATS_MAX);
  const offset = inteiroNoIntervalo(payload.offset, 0, 0, 100_000);
  const dryRun = payload.dry_run !== false;
  const desdeMs = Date.now() - dias * 24 * 60 * 60 * 1000;

  try {
    const excluidos = await numerosExcluidos(supabase);
    const { chats, total } = await listarChats({ limit: limite, offset });

    const resultados: ResultadoChat[] = [];
    let ignorados = 0;
    // Lista vem do mais recente para o mais antigo: chat fora da janela encerra.
    let passouDaJanela = false;
    // Índice do chat onde o prazo acabou (null = lote completo).
    let paradoEm: number | null = null;
    for (const [i, chat] of chats.entries()) {
      if (Date.now() - inicio > PRAZO_MS) {
        paradoEm = i;
        break;
      }
      const alvo = alvoDoChat(chat, excluidos);
      if (!alvo) {
        ignorados++;
        continue;
      }
      if (alvo.ultimaMsgMs !== null && alvo.ultimaMsgMs < desdeMs) {
        passouDaJanela = true;
        break;
      }
      try {
        const r = await processarChat(supabase, alvo, desdeMs, dryRun, inicio);
        resultados.push(r);
        if (r.interrompido) {
          paradoEm = i;
          break;
        }
      } catch (err) {
        resultados.push({
          numero: alvo.numero,
          nome: alvo.nome,
          encontradas: 0,
          inseridas: 0,
          erro: err instanceof Error ? err.message.slice(0, 160) : "erro",
        });
      }
    }

    const proximo = offset + (paradoEm ?? chats.length);
    const temMais = paradoEm !== null ||
      (!passouDaJanela && chats.length === limite && (total === null || proximo < total));
    const inseridas = resultados.reduce((s, r) => s + r.inseridas, 0);
    const erros = resultados.filter((r) => r.erro);

    log({
      funcao: FUNCAO,
      evento: "importacao_lote",
      status: erros.length ? "erro" : "ok",
      duracao_ms: cron(),
      extra: { dry_run: dryRun, offset, chats: chats.length, inseridas, erros: erros.length },
    });

    return jsonResponse({
      ok: true,
      dry_run: dryRun,
      dias,
      chats_lidos: chats.length,
      ignorados,
      importados: resultados.filter((r) => r.inseridas > 0).length,
      mensagens_inseridas: inseridas,
      erros: erros.length,
      proximo_offset: proximo,
      tem_mais: temMais,
      detalhes: resultados.map((r) => ({ ...r, numero: `${r.numero.slice(0, 5)}***${r.numero.slice(-2)}` })),
    });
  } catch (err) {
    log({
      funcao: FUNCAO,
      evento: "erro_inesperado",
      status: "erro",
      duracao_ms: cron(),
      erro_msg: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    return jsonResponse({ ok: false, erro: "erro_interno" }, 500);
  }
});
