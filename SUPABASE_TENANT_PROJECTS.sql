-- Tenant-scoped signed / supervisor-tracked projects (Supabase).
-- Enforce tenant scoping in application (Netlify) via session; RLS uses service_role pattern.

create table if not exists public.tenant_projects (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  quote_id uuid references public.quotes (id) on delete set null,
  project_name text not null default '',
  client_name text not null default '',
  client_email text not null default '',
  status text not null default 'signed'
    check (status in ('signed', 'deposit_paid', 'assigned', 'in_progress', 'completed', 'cancelled')),
  signed_at timestamptz not null default now(),
  deposit_paid boolean not null default false,
  supervisor_user_id uuid null,
  estimated_days numeric not null default 0,
  labor_budget numeric not null default 0,
  sale_price numeric not null default 0,
  recommended_price numeric not null default 0,
  minimum_price numeric not null default 0,
  due_date date null,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tenant_projects_tenant_id_idx on public.tenant_projects (tenant_id);
create index if not exists tenant_projects_tenant_status_idx on public.tenant_projects (tenant_id, status);

alter table public.tenant_projects enable row level security;

drop policy if exists "service role full access tenant_projects" on public.tenant_projects;
create policy "service role full access tenant_projects"
on public.tenant_projects for all to service_role using (true) with check (true);
