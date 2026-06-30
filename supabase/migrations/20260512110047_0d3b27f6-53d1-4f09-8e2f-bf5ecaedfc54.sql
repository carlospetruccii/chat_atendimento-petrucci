create table public.cleanup_log (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  message_id uuid,
  zapi_message_id text,
  client_id uuid,
  phone text,
  acao text not null check (acao in (
    'deletada_sucesso','delete_falhou','mantida_por_regra','dry_run_apagar','dry_run_manter'
  )),
  motivo text,
  zapi_response jsonb,
  executed_at timestamptz not null default now()
);
create index cleanup_log_run_id_idx on public.cleanup_log(run_id);
alter table public.cleanup_log enable row level security;
create policy cleanup_log_admin_select on public.cleanup_log
  for select to authenticated using (current_user_is_superadmin());