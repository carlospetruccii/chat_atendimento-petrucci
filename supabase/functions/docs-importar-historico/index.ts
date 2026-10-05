// Edge Function: docs-importar-historico
// Traz para a aba Docs as mensagens dos ÚLTIMOS DIAS do número financeiro que
// aconteceram antes de o webhook do Docs ser ligado (a uazapi só guarda ~7 dias).
// Principal objetivo: cliente que respondeu na última semana e ficou no vácuo
// aparecer em "Sem dono".
//
// Contrato:
//   POST { dias? (1..7, padrão 7), limite_chats? (padrão 30), offset?, dry_run? }
//   → { ok, dry_run, chats_analisados, proximo_offset, tem_mais,
//       encontradas, novas, inseridas, do_cliente, erros }
//   Só grava com `dry_run: false`. Idempotente (UNIQUE de uazapi_message_id).
//
// Autorização: admin logado, ou header `x-docs-setup-token` = secret
// DOCS_SETUP_TOKEN (temporário, criado só durante a operação — ver docs-conexao).
//
// Cuidados com a instância COMPARTILHADA com o outro sistema:
//   - chamadas em sequência, lote pequeno por execução;
//   - nenhuma mídia é baixada: tudo entra "sob demanda" (botão Baixar).

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";
import { buscarMensagensDoChat, listarChats, UazapiError } from "../_shared/uazapi-client.ts";
import { dataDaMensagem, parseMensagem, TIPOS_COM_DOWNLOAD } from "../_shared/mensagem-uazapi.ts";
import { resolverClienteIdent } from "../_shared/cliente-ident.ts";
import { exigirAcessoDocs, usuarioDoJwt } from "../_shared/docs-acesso.ts";
import { conversaDocsDoCliente } from "../_shared/docs-conversa.ts";
import { chatIndividualValido } from "../_shared/docs-rastreio.ts";
import { COMPANY_ID_INSTANCIA } from "../webhook-zapi-receive/grupos.ts";
import { escolherNomeContato, origemExterna } from "../webhook-docs-receive/logic.ts";
import { extrairChats, validarPedidoImportacao } from "./logic.ts";

const FUNCAO = "docs-importar-historico";
const POR_PAGINA = 100;
const MAX_PAGINAS_POR_CHAT = 5;
// Folga sob os 150s do gateway: o que não couber fica para a próxima chamada.
const PRAZO_MS = 110_000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-docs-setup-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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

function chamadaInterna(req: Request): boolean {
  const esperado = Deno.env.get("DOCS_SETUP_TOKEN");
  const recebido = req.headers.get("x-docs-setup-token") ?? "";
  return !!esperado && esperado.length >= 32 && comparaConstante(recebido, esperado);
}

