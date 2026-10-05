-- Apagar para todos passa a alcançar o que saiu do CELULAR da empresa.
--
-- O QUE MUDA, E POR QUÊ ISTO É UMA MIGRATION:
--
-- Até aqui, todo `sender_type='externo'` era intocável (ver o filtro em
-- _shared/janelas-whatsapp.ts). Só que 'externo' é um balde com duas coisas bem
-- diferentes, e o webhook já as separa desde 30/07/2026 em
-- `media_metadata.origem`:
--
--   'celular'     → alguém NOSSO digitou no WhatsApp (ou Web) do número da
--                   empresa. Apagar é o mesmo gesto de apagar o que se mandou
--                   pelo sistema.
--   'api_externa' → o outro sistema da empresa (envio de documentos) usando a
--                   mesma instância uazapi. Continua proibido: apagar documento
--                   dele é dano sem volta.
--
-- A partir de agora a edge function `mensagem-acao` DECIDE com base nesse campo.
-- E aí ele deixa de ser rótulo e vira controle de acesso — precisa da mesma
-- blindagem que `zapi_message_id` ganhou em 20260806174453.
--
-- O FURO QUE ISSO FECHA (mesma família do anterior): `authenticated` tem UPDATE
-- em TODAS as colunas de `mensagens` e o enforcement de RLS está desligado em
-- produção (auth_enforcement_enabled='false'). Sem esta migration, um
-- colaborador poderia dar UPDATE em `media_metadata` de uma mensagem
-- 'api_externa' trocando a origem para 'celular' e, no POST seguinte a
-- mensagem-acao, apagar para todos um documento do outro sistema — exatamente o
-- dano que a feature diz impedir por escrito.
--
-- Duas camadas, como na 20260806174453: o trigger (verificável, sobrevive a um
-- GRANT ALL futuro) e o privilégio (vale mesmo com a RLS aberta).

-- ————————————————————————————————————————————————————————————————
-- 1) Trigger: media_metadata é escrita só pelo servidor
-- ————————————————————————————————————————————————————————————————
-- Corpo = versão vigente em produção (conferida via prosrc, md5
-- 3ae747cfdc0915e46091fc6ff08b66aa) mais o bloco novo. Reescrever a partir de
-- uma versão anterior desfaria as travas de otimizado_ia e de apagar/editar.
--
-- Quem escreve media_metadata hoje, todos com service_role: o webhook (grava a
-- `origem` no INSERT), _shared/midia-mensagem.ts (carimba o arquivo baixado) e
-- a própria mensagem-acao (esvazia ao apagar). O frontend não faz UPDATE nenhum
-- em `mensagens` — só o INSERT do composer, e `media_metadata` nem está entre as
-- colunas que ele pode inserir.
CREATE OR REPLACE FUNCTION public.protect_mensagem_immutable_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  eh_servidor boolean := current_user = 'service_role';
BEGIN
  IF NEW.atendimento_id IS DISTINCT FROM OLD.atendimento_id
     OR NEW.client_id IS DISTINCT FROM OLD.client_id
     OR NEW.direction IS DISTINCT FROM OLD.direction
     OR NEW.sender_type IS DISTINCT FROM OLD.sender_type
     OR NEW.sent_by_user_id IS DISTINCT FROM OLD.sent_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.reply_to_message_id IS DISTINCT FROM OLD.reply_to_message_id THEN
    RAISE EXCEPTION 'Campos de identidade da mensagem são imutáveis após inserção';
  END IF;

  -- zapi_message_id é a chave que a edge function usa para decidir o que apagar
  -- no WhatsApp. Fora do servidor, ninguém escreve nela — nem preenchendo do
  -- zero, nem trocando.
  IF NOT eh_servidor AND NEW.zapi_message_id IS DISTINCT FROM OLD.zapi_message_id THEN
    RAISE EXCEPTION 'zapi_message_id só é gravado pelo servidor';
  END IF;

  -- Para o servidor, a troca continua restrita à edição (que gera id novo no
  -- WhatsApp) e só avançando editada_em — repetir o carimbo com data antiga não
  -- reabre a troca.
  IF OLD.zapi_message_id IS NOT NULL
     AND NEW.zapi_message_id IS DISTINCT FROM OLD.zapi_message_id
     AND NOT (
       NEW.editada_em IS NOT NULL
       AND NEW.editada_em > COALESCE(OLD.editada_em, '-infinity'::timestamptz)
     ) THEN
    RAISE EXCEPTION 'zapi_message_id é imutável após preenchido (troca só na edição)';
  END IF;

  IF NEW.otimizado_ia IS DISTINCT FROM OLD.otimizado_ia
     OR NEW.content_original IS DISTINCT FROM OLD.content_original THEN
    RAISE EXCEPTION 'A marca de otimização por IA é imutável após o envio';
  END IF;

  -- NOVO: media_metadata carrega `origem`, que decide se uma mensagem 'externo'
  -- pode ser apagada para todos. Reescrevê-la do cliente é o mesmo que forjar a
  -- autorização. A coluna inteira é fechada (e não só a chave `origem`) porque
  -- nenhum caminho de cliente escreve nela, então não há o que preservar.
  IF NOT eh_servidor AND NEW.media_metadata IS DISTINCT FROM OLD.media_metadata THEN
    RAISE EXCEPTION 'media_metadata só é gravado pelo servidor';
  END IF;

  IF NOT eh_servidor THEN
    IF NEW.apagada_em IS DISTINCT FROM OLD.apagada_em
       OR NEW.apagada_por_user_id IS DISTINCT FROM OLD.apagada_por_user_id
       OR NEW.editada_em IS DISTINCT FROM OLD.editada_em
       OR NEW.conteudo_anterior IS DISTINCT FROM OLD.conteudo_anterior THEN
      RAISE EXCEPTION 'apagar/editar mensagem só pelo servidor (edge function mensagem-acao)';
    END IF;
  END IF;

  IF OLD.apagada_em IS NOT NULL AND NEW.apagada_em IS DISTINCT FROM OLD.apagada_em THEN
    RAISE EXCEPTION 'apagada_em é imutável após a mensagem ser apagada';
  END IF;

  IF OLD.editada_em IS NOT NULL AND NEW.editada_em IS NULL THEN
    RAISE EXCEPTION 'editada_em não pode ser removido';
  END IF;

  RETURN NEW;
