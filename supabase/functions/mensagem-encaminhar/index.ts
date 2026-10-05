// Edge Function: mensagem-encaminhar
// Encaminha uma mensagem já enviada/recebida para OUTRA conversa (atendimento)
// já existente no sistema. Não cria contato nem atendimento novo.
//
// Contrato com o frontend:
//   POST { mensagem_id: string, atendimento_id_destino: string }
//     → 200 { ok: true, mensagem_id: <nova mensagem> }
//     → 200 { ok: false, motivo }   (recusa de negócio, não erro HTTP)
//
// Decisões que valem explicação:
//
// 1. AUTORIZAÇÃO NOS DOIS LADOS. A régua de "quem pode agir num atendimento" é
//    a mesma do resto do sistema (assigned_to OU superadmin OU 'force_close' —
//    ver mensagem-acao/send-whatsapp-message), aplicada tanto na conversa de
//    ORIGEM (ler o conteúdo) quanto na de DESTINO (mandar mensagem nova nela).
//    A RLS de SELECT em `mensagens` já restringe leitura por departamento, mas
//    esta função roda com service_role (bypassa RLS) — sem essa checagem, um
//    atendente comum poderia encaminhar o conteúdo de uma conversa de outro
//    departamento que ele nunca teve acesso a abrir.
//
// 2. MÍDIA: CÓPIA NOVA NO STORAGE, NUNCA O MESMO storage_path. Se a mensagem
//    encaminhada apontasse para o mesmo arquivo da origem, apagar a original
//    (mensagem-acao apaga o arquivo do bucket) quebraria a cópia encaminhada,
//    que continua "viva". `media_url` grava uma signed URL de 10 anos (mesmo
//    padrão de send-whatsapp-media/send-whatsapp-audio) — não o padrão
//    "path curto" de grupo-enviar, porque esta função insere na tabela
//    `mensagens`, que o cron-retry-mensagens-falha varre usando `media_url`
//    DIRETO como URL de reenvio (sem assinar de novo a partir do
//    storage_path). Guardar só o path aqui faria qualquer retry de mídia
//    falhar silenciosamente. `storage_path` continua em `media_metadata` para
//    o frontend (useSignedMediaUrl assina sob demanda, 15 min, pra exibir).
//
// 3. SEM JANELA DE TEMPO. Diferente de editar/apagar, encaminhar não tem
//    prazo do WhatsApp — a elegibilidade (logic.ts) só olha se a mensagem
//    ainda existe e é de um tipo que sabemos enviar.

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";
import { atualizacaoAposErroEnvio } from "../_shared/erro-envio.ts";
import { exigirMembroAtivo } from "../_shared/empresa.ts";
import { enviarMidia, enviarTexto, extrairMessageId, ZapiError } from "../_shared/uazapi-client.ts";
import { gravarIdPosEnvio } from "../_shared/pos-envio.ts";
import {
  avaliarEncaminhar,
  extensaoDoOriginal,
  type MediaMetadataOriginal,
  metadataEncaminhada,
  novoStoragePath,
  TIPO_PARA_UAZAPI,
} from "./logic.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const FUNCAO = "mensagem-encaminhar";
const BUCKET = "mensagens-midia";
// 10 anos: mesma janela usada por send-whatsapp-media/send-whatsapp-audio na
// mesma coluna `media_url` — precisa ser assim para o cron-retry-mensagens-falha
// conseguir reenviar (ver comentário no topo do arquivo).
const SIGNED_URL_TTL_SEG = 60 * 60 * 24 * 365 * 10;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

/** Remove URLs de um texto antes de persistir (podem conter URL assinada). */
function semUrls(texto: string): string {
  return texto.replace(/https?:\/\/\S+/gi, "[url]");
}


interface LinhaMensagem {
  id: string;
  atendimento_id: string;
  company_id: string;
  direction: string;
  sender_type: string;
  tipo: string;
  content: string | null;
  media_metadata: Record<string, unknown> | null;
  apagada_em: string | null;
}

const COLUNAS_MENSAGEM =
  "id, atendimento_id, company_id, direction, sender_type, tipo, content, media_metadata, apagada_em";

