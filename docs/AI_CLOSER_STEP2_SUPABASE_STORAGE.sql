-- AI Closer Step 2 — isolated starter pre-quote storage (NOT official quotes).
-- Run in Supabase SQL editor after public.tenants exists.
-- These tables are separate from public.quotes, invoices, and production workflows.

-- ---------------------------------------------------------------------------
-- ai_closer_tenant_settings — per-tenant AI Closer lab/production settings JSON
-- ---------------------------------------------------------------------------
create table if not exists public.ai_closer_tenant_settings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  settings_json jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id)
);

comment on table public.ai_closer_tenant_settings is
  'Isolated AI Closer tenant settings. Not used by production quote or invoice workflows.';

create index if not exists ai_closer_tenant_settings_tenant_id_idx
  on public.ai_closer_tenant_settings (tenant_id);

-- ---------------------------------------------------------------------------
-- ai_closer_prequotes — client starter pre-quotes / leads for owner review
-- ---------------------------------------------------------------------------
create table if not exists public.ai_closer_prequotes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  tenant_slug text,
  source text not null default 'ai_closer_client',
  status text not null default 'new',
  project_name text,
  work_type text,
  unit_type text,
  scope_size numeric,
  estimated_crew_days numeric,
  range_low numeric,
  range_high numeric,
  client_budget text,
  budget_signal text,
  zoom_slot text,
  target_date text,
  scope_notes text,
  plan_file_name text,
  current_photo_name text,
  inspiration_photo_name text,
  client_name text,
  client_email text,
  client_phone text,
  preferred_contact text,
  client_notes text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.ai_closer_prequotes is
  'Isolated AI Closer starter pre-quotes. Not official quotes — leads for owner review only.';

create index if not exists ai_closer_prequotes_tenant_created_idx
  on public.ai_closer_prequotes (tenant_id, created_at desc);

create index if not exists ai_closer_prequotes_tenant_status_idx
  on public.ai_closer_prequotes (tenant_id, status);

create index if not exists ai_closer_prequotes_client_email_idx
  on public.ai_closer_prequotes (client_email);

-- updated_at triggers (reuses public.set_updated_at when present)
drop trigger if exists trg_ai_closer_tenant_settings_updated_at on public.ai_closer_tenant_settings;
create trigger trg_ai_closer_tenant_settings_updated_at
before update on public.ai_closer_tenant_settings
for each row
execute function public.set_updated_at();

drop trigger if exists trg_ai_closer_prequotes_updated_at on public.ai_closer_prequotes;
create trigger trg_ai_closer_prequotes_updated_at
before update on public.ai_closer_prequotes
for each row
execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS — enabled; no broad public SELECT. Server functions use service_role.
-- ---------------------------------------------------------------------------
alter table public.ai_closer_tenant_settings enable row level security;
alter table public.ai_closer_prequotes enable row level security;

drop policy if exists "service role full access ai_closer_tenant_settings" on public.ai_closer_tenant_settings;
create policy "service role full access ai_closer_tenant_settings"
on public.ai_closer_tenant_settings
for all
to service_role
using (true)
with check (true);

drop policy if exists "service role full access ai_closer_prequotes" on public.ai_closer_prequotes;
create policy "service role full access ai_closer_prequotes"
on public.ai_closer_prequotes
for all
to service_role
using (true)
with check (true);
