UPDATE public.system_config SET valor = 'true', updated_at = now() WHERE chave = 'bot_ativo';
UPDATE public.system_config SET valor = NULL, updated_at = now() WHERE chave = 'bot_ativacao_programada';