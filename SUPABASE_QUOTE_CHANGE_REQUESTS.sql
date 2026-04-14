-- Public client workflow: additional work / change-order requests (per quote, multi-tenant).
-- Run in Supabase SQL editor after public.quotes exists.

create table if not exists public.quote_change_requests (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes (id) on delete cascade,
  tenant_id uuid not null,
  public_token text not null,
  request_title text not null default '',
  request_description text not null default '',
  request_area text not null default '',
  preferred_timing text not null default '',
  status text not null default 'submitted',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists quote_change_requests_tenant_id_idx
  on public.quote_change_requests (tenant_id);

create index if not exists quote_change_requests_public_token_idx
  on public.quote_change_requests (public_token);

create index if not exists quote_change_requests_quote_id_idx
  on public.quote_change_requests (quote_id);