interface LinhaAtendimento {
  id: string;
  company_id: string;
  assigned_to: string | null;
  client_id: string;
  current_department_id: string | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ ok: false, erro: "method_not_allowed" }, 405);

  const cron = iniciarCronometro();
  const supabase = getSupabaseAdmin();

  // 1) Autenticação.
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  if (!jwt) return jsonResponse({ ok: false, erro: "unauthorized" }, 401);

  const { data: userRes, error: errUser } = await supabase.auth.getUser(jwt);
  if (errUser || !userRes?.user) {
    log({ funcao: FUNCAO, evento: "token_invalido", status: "erro", duracao_ms: cron() });
    return jsonResponse({ ok: false, erro: "unauthorized" }, 401);
  }
  const userId = userRes.user.id;

  // 2) Payload.
  let payload: { mensagem_id?: unknown; atendimento_id_destino?: unknown };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ ok: false, erro: "payload_invalido" }, 400);
  }
  const mensagemId = typeof payload.mensagem_id === "string" ? payload.mensagem_id.trim() : "";
  const atendimentoIdDestino =
    typeof payload.atendimento_id_destino === "string" ? payload.atendimento_id_destino.trim() : "";
  if (!UUID_RE.test(mensagemId) || !UUID_RE.test(atendimentoIdDestino)) {
    return jsonResponse(
      {
        ok: false,
        erro: "payload_invalido",
        detalhe: "mensagem_id e atendimento_id_destino são obrigatórios",
      },
      400,
    );
  }

  // 3) Empresa do usuário — nenhuma mensagem/atendimento de outra empresa entra.
  const membro = await exigirMembroAtivo(supabase, userId);
  if (!membro) return jsonResponse({ ok: false, erro: "forbidden" }, 403);
  const companyId = membro.companyId;

  // 4) Mensagem de origem — só existência aqui. A elegibilidade (apagada, tipo,
  //    etc.) só é revelada DEPOIS de confirmar autorização na conversa de
  //    origem, no passo 5: senão qualquer membro ativo da empresa poderia
  //    sondar um mensagem_id de uma conversa que nunca teve acesso a abrir e
  //    descobrir se está apagada, é aviso interno, etc. — informação que a
  //    régua de autorização do item 1 (topo do arquivo) existe para proteger.
  //
  //    TODAS as recusas de negócio abaixo respondem 200 com { ok:false, motivo
  //    }, nunca um status HTTP de erro: supabase-js só entrega o corpo em
  //    `data` para respostas 2xx — um 4xx/5xx vira `FunctionsHttpError` com
  //    mensagem genérica e o frontend nunca veria o motivo real (ver
  //    encaminharMensagem em src/lib/mensagem-encaminhar.ts). Só falha de
  //    autenticação (401), corpo malformado (400), empresa sem vínculo (403) e
  //    erro interno de verdade (500) continuam com status HTTP não-2xx.
  const { data: origem, error: errOrigem } = await supabase
    .from("mensagens")
    .select(COLUNAS_MENSAGEM)
    .eq("id", mensagemId)
    .eq("company_id", companyId)
    .maybeSingle();
  if (errOrigem) {
    log({
      funcao: FUNCAO,
      evento: "leitura_mensagem_origem",
      status: "erro",
      duracao_ms: cron(),
      erro_msg: errOrigem.message,
    });
    return jsonResponse({ ok: false, erro: "erro_interno" }, 500);
  }
  if (!origem) return jsonResponse({ ok: false, motivo: "mensagem_nao_encontrada" }, 200);
  const linhaOrigem = origem as unknown as LinhaMensagem;

  // 5) Atendimentos de origem e destino + bypass de autorização, numa passada só.
  const [{ data: atends, error: errAtends }, { data: userRow }, { data: permRow }] =
    await Promise.all([
      supabase
        .from("atendimentos")
        .select(
          "id, company_id, assigned_to, client_id, current_department_id, clients:client_id(numero_whatsapp)",
        )
        .eq("company_id", companyId)
        .in("id", [linhaOrigem.atendimento_id, atendimentoIdDestino]),
      supabase.from("users").select("is_superadmin").eq("id", userId).maybeSingle(),
      supabase
        .from("user_permissions")
        .select("permission")
        .eq("user_id", userId)
        .eq("permission", "force_close")
        .maybeSingle(),
    ]);
  if (errAtends) {
    log({
      funcao: FUNCAO,
      evento: "leitura_atendimentos",
      status: "erro",
      duracao_ms: cron(),
      erro_msg: errAtends.message,
    });
    return jsonResponse({ ok: false, erro: "erro_interno" }, 500);
  }

  const bypass = userRow?.is_superadmin === true || !!permRow;
  const porId = new Map<string, LinhaAtendimento & { clients?: { numero_whatsapp?: string } }>();
  for (const a of atends ?? []) porId.set(a.id as string, a as never);

  // Autorização da ORIGEM primeiro — antes de olhar qualquer coisa sobre a
  // mensagem em si (ver comentário do passo 4).
  const atendOrigem = porId.get(linhaOrigem.atendimento_id);
  if (!atendOrigem || !(bypass || atendOrigem.assigned_to === userId)) {
    return jsonResponse({ ok: false, motivo: "sem_permissao" }, 200);
  }

  // 6) Só agora a elegibilidade da mensagem é avaliada e devolvida.
  //     `midiaPronta` entra aqui porque mídia sem storage_path (download que
  //     falhou, ou ainda em andamento) não tem arquivo no bucket para copiar —
  //     e isso é recusa de negócio, tem que sair em 200 com motivo, senão o
  //     supabase-js entrega só "non-2xx status code" para o atendente.
  const metaOrigem = (linhaOrigem.media_metadata ?? {}) as MediaMetadataOriginal;
  const storagePathOriginal =
    typeof metaOrigem.storage_path === "string" && metaOrigem.storage_path
      ? metaOrigem.storage_path
      : null;

  const elegivel = avaliarEncaminhar({
    apagadaEm: linhaOrigem.apagada_em,
    senderType: linhaOrigem.sender_type,
    tipo: linhaOrigem.tipo,
    ehListaOpcoes:
      (linhaOrigem.media_metadata as { kind?: string } | null)?.kind === "lista_opcoes",
    midiaPronta: !!storagePathOriginal,
  });
  if (!elegivel.pode) {
    if (elegivel.motivo === "midia_indisponivel") {
      log({
        funcao: FUNCAO,
        evento: "media_sem_storage_path",
        status: "erro",
        mensagem_id: mensagemId,
        duracao_ms: cron(),
      });
    }
    return jsonResponse({ ok: false, motivo: elegivel.motivo }, 200);
  }

  if (atendimentoIdDestino === linhaOrigem.atendimento_id) {
    return jsonResponse({ ok: false, motivo: "mesmo_atendimento" }, 200);
  }

  const atendDestino = porId.get(atendimentoIdDestino);
  if (!atendDestino) {
    return jsonResponse({ ok: false, motivo: "atendimento_destino_nao_encontrado" }, 200);
  }
  if (!(bypass || atendDestino.assigned_to === userId)) {
    return jsonResponse({ ok: false, motivo: "sem_permissao" }, 200);
  }

  const numeroWhatsapp = atendDestino.clients?.numero_whatsapp?.replace(/\D/g, "");
  if (!numeroWhatsapp) return jsonResponse({ ok: false, motivo: "cliente_sem_numero" }, 200);

  // 6) Monta o conteúdo. Texto: mesmo `content`. Mídia: cópia nova no bucket +
  //    signed URL curta gerada na hora (ver comentário no topo do arquivo).
  const ehTexto = linhaOrigem.tipo === "texto";
  let mediaUrlColuna: string | null = null;
  let mediaMetadataNovo: Record<string, unknown> | null = null;
  let urlParaUazapi: string | null = null;

  if (!ehTexto && storagePathOriginal) {
    const metaOriginal = metaOrigem;
    const ext = extensaoDoOriginal(metaOriginal, storagePathOriginal);
    const path = novoStoragePath(atendimentoIdDestino, crypto.randomUUID(), ext);

    const { error: errCopy } = await supabase.storage.from(BUCKET).copy(storagePathOriginal, path);
    if (errCopy) {
      log({
        funcao: FUNCAO,
        evento: "copia_midia_falhou",
        status: "erro",
        mensagem_id: mensagemId,
        duracao_ms: cron(),
        erro_msg: errCopy.message,
      });
      return jsonResponse({ ok: false, erro: "copia_midia_falhou" }, 500);
    }

    const { data: signed, error: errSigned } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(path, SIGNED_URL_TTL_SEG);
    if (!signed?.signedUrl) {
      log({
        funcao: FUNCAO,
        evento: "signed_url_falhou",
        status: "erro",
        duracao_ms: cron(),
        erro_msg: errSigned?.message,
      });
      return jsonResponse({ ok: false, erro: "midia_indisponivel" }, 500);
    }
    // Mesma URL de 10 anos serve pro envio agora E fica gravada em `media_url`
    // (ver comentário no topo do arquivo) — cron-retry-mensagens-falha usa essa
    // coluna direto, sem assinar de novo.
    urlParaUazapi = signed.signedUrl;
    mediaUrlColuna = signed.signedUrl;
    mediaMetadataNovo = metadataEncaminhada({
      original: metaOriginal,
      novoPath: path,
      mensagemOrigemId: mensagemId,
    }) as unknown as Record<string, unknown>;
  }

  // Áudio (nota de voz) nunca leva legenda — mesma regra do compositor normal.
  const conteudoNovo = linhaOrigem.tipo === "audio" ? null : linhaOrigem.content;

  // 7) Grava a mensagem antes de falar com o WhatsApp: se a uazapi cair, a
  //    mensagem existe com status 'falha' e a UI mostra o que aconteceu.
  const { data: inserida, error: errIns } = await supabase
    .from("mensagens")
    .insert({
      atendimento_id: atendimentoIdDestino,
      client_id: atendDestino.client_id,
      department_id: atendDestino.current_department_id,
      company_id: companyId,
      direction: "outbound",
      sender_type: "atendente",
      sent_by_user_id: userId,
      tipo: linhaOrigem.tipo,
      content: conteudoNovo,
      media_url: mediaUrlColuna,
      media_metadata: mediaMetadataNovo,
      status_envio: "enviando",
      reply_to_message_id: null,
    })
    .select("id")
    .single();

  if (errIns || !inserida) {
    log({
      funcao: FUNCAO,
      evento: "insert_falhou",
      status: "erro",
      duracao_ms: cron(),
      erro_msg: errIns?.message,
    });
    return jsonResponse({ ok: false, erro: "insert_falhou" }, 500);
  }
  const novaMensagemId = inserida.id as string;

  log({
    funcao: FUNCAO,
    evento: "encaminhamento_iniciado",
    status: "ok",
    mensagem_id: novaMensagemId,
    atendimento_id: atendimentoIdDestino,
    duracao_ms: cron(),
    extra: { tipo: linhaOrigem.tipo, mensagem_origem_id: mensagemId },
  });

  // 8) Envio em background: a resposta ao frontend não espera a uazapi.
  const tarefaEnvio = (async (supabaseTask: SupabaseClient) => {
    const t = iniciarCronometro();
    try {
      const resposta = ehTexto
        ? await enviarTexto({
            telefone: numeroWhatsapp,
            mensagem: conteudoNovo ?? "",
            forward: true,
          })
        : await enviarMidia({
            telefone: numeroWhatsapp,
            tipo: TIPO_PARA_UAZAPI[linhaOrigem.tipo],
            url: urlParaUazapi as string,
            caption: conteudoNovo ?? undefined,
            fileName:
              typeof mediaMetadataNovo?.file_name === "string"
                ? (mediaMetadataNovo.file_name as string)
                : undefined,
            forward: true,
          });

      const zapiMessageId = extrairMessageId(resposta);
      const posEnvio = await gravarIdPosEnvio({
        supabase: supabaseTask,
        tabela: "mensagens",
        colunaMessageId: "zapi_message_id",
        mensagemId: novaMensagemId,
        messageId: zapiMessageId,
      });

      if (!posEnvio.ok) {
        log({
          funcao: FUNCAO,
          evento: "update_pos_envio",
          status: "erro",
          mensagem_id: novaMensagemId,
          duracao_ms: t(),
          erro_msg: posEnvio.erro ?? "erro_desconhecido",
        });
        return;
      }

      log({
        funcao: FUNCAO,
        evento: "envio_sucesso",
        status: "ok",
        mensagem_id: novaMensagemId,
        duracao_ms: t(),
      });
    } catch (err) {
      // Sanitizado: motivoLegivel pode ecoar o corpo de erro da uazapi, que
      // pode conter a signed URL que mandamos.
      const upd = atualizacaoAposErroEnvio(err, mediaMetadataNovo, { sanitizarMotivo: semUrls });
      await supabaseTask
        .from("mensagens")
        .update(upd)
        .eq("id", novaMensagemId)
        .eq("company_id", companyId);

      log({
        funcao: FUNCAO,
        evento: upd.status_envio === "falha" ? "envio_falha" : "envio_incerto",
        status: upd.status_envio === "falha" ? "erro" : "ok",
        mensagem_id: novaMensagemId,
        duracao_ms: t(),
        erro_msg: (upd.media_metadata.erro_motivo ?? upd.media_metadata.envio_incerto_motivo) as string,
        extra: {
          uazapi_status: err instanceof ZapiError ? err.status : null,
          status_envio: upd.status_envio,
        },
      });
    }
  })(supabase);

  const edge = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } })
    .EdgeRuntime;
  if (edge?.waitUntil) edge.waitUntil(tarefaEnvio);
  else tarefaEnvio.catch(() => {});

  return jsonResponse({ ok: true, mensagem_id: novaMensagemId });
});
