// Aba "Docs" em Configurações: quem pode acessar a aba Docs (número financeiro)
// e o estado da conexão desse número. O acesso é gravado só pela RPC
// docs_definir_acesso (admin) — policies do banco barram escrita direta.

import { supabase } from "@/integrations/supabase/client";

export interface AcessoDocsRow {
  user_id: string;
  nome: string | null;
  department_id: string | null;
  department_nome: string | null;
  is_superadmin: boolean;
  tem_acesso: boolean;
}

export interface AcessosOrganizados {
  /** Admins sempre têm acesso — aparecem só para informar. */
  admins: AcessoDocsRow[];
  colaboradores: AcessoDocsRow[];
  totalComAcesso: number;
}

export interface StatusConexaoDocs {
  ok: boolean;
  erro?: string;
  connected?: boolean;
  loggedIn?: boolean;
  status?: string | null;
  profileName?: string | null;
  numero?: string | null;
  webhook_configurado?: boolean;
}

export interface ResumoConexaoDocs {
  tom: "ok" | "alerta" | "erro";
  titulo: string;
  detalhe: string;
  numero: string | null;
  precisaWebhook: boolean;
}

const porNome = (a: AcessoDocsRow, b: AcessoDocsRow): number => {
  if (!a.nome) return b.nome ? 1 : 0;
  if (!b.nome) return -1;
  return a.nome.localeCompare(b.nome, "pt-BR", { sensitivity: "base" });
};

export function organizarAcessos(rows: readonly AcessoDocsRow[]): AcessosOrganizados {
  const ordenadas = [...rows].sort(porNome);
  return {
    admins: ordenadas.filter((r) => r.is_superadmin),
    colaboradores: ordenadas.filter((r) => !r.is_superadmin),
    totalComAcesso: ordenadas.filter((r) => r.tem_acesso).length,
  };
}

/** Códigos das RPCs do Docs → frase curta para o toast. */
export function mensagemErroAcessoDocs(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "42501") return "Só um admin pode mudar quem acessa o Docs.";
  if (code === "P0002") return "Colaborador não encontrado.";
  if (code === "22023") return "Pedido inválido.";
  return "Não foi possível salvar. Tente de novo.";
}

export function resumoConexaoDocs(s: StatusConexaoDocs): ResumoConexaoDocs {
  const numero = s.numero ? `+${s.numero}` : null;
  if (!s.ok) {
    if (s.erro === "credenciais_ausentes") {
      return {
        tom: "erro",
        titulo: "Número financeiro não configurado",
        detalhe: "O secret UAZAPI_TOKEN_FINANCEIRO não está cadastrado no servidor.",
        numero,
        precisaWebhook: false,
      };
    }
    return {
      tom: "erro",
      titulo: "Não foi possível consultar o número",
      detalhe: "A uazapi não respondeu. Tente de novo em instantes.",
      numero,
      precisaWebhook: false,
    };
  }
  if (!s.connected || !s.loggedIn) {
    return {
      tom: "erro",
      titulo: "Número financeiro desconectado",
      detalhe:
        "O número é do outro sistema da Almore (envio de documentos). Reconecte por lá — esta tela não desconecta nem gera QR de propósito.",
      numero,
      precisaWebhook: s.webhook_configurado !== true,
    };
  }
  if (s.webhook_configurado !== true) {
    return {
      tom: "alerta",
      titulo: "Conectado, mas as conversas ainda não chegam aqui",
      detalhe:
        "Falta ligar o webhook do Docs. Ele é adicionado ao lado do que já existe — o outro sistema não é afetado.",
      numero,
      precisaWebhook: true,
    };
  }
  return {
    tom: "ok",
    titulo: "Conectado e recebendo",
    detalhe: s.profileName ?? "Número financeiro",
    numero,
    precisaWebhook: false,
  };
}

// ——— I/O ———

export async function listarAcessoDocs(): Promise<AcessoDocsRow[]> {
  const { data, error } = await supabase.rpc("docs_listar_acesso");
  if (error) throw error;
  return (data ?? []) as AcessoDocsRow[];
}

export async function definirAcessoDocs(userId: string, permitir: boolean): Promise<void> {
  const { error } = await supabase.rpc("docs_definir_acesso", {
    p_user_id: userId,
    p_permitir: permitir,
  });
  if (error) throw error;
}

async function chamarConexao(action: "status" | "webhook_setup"): Promise<StatusConexaoDocs> {
  const { data, error } = await supabase.functions.invoke("docs-conexao", { body: { action } });
  if (error) throw error;
  return data as StatusConexaoDocs;
}

export const statusConexaoDocs = () => chamarConexao("status");
export const configurarWebhookDocs = () => chamarConexao("webhook_setup");

// ——— Resposta automática do número financeiro ———
// Texto no template `docs_aviso_somente_documentos` (mesma tabela da aba
// Templates); `ativo` liga/desliga. O backend manda no máximo 1x a cada 3h por
// cliente e nunca com a conversa em andamento (webhook-docs-receive).

export const CHAVE_TEMPLATE_AVISO_DOCS = "docs_aviso_somente_documentos";
const MAX_CHARS_AVISO = 1000;

export interface AvisoDocs {
  id: string;
  texto: string;
  variacoes: string[];
  ativo: boolean;
}

export function validarTextoAvisoDocs(texto: string): { ok: boolean; alerta: string | null } {
  const t = texto.trim();
  if (!t) return { ok: false, alerta: "Escreva o texto do aviso." };
  if (t.length > MAX_CHARS_AVISO) {
    return { ok: false, alerta: `Texto longo demais (máximo ${MAX_CHARS_AVISO} caracteres).` };
  }
  if (!/wa\.me\//i.test(t)) {
    return { ok: true, alerta: "O texto não tem o link do atendimento (wa.me/…)." };
  }
  return { ok: true, alerta: null };
}

export async function buscarAvisoDocs(): Promise<AvisoDocs | null> {
  const { data, error } = await supabase
    .from("templates_mensagem")
    .select("id, texto, variacoes, ativo")
    .eq("chave", CHAVE_TEMPLATE_AVISO_DOCS)
    .maybeSingle();
  if (error) throw error;
  return data
    ? { id: data.id, texto: data.texto, variacoes: data.variacoes ?? [], ativo: data.ativo }
    : null;
}
