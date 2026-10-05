-- Blindagem das colunas que decidem "apagar para todos" e "editar".
--
-- O FURO QUE ISSO FECHA (achado na revisão de segurança da feature):
--
-- A edge function mensagem-acao decide se pode apagar/editar lendo a PRÓPRIA
-- LINHA: direction, sender_type, status_envio, created_at e zapi_message_id. Só
-- que o frontend insere em `mensagens` direto (UI otimista do composer, ver
-- sendInboxMessage em src/lib/inbox-queries.ts), a policy de INSERT é permissiva
-- e o enforcement de RLS está desligado em produção
-- (auth_enforcement_enabled='false'). Ou seja: um colaborador conseguia gravar
-- uma linha dizendo "sou uma mensagem de atendente, já enviada, e meu id no
-- WhatsApp é <id de QUALQUER mensagem da instância>" — inclusive de mensagem de
-- GRUPO ou do outro sistema da empresa, que vivem fora do UNIQUE de
-- mensagens.zapi_message_id e por isso não colidiam. Um POST em mensagem-acao
-- depois disso apagava aquela mensagem para todos, irreversivelmente.
--
-- Isso furava justamente as duas travas que a feature tem por escrito: o filtro
-- de sender_type em _shared/janelas-whatsapp.ts (que existe para NINGUÉM apagar
-- documento enviado pelo sistema de contabilidade) e a nota de que grupo não
-- oferece apagar/editar.
--
-- Duas camadas independentes, porque cada uma cobre o que a outra não pega:
-- privilégio de coluna vale mesmo com RLS aberta, e o trigger sobrevive a um
-- GRANT ALL de alguma migration futura.

-- ————————————————————————————————————————————————————————————————
-- 1) Privilégio: INSERT só nas colunas que o cliente tem direito de escrever
-- ————————————————————————————————————————————————————————————————
-- ATENÇÃO À ORDEM E À FORMA. `REVOKE INSERT (coluna)` num papel que tem INSERT
-- no NÍVEL DA TABELA não faz o que parece: o Postgres derruba o grant de tabela
-- inteiro e NÃO cria grants por coluna para as restantes — o papel fica sem
-- INSERT nenhum. (Foi exatamente o que aconteceu na primeira tentativa desta
-- migration: o composer do inbox parou com "permission denied for table
-- mensagens".) O idioma correto é revogar no nível da tabela e conceder por
-- coluna, nesta ordem.
--
-- Privilégio de INSERT só é verificado nas colunas realmente citadas no comando,
-- então as de servidor ficam inalcançáveis pelo cliente e company_id continua
-- vindo do default.
--
-- A lista é exatamente o que sendInboxMessage envia. Mídia e áudio não entram:
-- passam por send-whatsapp-media / send-whatsapp-audio, que usam service_role.
REVOKE INSERT ON public.mensagens FROM anon, authenticated;

GRANT INSERT (
  atendimento_id,
  client_id,
  department_id,
  direction,
  sender_type,
  sent_by_user_id,
  tipo,
  content,
  status_envio,
  reply_to_message_id,
  otimizado_ia,
  content_original
) ON public.mensagens TO anon, authenticated;

-- grupo_mensagens o frontend nem toca (todo envio de grupo passa pela edge
-- function grupo-enviar), então aqui é só fechar a porta.
REVOKE INSERT ON public.grupo_mensagens FROM anon, authenticated;

-- Não se mexe no privilégio de UPDATE: o frontend não faz UPDATE em mensagens,
-- mas derrubar o grant quebraria em silêncio qualquer caminho não mapeado. A
-- trava de UPDATE fica no trigger abaixo, que é onde ela é verificável.

-- ————————————————————————————————————————————————————————————————
-- 2) Trilha do que foi destruído
-- ————————————————————————————————————————————————————————————————
-- Apagar zera content/media_url e editar sobrescreve content. Sem guardar o
-- anterior, um atendente pode mandar algo indevido e, em 15 minutos, reescrever
-- o histórico — e o sistema não saberia dizer o que o cliente realmente recebeu.
-- Num sistema de atendimento é o registro que resolve disputa.
--
-- Mesmo espírito de content_original (20260803121500): coluna só de servidor,
-- nunca exposta na tela.
ALTER TABLE public.mensagens
  ADD COLUMN IF NOT EXISTS conteudo_anterior text;

COMMENT ON COLUMN public.mensagens.conteudo_anterior IS
  'Último texto que o cliente viu antes de a mensagem ser editada ou apagada. '
  'Preenchido só pela edge function mensagem-acao. NULL = nunca editada nem '
  'apagada (ou apagada sem texto, caso de mídia).';

-- ————————————————————————————————————————————————————————————————
-- 3) Trigger: quem pode carimbar
-- ————————————————————————————————————————————————————————————————
-- Corpo = versão de 20260806120000 mais as travas novas.
--
-- `current_user = 'service_role'` é o padrão que o repo já usa em
-- block_mensagem_delete. NÃO é bypass geral: as travas de identidade e de
-- otimizado_ia continuam valendo para todo mundo, service_role incluído. É
-- permissão pontual para as colunas que só a edge function pode escrever.
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
  -- no WhatsApp. Fora do servidor ninguém escreve nela — nem preenchendo do
  -- zero, nem trocando. Sem o "nem do zero", sobrava o caminho: inserir pelo
  -- composer (id NULL) e depois dar UPDATE colocando o id de uma mensagem
  -- alheia junto com status_envio='enviado'.
  IF NOT eh_servidor AND NEW.zapi_message_id IS DISTINCT FROM OLD.zapi_message_id THEN
    RAISE EXCEPTION 'zapi_message_id só é gravado pelo servidor';
  END IF;

  -- Para o servidor, a troca é restrita à edição (que gera id novo no WhatsApp)
  -- e só avançando editada_em — repetir o carimbo com data antiga não reabre a
  -- troca.
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

  -- Sem isto, com a RLS aberta, dava para (a) fazer uma mensagem do outro
  -- sistema desaparecer da tela sem nunca ter sido apagada no WhatsApp e (b)
  -- assinar o apagar com o id de outra pessoa, falsificando a única trilha de
  -- autoria que esta feature cria.
  IF NOT eh_servidor THEN
    IF NEW.apagada_em IS DISTINCT FROM OLD.apagada_em
       OR NEW.apagada_por_user_id IS DISTINCT FROM OLD.apagada_por_user_id
       OR NEW.editada_em IS DISTINCT FROM OLD.editada_em
       OR NEW.conteudo_anterior IS DISTINCT FROM OLD.conteudo_anterior THEN
      RAISE EXCEPTION 'apagar/editar mensagem só pelo servidor (edge function mensagem-acao)';
    END IF;
  END IF;

  -- Apagar é irreversível no WhatsApp; no banco também. Vale para o servidor
  -- inclusive: é o que torna o carimbo do webhook idempotente (o evento Deleted
  -- chega depois de a edge function já ter carimbado).
  IF OLD.apagada_em IS NOT NULL AND NEW.apagada_em IS DISTINCT FROM OLD.apagada_em THEN
    RAISE EXCEPTION 'apagada_em é imutável após a mensagem ser apagada';
  END IF;

  IF OLD.editada_em IS NOT NULL AND NEW.editada_em IS NULL THEN
    RAISE EXCEPTION 'editada_em não pode ser removido';
  END IF;

  RETURN NEW;
END;
$function$;
