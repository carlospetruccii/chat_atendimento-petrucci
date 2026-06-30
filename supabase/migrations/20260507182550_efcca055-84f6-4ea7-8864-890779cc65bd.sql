-- Extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- Enums (idempotent)
DO $$ BEGIN
  CREATE TYPE public.status_atendimento AS ENUM ('em_triagem','reservado','pendente','em_atendimento','encerrado');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.sender_type AS ENUM ('cliente','atendente','bot','sistema','externo');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.close_reason AS ENUM ('manual_atendente','manual_supervisor','automatico_inatividade');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.status_envio_mensagem AS ENUM ('aguardando_envio','enviando','enviado','falha');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.status_whatsapp_mensagem AS ENUM ('enviado','entregue','lido','falha_whatsapp');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.direction_mensagem AS ENUM ('inbound','outbound');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.tipo_mensagem AS ENUM ('texto','imagem','audio','documento','video','sticker','localizacao','contato');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.tipo_evento_timeline AS ENUM ('criado','triagem_iniciada','triagem_concluida','atribuido','reservado','iniciado_atendimento','repassado','escalado','encerrado');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.tipo_system_config AS ENUM ('numero','texto','booleano','data');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;