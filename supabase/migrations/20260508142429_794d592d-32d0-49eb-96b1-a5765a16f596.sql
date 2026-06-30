-- Enum estágio da triagem do bot
CREATE TYPE public.triagem_estagio AS ENUM (
  'aguardando_inicio',
  'aguardando_departamento',
  'aguardando_assunto',
  'concluida'
);

-- Colunas em atendimentos
ALTER TABLE public.atendimentos
  ADD COLUMN triagem_estagio public.triagem_estagio NOT NULL DEFAULT 'aguardando_inicio',
  ADD COLUMN triagem_tentativas integer NOT NULL DEFAULT 0;

-- Atualiza atendimentos legados em triagem
UPDATE public.atendimentos
   SET triagem_estagio = 'aguardando_inicio'
 WHERE status = 'em_triagem';

-- Índice para varredura do cron
CREATE INDEX IF NOT EXISTS idx_atendimentos_triagem_cron
  ON public.atendimentos (status, triagem_estagio, last_message_at)
  WHERE status = 'em_triagem';