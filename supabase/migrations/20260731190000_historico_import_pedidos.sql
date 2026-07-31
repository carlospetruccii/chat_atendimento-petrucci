-- ============================================================================
-- Importação de histórico ANTIGO do WhatsApp (uazapi POST /message/history-sync)
--
-- Contexto: a uazapi guarda no banco dela apenas os últimos 7 dias
-- ("mensagens mais antigas do que 7 dias são excluídas durante a madrugada",
-- doc de /instance/connect), então POST /message/find — usado pelo backfill de
-- mensagens externas — NÃO alcança o período anterior à entrada do webhook.
-- O único caminho é pedir o histórico ao WhatsApp via /message/history-sync,
-- que é ASSÍNCRONO: as mensagens voltam depois, no evento `history` do webhook.
--
-- Esta tabela é o ledger desses pedidos. Ela existe por um motivo de segurança,
-- não de relatório: o evento `history` também dispara sozinho numa reconexão de
-- QR code, e sem um pedido registrado a função webhook-historico não tem como
-- saber se aquele lote foi pedido por alguém ou caiu do céu. Sem pedido aberto
-- para o chat, o lote é DESCARTADO.
-- ============================================================================

CREATE TABLE public.historico_import_pedidos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  -- JID do chat na uazapi (ex: 5511999999999@s.whatsapp.net).
  chatid text NOT NULL,
  -- Mensagem usada como âncora no pedido (messageid cru, sem o prefixo owner:).
  -- A uazapi busca para TRÁS a partir dela. NULL = a instância escolhe a mais
  -- antiga que ela conhece.
  ancora_messageid text,
  -- Piso: mensagem anterior a isto é descartada na importação. Impede que um
  -- pedido de "uma semana" traga anos de conversa.
  desde timestamptz NOT NULL,
  -- Teto: só importamos o que é anterior a isto (é o que ainda não temos).
  ate timestamptz NOT NULL,
  solicitado_em timestamptz NOT NULL DEFAULT now(),
  -- Janela de aceitação. Passou disso, evento `history` desse chat é ignorado.
  expira_em timestamptz NOT NULL,
  recebidas integer NOT NULL DEFAULT 0,
  inseridas integer NOT NULL DEFAULT 0,
  CONSTRAINT historico_import_pedidos_janela_chk CHECK (desde < ate),
  CONSTRAINT historico_import_pedidos_expira_chk CHECK (expira_em > solicitado_em)
);

-- Busca do webhook: "existe pedido aberto para este chat?" — chatid + validade.
CREATE INDEX idx_historico_import_pedidos_chatid_expira
  ON public.historico_import_pedidos (chatid, expira_em DESC);
CREATE INDEX idx_historico_import_pedidos_company_id
  ON public.historico_import_pedidos (company_id);
CREATE INDEX idx_historico_import_pedidos_client_id
  ON public.historico_import_pedidos (client_id);

ALTER TABLE public.historico_import_pedidos ENABLE ROW LEVEL SECURITY;

-- Só leitura, e só para quem é da empresa. Escrita é exclusiva das Edge
-- Functions (service_role, que ignora RLS): nenhum usuário autenticado pode
-- abrir uma janela de importação pela API — isso autorizaria gravar mensagem
-- com autoria e data arbitrárias em `mensagens`.
CREATE POLICY historico_import_pedidos_select ON public.historico_import_pedidos
  FOR SELECT TO authenticated
  USING (public.is_member_of(company_id));

COMMENT ON TABLE public.historico_import_pedidos IS
  'Ledger dos pedidos de histórico antigo à uazapi (/message/history-sync). Um evento `history` só é aceito se houver pedido não expirado para o chat.';
