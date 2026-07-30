-- Registro dos avisos INTERNOS que o sistema manda por WhatsApp.
--
-- Contexto: a instância uazapi é compartilhada com outros sistemas da Almore, e
-- o webhook passou a receber o eco de tudo que sai pela API (é assim que as
-- mensagens do sistema de contabilidade aparecem na Inbox). Só que as NOSSAS
-- notificações internas ("Novo atendimento pra você", alerta de atendimento
-- parado) também saem pela API — e vão para o WhatsApp de colaboradores. Cinco
-- pessoas da equipe também existem em `clients`, então esses avisos virariam
-- mensagem na conversa de cliente delas.
--
-- Antes o webhook resolvia isso pulando todo eco destinado a número de
-- colaborador, o que jogava fora junto os documentos legítimos da contabilidade
-- enviados a essas mesmas pessoas. Com esta tabela o corte é preciso: quem
-- manda o aviso registra o id aqui, e o webhook ignora exatamente esses ids —
-- qualquer outra coisa que chegue no número continua aparecendo.
--
-- Escrita/leitura só pelo service_role das Edge Functions.

create table if not exists public.envios_internos_whatsapp (
  uazapi_message_id text primary key,
  criado_em timestamptz not null default now()
);

comment on table public.envios_internos_whatsapp is
  'Ids de mensagens WhatsApp que sao aviso interno do sistema: o webhook nao as registra como mensagem de conversa.';

-- Serve para a limpeza periódica: a linha só é consultada nos segundos
-- seguintes ao envio (janela do eco), depois vira histórico descartável.
create index if not exists idx_envios_internos_criado_em
  on public.envios_internos_whatsapp (criado_em);

alter table public.envios_internos_whatsapp enable row level security;

-- Sem policies de propósito: nenhum papel do PostgREST (anon/authenticated)
-- deve enxergar ou escrever aqui. O service_role das Edge Functions bypassa RLS.
revoke all on public.envios_internos_whatsapp from anon, authenticated;
