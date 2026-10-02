// Mantém a foto de perfil de clientes e grupos em dia (best-effort).
//
// Ordem de preferência: a foto que já veio no evento (`envelope.chat`, custo
// zero) e, se não veio, uma chamada à uazapi (/chat/details para pessoa,
// /group/info para grupo) — só quando a foto guardada passou do TTL, para não
// chamar a uazapi a cada mensagem.
// Nunca lança: foto é enfeite, não pode derrubar o registro da mensagem.

import { log } from "./logger.ts";
import { fotoVencida, instanteDeNovaTentativa, urlSegura } from "./foto-perfil.ts";
import { buscarFotoPerfil, fotoGrupo } from "./uazapi-client.ts";
import type { getSupabaseAdmin } from "./supabase-client.ts";

type Supabase = ReturnType<typeof getSupabaseAdmin>;

// Dedupe por instância da função: id → instante da última consulta à uazapi.
const COOLDOWN_CONSULTA_MS = 10 * 60 * 1000;
const consultasRecentes = new Map<string, number>();

interface AlvoFoto {
  tabela: "clients" | "grupos";
  id: string;
  /** Foto que veio no próprio evento, se veio. */
  urlConhecida: string | null;
}

interface LinhaFoto {
  foto_url: string | null;
  foto_atualizada_em: string | null;
  numero_whatsapp?: string;
  wa_jid?: string;
}

export async function atualizarFotoPerfil(
  supabase: Supabase,
  alvo: AlvoFoto,
  funcao: string,
): Promise<void> {
  try {
    // Identificador para o /chat/details: número do cliente (mesmo em chat LID)
    // ou JID do grupo.
    const colunaJid = alvo.tabela === "clients" ? "numero_whatsapp" : "wa_jid";
    const { data } = await supabase
      .from(alvo.tabela)
      .select(`foto_url, foto_atualizada_em, ${colunaJid}`)
      .eq("id", alvo.id)
      .maybeSingle();
    const atual = data as LinhaFoto | null;
    if (!atual) return;
    const jid = atual.numero_whatsapp ?? atual.wa_jid ?? "";

    const vencida = fotoVencida(atual.foto_atualizada_em, Date.now());
    const conhecida = urlSegura(alvo.urlConhecida);
    let nova: string | null;
    if (conhecida) {
      if (conhecida === atual.foto_url && !vencida) return;
      nova = conhecida;
    } else {
      if (!vencida || !jid) return;
      // Rajada de mensagens do mesmo contato: só a primeira consulta a uazapi.
      const agora = Date.now();
      if (agora - (consultasRecentes.get(alvo.id) ?? 0) < COOLDOWN_CONSULTA_MS) return;
      consultasRecentes.set(alvo.id, agora);
      try {
        // Grupo: a foto vem da /group/info (campos image_*_url); a
        // /chat/details não traz foto de grupo e costuma estourar o tempo.
        nova = alvo.tabela === "grupos" ? await fotoGrupo(jid) : await buscarFotoPerfil(jid);
      } catch (err) {
        // uazapi instável: adia a próxima tentativa (sem apagar a foto atual)
        // em vez de tentar de novo a cada mensagem.
        await supabase
          .from(alvo.tabela)
          .update({ foto_atualizada_em: instanteDeNovaTentativa(agora) })
          .eq("id", alvo.id);
        throw err;
      }
    }

    // Grava o instante mesmo sem foto: é ele que segura a próxima consulta.
    await supabase
      .from(alvo.tabela)
      .update({ foto_url: nova, foto_atualizada_em: new Date().toISOString() })
      .eq("id", alvo.id);
  } catch (err) {
    log({
      funcao,
      evento: "foto_perfil_falhou",
      status: "erro",
      erro_msg: err instanceof Error ? err.message.slice(0, 140) : String(err),
      extra: { tabela: alvo.tabela },
    });
  }
}

/** Dispara em segundo plano (não atrasa a resposta ao webhook). */
export function atualizarFotoEmSegundoPlano(
  supabase: Supabase,
  alvo: AlvoFoto,
  funcao: string,
): void {
  const tarefa = atualizarFotoPerfil(supabase, alvo, funcao);
  const edge = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } })
    .EdgeRuntime;
  if (edge?.waitUntil) edge.waitUntil(tarefa);
  else tarefa.catch(() => {});
}
