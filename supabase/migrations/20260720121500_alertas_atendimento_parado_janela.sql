-- Dedup atômico anti-corrida do alerta de atendimento parado: uma linha por
-- (atendimento, janela de repetição). O cron reivindica a janela com
-- ON CONFLICT DO NOTHING e só envia quem cria a linha — fecha a corrida
-- read-then-insert (evita aviso duplicado no WhatsApp pessoal do responsável
-- quando o cron é disparado de forma concorrente).
ALTER TABLE public.alertas_atendimento_parado
  ADD COLUMN IF NOT EXISTS janela timestamptz;

UPDATE public.alertas_atendimento_parado SET janela = created_at WHERE janela IS NULL;

ALTER TABLE public.alertas_atendimento_parado
  ALTER COLUMN janela SET NOT NULL;

ALTER TABLE public.alertas_atendimento_parado
  ADD CONSTRAINT alertas_atend_parado_uniq_atend_janela UNIQUE (atendimento_id, janela);

-- Índice antigo (servia à leitura "última notificação", agora substituída pelo
-- claim por janela) fica redundante — o UNIQUE acima já indexa por atendimento.
DROP INDEX IF EXISTS public.idx_alertas_atend_parado_atend_created;