END;
$function$;

-- ————————————————————————————————————————————————————————————————
-- 2) Trigger de INSERT: a segunda camada que faltava
-- ————————————————————————————————————————————————————————————————
-- `trg_mensagens_protect_immutable` é BEFORE **UPDATE**. No INSERT, a única
-- coisa que impede o cliente de escrever `media_metadata` e `zapi_message_id` é
-- o GRANT por coluna da 20260806174453 — uma camada só. Um
-- `GRANT INSERT ON public.mensagens TO authenticated` no nível de tabela, em
-- qualquer migration futura, reabriria o ataque inteiro: inserir uma linha
-- dizendo `sender_type='externo'`, `status_envio='enviado'`,
-- `zapi_message_id=<id do documento da contabilidade>` e
-- `media_metadata={"origem":"celular"}` e apagá-la para todos.
--
-- Trigger separado porque o de UPDATE não serve: lá `OLD` existe, e todas as
-- comparações `IS DISTINCT FROM OLD.x` estourariam num INSERT.
CREATE OR REPLACE FUNCTION public.protect_mensagem_insert_server_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF current_user <> 'service_role'
     AND (NEW.media_metadata IS NOT NULL OR NEW.zapi_message_id IS NOT NULL) THEN
    RAISE EXCEPTION 'media_metadata e zapi_message_id só são gravados pelo servidor';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_mensagens_protect_insert ON public.mensagens;
CREATE TRIGGER trg_mensagens_protect_insert
  BEFORE INSERT ON public.mensagens
  FOR EACH ROW EXECUTE FUNCTION public.protect_mensagem_insert_server_only();

-- Não quebra nada hoje: o INSERT do composer (sendInboxMessage) não cita
-- nenhuma das duas colunas, e nenhuma função SECURITY DEFINER insere em
-- `public.mensagens` (as duas que parecem, enviar_mensagem_interna e
-- enviar_midia_interna, escrevem em `mensagens_internas`).

-- ————————————————————————————————————————————————————————————————
-- 3) Privilégio: o cliente não faz UPDATE em mensagens. Ponto.
-- ————————————————————————————————————————————————————————————————
-- A 20260806174453 deixou o UPDATE de fora de propósito ("derrubar o grant
-- quebraria em silêncio qualquer caminho não mapeado"). O caminho foi mapeado
-- agora: `from("mensagens")` no frontend aparece 10 vezes e são 9 SELECT + 1
-- INSERT (sendInboxMessage). Nenhum UPDATE.
--
-- As RPCs que atualizam mensagens (assumir_atendimento, claim_pendente,
-- assign_pendente_a_usuario, carimba_mensagens_triagem) são SECURITY DEFINER:
-- rodam como o dono da função e não dependem deste grant.
--
-- Diferente do INSERT, aqui não há coluna a preservar, então é revogação simples
-- — não se aplica a armadilha do REVOKE por coluna documentada na 20260806174453.
REVOKE UPDATE ON public.mensagens FROM anon, authenticated;

COMMENT ON COLUMN public.mensagens.media_metadata IS
  'Metadados do anexo e, nas mensagens ''externo'', a chave `origem` '
  '(''celular'' = digitada no WhatsApp do número da empresa; ''api_externa'' = '
  'outro sistema na mesma instância uazapi). `origem` é autorização, não '
  'rótulo: mensagem-acao só apaga para todos o que é nosso ou ''celular''. '
  'Escrita exclusivamente pelo servidor (trigger protect_mensagem_immutable_fields).';

-- ————————————————————————————————————————————————————————————————
-- Nota operacional
-- ————————————————————————————————————————————————————————————————
-- `eh_servidor` é `current_user = 'service_role'`, então nem o `postgres`
-- escreve media_metadata daqui pra frente — inclui sessão do Studio, do MCP e
-- de migrations futuras. O caso concreto e provável é backfillar `origem` nas
-- linhas 'externo' anteriores a 30/07/2026: vai levar exceção. Quando for
-- preciso, o caminho é assumir o papel na mesma transação:
--
--   BEGIN; SET LOCAL ROLE service_role; UPDATE public.mensagens SET ...; COMMIT;
--
-- É de propósito: quem escreve nesse campo está escrevendo autorização.
