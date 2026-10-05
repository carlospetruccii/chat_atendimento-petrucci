// Resolve (ou cria) o cliente de uma mensagem da uazapi — por número E.164 ou
// por LID, com a regra brasileira do nono dígito.
//
// CÓPIA FIEL de webhook-zapi-receive/index.ts (29/09/2026), trazida para cá
// para a aba Docs (webhook-docs-receive) usar a MESMA identidade de cliente da
// Inbox. O webhook principal ainda tem a própria cópia porque estava com
// trabalho não commitado quando isto foi feito; o próximo passo é ele importar
// daqui e apagar a dele.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { log } from "./logger.ts";
import {
  conflitoDeIdentidadeCliente,
  numeroCanonicoWhatsapp,
  selecionarRegistroPorNumeroWhatsapp,
  variantesNumeroWhatsappBR,
} from "./telefone-whatsapp.ts";

// Normaliza número para E.164 com '+'. Aceita "<numero>@s.whatsapp.net",
// "@c.us", "@lid" ou dígitos puros — extrai só os dígitos e prefixa '+'.
export function normalizarNumero(n: string | null | undefined): string | null {
  if (!n) return null;
  const digits = String(n).replace(/\D/g, "");
  if (!digits) return null;
  return `+${digits}`;
}

// Mascarar número para logs: mantém DDI+DDD e últimos 2 dígitos.
export function mascararNumero(n: string | null | undefined): string | null {
  if (!n) return null;
  const d = String(n).replace(/\D/g, "");
  if (d.length < 6) return "***";
  return `${d.slice(0, 4)}***${d.slice(-2)}`;
}

// Detecta se o chatid da uazapi é LID (não E.164). Regra composta:
//  - sufixo @lid → LID
//  - sufixo @g.us → grupo (não LID, tratado pelo guard de grupo)
//  - se sender_lid existe e não há telefone (sender_pn) → LID
//  - caso contrário, assume E.164.
export function ehLid(
  chatid: string | null | undefined,
  senderLid: string | null | undefined,
  senderPn: string | null | undefined,
): boolean {
  const s = chatid ? String(chatid) : "";
  if (s.includes("@lid")) return true;
  if (s.includes("@g.us")) return false;
  // Sem telefone resolvível e com LID disponível → caminho LID.
  const temPn = senderPn && String(senderPn).replace(/\D/g, "") !== "";
  const temLid = senderLid && String(senderLid).replace(/\D/g, "") !== "";
  if (!temPn && temLid) return true;
  return false;
}

export function extrairLid(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).split("@")[0];
  const digits = s.replace(/\D/g, "");
  return digits || null;
}

// Mascara LID para logs (RNF-S10): mantém 4 primeiros e 2 últimos.
export function mascararLid(lid: string | null | undefined): string | null {
  if (!lid) return null;
  const s = String(lid);
  if (s.length < 8) return "***";
  return `${s.slice(0, 4)}***${s.slice(-2)}`;
}

export interface ClienteResolvido {
  id: string;
  nome: string | null;
  via: "e164" | "lid";
}

export type ResolverErro =
  | { erro: "sem_telefone" }
  | { erro: "lid_desconhecido"; via_tentada: "e164" | "lid" }
  | { erro: "criar_erro"; detalhe?: string };