/** Mensagens do chat dentro da janela, da mais antiga para a mais nova. */
async function mensagensNaJanela(
  chatid: string,
  desdeMs: number,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let pagina = 0; pagina < MAX_PAGINAS_POR_CHAT; pagina++) {
    const lote = await buscarMensagensDoChat({
      chatid,
      limit: POR_PAGINA,
      offset: pagina * POR_PAGINA,
      instancia: "financeiro",
    });
    let passouDaJanela = false;
    for (const m of lote) {
      const iso = dataDaMensagem(m);
      const ms = iso ? Date.parse(iso) : NaN;
      if (Number.isFinite(ms) && ms < desdeMs) {
        passouDaJanela = true;
        continue;
      }
      out.push(m);
    }
    if (passouDaJanela || lote.length < POR_PAGINA) break;
  }
  return out.sort((a, b) => Date.parse(dataDaMensagem(a) ?? "0") - Date.parse(dataDaMensagem(b) ?? "0"));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ ok: false, erro: "method_not_allowed" }, 405);

  const cron = iniciarCronometro();
  const inicio = Date.now();
  const supabase = getSupabaseAdmin();

  if (!chamadaInterna(req)) {
    const userId = await usuarioDoJwt(supabase, req);
    if (!userId) return jsonResponse({ ok: false, erro: "unauthorized" }, 401);
    const membro = await exigirAcessoDocs(supabase, userId);
    if (!membro?.isSuperadmin) return jsonResponse({ ok: false, erro: "forbidden" }, 403);
  }

  let bruto: Record<string, unknown> = {};
  try {
    bruto = (await req.json()) as Record<string, unknown>;
  } catch {
    // corpo vazio = padrões (simulação)
  }
  const pedido = validarPedidoImportacao(bruto);
  const desdeMs = Date.now() - pedido.dias * 86_400_000;

  const resumo = {
    chats_analisados: 0,
    encontradas: 0,
    novas: 0,
    inseridas: 0,
    do_cliente: 0,
    erros: 0,
  };

  let chats;
  try {
    chats = extrairChats(await listarChats({
      limit: pedido.limiteChats,
      offset: pedido.offset,
      instancia: "financeiro",
    }));
  } catch (err) {
    log({
      funcao: FUNCAO,
      evento: "listar_chats_falhou",
      status: "erro",
      erro_msg: err instanceof Error ? err.message.slice(0, 200) : String(err),
      extra: { uazapi_status: err instanceof UazapiError ? err.status : null },
    });
    return jsonResponse({ ok: false, erro: "falha_uazapi" }, 502);
  }

  // Página cheia = pode haver mais conversas na janela.
  let temMais = chats.length >= pedido.limiteChats;
  let processados = 0;

  for (const chat of chats) {
    if (Date.now() - inicio > PRAZO_MS) {
      temMais = true;
      break;
    }
    // Lista ordenada pela última mensagem: passou da janela, acabou.
    if (chat.ultimaMs !== null && chat.ultimaMs < desdeMs) {
      temMais = false;
      break;
    }
    processados++;
    resumo.chats_analisados++;

    let msgs: Record<string, unknown>[];
    try {
      msgs = await mensagensNaJanela(chat.chatid, desdeMs);
    } catch (err) {
      resumo.erros++;
      log({
        funcao: FUNCAO,
        evento: "buscar_mensagens_falhou",
        status: "erro",
        erro_msg: err instanceof Error ? err.message.slice(0, 200) : String(err),
      });
      continue;
    }

    let conversaId: string | null = null;
    for (const m of msgs) {
      const id = (m.id as string | undefined) ?? (m.messageid as string | undefined) ?? null;
      const parsed = parseMensagem(m);
      if (!id || !parsed || !chatIndividualValido(m.chatid ?? chat.chatid)) continue;
      resumo.encontradas++;

      const { data: existe } = await supabase
        .from("docs_mensagens")
        .select("id")
        .eq("uazapi_message_id", id)
        .maybeSingle();
      if (existe) continue;
      resumo.novas++;
      const fromMe = m.fromMe === true;
      if (!fromMe) resumo.do_cliente++;
      if (pedido.dryRun) continue;

      // No histórico o `chatid` da mensagem pode vir como LID; o da LISTA de
      // conversas é o número. O número identifica/cria o cliente, e o LID vai
      // junto para ficar vinculado ao cadastro (igual o webhook faz).
      const chatidMsg = typeof m.chatid === "string" ? m.chatid : "";
      const lid = /@lid$/i.test(chatidMsg) ? chatidMsg : undefined;
      const payload = fromMe
        ? { ...m, chatid: chat.chatid }
        : { ...m, chatid: chat.chatid, sender_pn: chat.chatid, ...(lid ? { sender_lid: lid } : {}) };
      if (!conversaId) {
        const resolved = await resolverClienteIdent(payload, supabase, {
          companyId: COMPANY_ID_INSTANCIA,
          permitirCriar: true,
          senderName: fromMe ? null : escolherNomeContato(m.senderName, m.pushName),
          preferChatid: fromMe,
          funcao: FUNCAO,
        });
        if ("erro" in resolved) {
          resumo.erros++;
          log({
            funcao: FUNCAO,
            evento: "resolver_cliente_falhou",
            status: "erro",
            extra: { motivo: resolved.erro },
          });
          break;
        }
        conversaId = await conversaDocsDoCliente(supabase, COMPANY_ID_INSTANCIA, resolved.id, FUNCAO);
        if (!conversaId) {
          resumo.erros++;
          break;
        }
      }

      const temMidia = TIPOS_COM_DOWNLOAD.has(parsed.tipo);
      const meta: Record<string, unknown> | null = fromMe || temMidia
        ? {
          ...(parsed.media_metadata ?? {}),
          ...(fromMe ? { origem: origemExterna(m.wasSentByApi) } : {}),
          importado_historico: true,
          ...(temMidia
            ? {
              download_falhou: true,
              download_erro_codigo: "sob_demanda",
              download_erro_motivo: "Arquivo de antes do Docs ser ligado. Toque para baixar.",
            }
            : {}),
        }
        : parsed.media_metadata ?? null;
      const criadoEm = dataDaMensagem(m);

      const { error } = await supabase.from("docs_mensagens").insert({
        company_id: COMPANY_ID_INSTANCIA,
        conversa_id: conversaId,
        direction: fromMe ? "outbound" : "inbound",
        sender_type: fromMe ? "externo" : "cliente",
        sent_by_user_id: null,
        tipo: parsed.tipo,
        content: parsed.content,
        media_url: parsed.media_url,
        media_metadata: meta,
        uazapi_message_id: id,
        status_envio: "enviado",
        status_whatsapp: fromMe ? "enviado" : null,
        ...(criadoEm ? { created_at: criadoEm } : {}),
      });
      if (error && error.code !== "23505") {
        resumo.erros++;
        log({ funcao: FUNCAO, evento: "insert_falhou", status: "erro", erro_msg: error.message });
      } else if (!error) {
        resumo.inseridas++;
      }
    }
  }

  const proximoOffset = pedido.offset + processados;
  log({
    funcao: FUNCAO,
    evento: "importacao_lote",
    status: "ok",
    duracao_ms: cron(),
    extra: { ...resumo, dry_run: pedido.dryRun, offset: pedido.offset, proximo_offset: proximoOffset },
  });

  return jsonResponse({
    ok: true,
    dry_run: pedido.dryRun,
    ...resumo,
    proximo_offset: proximoOffset,
    tem_mais: temMais,
  });
});
