// Edge Function: cadastrar-cliente
// Cria/atualiza clientes em modo single ou csv_batch.
// Auth: JWT obrigatório. Modo single: qualquer membro ativo (é o primeiro passo
// do "Conversar" na tela de Contatos). Modo csv_batch: is_superadmin OR
// has_permission('view_all_departments').
// UPSERT por identidade WhatsApp (móvel BR com/sem nono dígito => mesmo cliente).

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";
import { exigirMembroAtivo } from "../_shared/empresa.ts";
import {
  numeroCanonicoWhatsapp,
  selecionarRegistroPorNumeroWhatsapp,
  variantesNumeroWhatsappBR,
} from "../_shared/telefone-whatsapp.ts";
import { podeCadastrarCliente, podeRenomearClienteExistente } from "./logic.ts";

const FUNCAO = "cadastrar-cliente";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const E164 = /^\+[1-9][0-9]{7,14}$/;

interface LinhaIn {
  nome?: string;
  telefone?: string;
}
interface PayloadSingle {
  modo: "single";
  nome: string;
  telefone: string;
  /** true = cliente já existente fica com o nome atual (ex.: cartão de contato recebido). */
  manter_nome_existente?: boolean;
}
interface PayloadBatch {
  modo: "csv_batch";
  linhas: LinhaIn[];
}
type Payload = PayloadSingle | PayloadBatch;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function normalizarTelefone(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  // Remove tudo que não for dígito ou +.
  const limpo = trimmed.replace(/[^\d+]/g, "");
  let comPais = limpo;
  if (!comPais.startsWith("+")) {
    // Se já começa com 55 e tem 12-13 dígitos, prefixa +; senão prefixa +55.
    if (/^55\d{10,11}$/.test(comPais)) {
      comPais = "+" + comPais;
    } else {
      comPais = "+55" + comPais;
    }
  }
  return E164.test(comPais) ? comPais : null;
}