export async function resolverClienteIdent(
  data: Record<string, unknown>,
  supabase: SupabaseClient,
  opts: {
    companyId: string;
    permitirCriar: boolean;
    senderName: string | null;
    preferChatid?: boolean;
    /** Nome da função chamadora — só para o log. */
    funcao: string;
  },
): Promise<ClienteResolvido | ResolverErro> {
  const chatid = (data.chatid as string | undefined) ?? null;
  // Em mensagens fromMe (enviadas pelo celular da empresa) o REMETENTE é a
  // empresa; o cliente é o destinatário, que vem no chatid. Nesse caso
  // ignoramos sender_pn/sender_lid (dados do nosso próprio número) e
  // identificamos o cliente exclusivamente pelo chatid.
  const senderPn = opts.preferChatid ? null : ((data.sender_pn as string | undefined) ?? null);
  const senderLid = opts.preferChatid ? null : ((data.sender_lid as string | undefined) ?? null);
  // LID normalizado: preferir sender_lid; senão o chatid quando for @lid.
  const chatLidNorm = extrairLid(senderLid) ??
    (chatid && String(chatid).includes("@lid") ? extrairLid(chatid) : null);

  if (!ehLid(chatid, senderLid, senderPn)) {
    // Caminho E.164. Número vem de sender_pn ou do chatid (@s.whatsapp.net/@c.us).
    const numero = normalizarNumero(senderPn ?? chatid);
    if (!numero) return { erro: "sem_telefone" };

    // O LID é a identidade mais forte do chat. Quando ele vem junto do número,
    // resolve primeiro por ele para não separar o histórico se o WhatsApp
    // alternar a forma brasileira com/sem o nono dígito.
    let clientePorLid: {
      id: string;
      nome: string | null;
      numero_whatsapp: string;
    } | null = null;
    if (chatLidNorm) {
      const { data: cLid, error: errLid } = await supabase
        .from("clients")
        .select("id, nome, numero_whatsapp")
        .eq("company_id", opts.companyId)
        .eq("chat_lid", chatLidNorm)
        .maybeSingle();
      if (errLid) return { erro: "criar_erro", detalhe: errLid.message };
      clientePorLid = cLid;
    }

    const { data: candidatos, error: errCandidatos } = await supabase
      .from("clients")
      .select("id, nome, chat_lid, numero_whatsapp")
      .eq("company_id", opts.companyId)
      .in("numero_whatsapp", variantesNumeroWhatsappBR(numero));
    if (errCandidatos) {
      return { erro: "criar_erro", detalhe: errCandidatos.message };
    }

    const c = selecionarRegistroPorNumeroWhatsapp(candidatos ?? [], numero);

    if (clientePorLid && chatLidNorm) {
      // Duplicado legado (mesmo número nas duas formas BR, só uma com LID) não
      // é conflito: o LID vence e a conversa segue numa linha só.
      if (conflitoDeIdentidadeCliente(clientePorLid, c, numero, chatLidNorm)) {
        return { erro: "criar_erro", detalhe: "conflito_identidade_cliente" };
      }
      if (!clientePorLid.nome && opts.senderName) {
        await supabase
          .from("clients")
          .update({ nome: opts.senderName })
          .eq("id", clientePorLid.id)
          .eq("company_id", opts.companyId);
      }
      return { id: clientePorLid.id, nome: clientePorLid.nome, via: "lid" };
    }

    if (c) {
      // Números equivalentes com LIDs diferentes não são unidos: o LID indica
      // que seriam contas de WhatsApp distintas e misturar mensagens seria pior
      // do que manter os registros separados.
      if (chatLidNorm && c.chat_lid && c.chat_lid !== chatLidNorm) {
        return { erro: "criar_erro", detalhe: "conflito_chat_lid" };
      }
      if (chatLidNorm && !c.chat_lid) {
        const { data: vinculado, error } = await supabase
          .from("clients")
          .update({ chat_lid: chatLidNorm })
          .eq("id", c.id)
          .eq("company_id", opts.companyId)
          .is("chat_lid", null)
          .select("id")
          .maybeSingle();
        if (error) return { erro: "criar_erro", detalhe: error.message };
        if (!vinculado) {
          const { data: atual, error: errAtual } = await supabase
            .from("clients")
            .select("chat_lid")
            .eq("id", c.id)
            .eq("company_id", opts.companyId)
            .maybeSingle();
          if (errAtual || atual?.chat_lid !== chatLidNorm) {
            return {
              erro: "criar_erro",
              detalhe: errAtual?.message ?? "conflito_chat_lid",
            };
          }
        } else {
          log({
            funcao: opts.funcao,
            evento: "chat_lid_populado",
            status: "ok",
            client_id: c.id,
            extra: { chat_lid_mask: mascararLid(chatLidNorm) },
          });
        }
      }
      if (!c.nome && opts.senderName) {
        await supabase
          .from("clients")
          .update({ nome: opts.senderName })
          .eq("id", c.id)
          .eq("company_id", opts.companyId);
      }
      return { id: c.id, nome: c.nome, via: "e164" };
    }

    if (!opts.permitirCriar) return { erro: "lid_desconhecido", via_tentada: "e164" };

    const numeroCanonico = numeroCanonicoWhatsapp(numero) ?? numero;
    const { data: novo, error } = await supabase
      .from("clients")
      .insert({
        company_id: opts.companyId,
        numero_whatsapp: numeroCanonico,
        nome: opts.senderName,
        chat_lid: chatLidNorm,
      })
      .select("id, nome")
      .single();
    if (error || !novo) {
      if (error?.code === "23505") {
        return await resolverClienteIdent(data, supabase, {
          ...opts,
          permitirCriar: false,
        });
      }
      return { erro: "criar_erro", detalhe: error?.message };
    }
    return { id: novo.id, nome: novo.nome, via: "e164" };
  }

  // Caminho LID.
  const lid = chatLidNorm ??
    (chatid && String(chatid).includes("@lid") ? extrairLid(chatid) : null);
  if (!lid) return { erro: "sem_telefone" };

  const { data: c } = await supabase
    .from("clients")
    .select("id, nome")
    .eq("company_id", opts.companyId)
    .eq("chat_lid", lid)
    .maybeSingle();
  if (c) return { id: c.id, nome: c.nome, via: "lid" };

  return { erro: "lid_desconhecido", via_tentada: "lid" };
}
