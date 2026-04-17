-- Sales discount approval queue (tenant-scoped). Run in Supabase SQL editor after public.tenants exists.
-- Used by Netlify function create-sales-approval.js (service role insert).

create table if not exists public.sales_approvals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  project_name text not null default '',
  client_name text not null default '',
  client_email text not null default '',
  offered_price numeric not null default 0,
  recommended_price numeric not null default 0,
  minimum_price numeric not null default 0,
  workers jsonb not null default '[]'::jsonb,
  status text not null default 'requested',
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  approved_at timestamptz
);

create index if not exists sales_approvals_tenant_id_idx
  on public.sales_approvals (tenant_id);

create index if not exists sales_approvals_tenant_created_idx
  on public.sales_approvals (tenant_id, created_at desc);

alter table public.sales_approvals enable row level security;

drop policy if exists "service role full access sales_approvals" on public.sales_approvals;
create policy "service role full access sales_approvals"
on public.sales_approvals
for all
to service_role
using (true)
with check (true);