function nomeValido(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  return trimmed.length >= 2 ? trimmed : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, erro: "method_not_allowed" }, 405);

  const cron = iniciarCronometro();
  const supabase = getSupabaseAdmin();

  // Auth
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  if (!jwt) return json({ ok: false, erro: "unauthorized" }, 401);

  const { data: userRes, error: errUser } = await supabase.auth.getUser(jwt);
  if (errUser || !userRes?.user) return json({ ok: false, erro: "unauthorized" }, 401);
  const userId = userRes.user.id;

  // O payload vem antes da checagem de permissão porque o portão depende do
  // modo: cadastro avulso é liberado para qualquer membro, importação em lote
  // não.
  let payload: Payload;
  try {
    payload = (await req.json()) as Payload;
  } catch {
    return json({ ok: false, erro: "payload_invalido" }, 400);
  }
  if (payload?.modo !== "single" && payload?.modo !== "csv_batch") {
    return json({ ok: false, erro: "payload_invalido", detalhe: "modo inválido" }, 400);
  }

  // A importação em lote é ação administrativa. A configuração
  // clientes_visivel_para_todos controla somente leitura/visibilidade e não
  // pode conceder escrita.
  const [{ data: userRow }, { data: permRow }] = await Promise.all([
    supabase.from("users").select("is_superadmin").eq("id", userId).maybeSingle(),
    supabase
      .from("user_permissions")
      .select("permission")
      .eq("user_id", userId)
      .eq("permission", "view_all_departments")
      .maybeSingle(),
  ]);
  if (
    !podeCadastrarCliente({
      isSuperadmin: Boolean(userRow?.is_superadmin),
      hasViewAllDepartments: Boolean(permRow),
      modo: payload.modo,
    })
  ) {
    log({ funcao: FUNCAO, evento: "forbidden", status: "erro", duracao_ms: cron() });
    return json(
      {
        ok: false,
        erro: "forbidden",
        detalhe: "Somente administradores podem importar contatos em lote.",
      },
      403,
    );
  }

  // Empresa do chamador: `clients` é único por (company_id, numero_whatsapp),
  // então o UPSERT precisa do company_id — sem ele o ON CONFLICT não casa com
  // nenhum índice e o Postgres devolve 42P10.
  const membro = await exigirMembroAtivo(supabase, userId);
  if (!membro) {
    log({ funcao: FUNCAO, evento: "sem_vinculo_empresa", status: "erro", duracao_ms: cron() });
    return json(
      { ok: false, erro: "forbidden", detalhe: "Seu usuário não está vinculado a uma empresa." },
      403,
    );
  }
  const companyId = membro.companyId;

  // Modo single
  if (payload.modo === "single") {
    const nome = nomeValido(payload.nome);
    const telefone = normalizarTelefone(payload.telefone);
    if (!nome) return json({ ok: false, erro: "nome_invalido", detalhe: "Nome deve ter ao menos 2 caracteres" }, 400);
    if (!telefone) {
      return json(
        { ok: false, erro: "telefone_invalido", detalhe: "Telefone fora do padrão E.164" },
        400,
      );
    }

    // O WhatsApp pode representar o mesmo celular BR com ou sem o nono
    // dígito. Procura as duas formas antes de criar para manter um único
    // client_id (e, portanto, um único histórico de conversa).
    const { data: candidatos, error: errExistente } = await supabase
      .from("clients")
      .select("id, nome, numero_whatsapp")
      .eq("company_id", companyId)
      .in("numero_whatsapp", variantesNumeroWhatsappBR(telefone));

    if (errExistente) {
      log({
        funcao: FUNCAO,
        evento: "select_existente_single_erro",
        status: "erro",
        duracao_ms: cron(),
        erro_msg: errExistente.message,
      });
      return json({ ok: false, erro: "erro_interno" }, 500);
    }

    const existente = selecionarRegistroPorNumeroWhatsapp(candidatos ?? [], telefone);
    const podeRenomear = podeRenomearClienteExistente({
      isSuperadmin: Boolean(userRow?.is_superadmin),
      hasViewAllDepartments: Boolean(permRow),
    });
    if (existente && (payload.manter_nome_existente === true || !podeRenomear)) {
      log({
        funcao: FUNCAO,
        evento: "existente_mantido_single",
        status: "ok",
        duracao_ms: cron(),
        client_id: existente.id,
      });
      return json({
        ok: true,
        criado: false,
        atualizado: false,
        cliente: existente,
        nome_anterior: existente.nome ?? null,
      });
    }
    if (existente) {
      const { data: atualizado, error: errAtualizar } = await supabase
        .from("clients")
        .update({ nome, updated_at: new Date().toISOString() })
        .eq("id", existente.id)
        .eq("company_id", companyId)
        .select("id, nome, numero_whatsapp")
        .single();

      if (errAtualizar || !atualizado) {
        log({
          funcao: FUNCAO,
          evento: "update_single_erro",
          status: "erro",
          duracao_ms: cron(),
          erro_msg: errAtualizar?.message,
        });
        return json({ ok: false, erro: "erro_interno" }, 500);
      }

      log({
        funcao: FUNCAO,
        evento: "update_single_ok",
        status: "ok",
        duracao_ms: cron(),
        client_id: atualizado.id,
      });
      return json({
        ok: true,
        criado: false,
        atualizado: true,
        cliente: atualizado,
        nome_anterior: existente.nome ?? null,
      });
    }

    // Clientes novos usam uma forma estável (com o nono dígito quando móvel
    // BR), assim chamadas simultâneas das duas variantes disputam a mesma
    // constraint UNIQUE em vez de criarem duas pessoas.
    const telefoneCanonico = numeroCanonicoWhatsapp(telefone) ?? telefone;

    const { data: up, error: errUp } = await supabase
      .from("clients")
      .upsert(
        {
          company_id: companyId,
          nome,
          numero_whatsapp: telefoneCanonico,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "company_id,numero_whatsapp" },
      )
      .select("id, nome, numero_whatsapp")
      .single();

    if (errUp) {
      log({ funcao: FUNCAO, evento: "upsert_single_erro", status: "erro", duracao_ms: cron(), erro_msg: errUp.message });
      return json({ ok: false, erro: "erro_interno" }, 500);
    }

    log({ funcao: FUNCAO, evento: "upsert_single_ok", status: "ok", duracao_ms: cron(), client_id: up.id });
    return json({
      ok: true,
      criado: true,
      atualizado: false,
      cliente: up,
      nome_anterior: null,
    });
  }

  // Modo csv_batch
  if (payload.modo === "csv_batch") {
    const linhas = Array.isArray(payload.linhas) ? payload.linhas : [];
    if (linhas.length === 0) return json({ ok: false, erro: "linhas_vazias" }, 400);
    if (linhas.length > 5000) return json({ ok: false, erro: "limite_excedido", detalhe: "Máximo 5000 linhas por importação" }, 400);

    interface ErroLinha {
      linha: number;
      motivo: string;
      nome?: string;
      telefone?: string;
    }
    const erros: ErroLinha[] = [];
    const validosPorTelefone = new Map<string, { nome: string; telefone: string }>();

    linhas.forEach((l, idx) => {
      const numLinha = idx + 2; // header é linha 1
      const nome = nomeValido(l?.nome);
      const telefone = normalizarTelefone(l?.telefone);
      if (!nome) {
        erros.push({ linha: numLinha, motivo: "nome inválido", nome: l?.nome, telefone: l?.telefone });
        return;
      }
      if (!telefone) {
        erros.push({ linha: numLinha, motivo: "telefone inválido", nome: l?.nome, telefone: l?.telefone });
        return;
      }
      // Última ocorrência equivalente ganha. Assim o próprio CSV não cria
      // duas linhas para o mesmo móvel BR com/sem o nono dígito.
      const telefoneCanonico = numeroCanonicoWhatsapp(telefone) ?? telefone;
      validosPorTelefone.set(telefoneCanonico, { nome, telefone: telefoneCanonico });
    });

    const validos = Array.from(validosPorTelefone.values());

    // Checa as duas variantes para também reaproveitar clientes legados cujo
    // número principal ainda esteja salvo sem o nono dígito.
    const clientesExistentes: Array<{ id: string; numero_whatsapp: string }> = [];
    if (validos.length > 0) {
      const tels = Array.from(
        new Set(validos.flatMap((v) => variantesNumeroWhatsappBR(v.telefone))),
      );
      // Mantém cada filtro abaixo do limite de URL e de linhas do Data API.
      // Sem lotes, um CSV grande poderia omitir um cliente legado e recriá-lo.
      const TAMANHO_LOTE_BUSCA = 200;
      for (let inicio = 0; inicio < tels.length; inicio += TAMANHO_LOTE_BUSCA) {
        const lote = tels.slice(inicio, inicio + TAMANHO_LOTE_BUSCA);
        const { data: jaTem, error: errSel } = await supabase
          .from("clients")
          .select("id, numero_whatsapp")
          .eq("company_id", companyId)
          .in("numero_whatsapp", lote);
        if (errSel) {
          log({
            funcao: FUNCAO,
            evento: "select_existentes_erro",
            status: "erro",
            duracao_ms: cron(),
            erro_msg: errSel.message,
          });
          return json({ ok: false, erro: "erro_interno" }, 500);
        }
        clientesExistentes.push(...(jaTem ?? []));
      }
    }

    let criados = 0;
    let atualizados = 0;

    if (validos.length > 0) {
      const now = new Date().toISOString();
      const rowsAtualizar: Array<Record<string, string>> = [];
      const rowsCriar: Array<Record<string, string>> = [];

      for (const v of validos) {
        const existente = selecionarRegistroPorNumeroWhatsapp(clientesExistentes, v.telefone);
        if (existente) {
          rowsAtualizar.push({
            company_id: companyId,
            nome: v.nome,
            numero_whatsapp: existente.numero_whatsapp,
            updated_at: now,
          });
        } else {
          rowsCriar.push({
            company_id: companyId,
            nome: v.nome,
            numero_whatsapp: v.telefone,
            updated_at: now,
          });
        }
      }

      const { error: errUp } = await supabase
        .from("clients")
        .upsert([...rowsAtualizar, ...rowsCriar], {
          onConflict: "company_id,numero_whatsapp",
        });
      if (errUp) {
        log({ funcao: FUNCAO, evento: "upsert_batch_erro", status: "erro", duracao_ms: cron(), erro_msg: errUp.message });
        return json({ ok: false, erro: "erro_interno" }, 500);
      }
      atualizados = rowsAtualizar.length;
      criados = rowsCriar.length;
    }

    // Audit log
    await supabase.from("config_audit_log").insert({
      user_id: userId,
      entidade: "clients",
      entidade_id: "importacao_csv_em_massa",
      campo: "csv_upload",
      valor_anterior: null,
      valor_novo: JSON.stringify({
        total: linhas.length,
        criados,
        atualizados,
        erros: erros.length,
        timestamp: new Date().toISOString(),
      }),
    });

    log({
      funcao: FUNCAO,
      evento: "csv_batch_ok",
      status: "ok",
      duracao_ms: cron(),
      extra: { total: linhas.length, criados, atualizados, erros: erros.length },
    });

    return json({
      ok: true,
      total: linhas.length,
      criados,
      atualizados,
      erros,
    });
  }

  return json({ ok: false, erro: "modo_invalido" }, 400);
});
