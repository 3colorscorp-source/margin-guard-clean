-- Supervisor change orders per tenant project (Supabase).
-- Same pattern as tenant_project_reports: Netlify resolves tenant from session; service_role via RLS.

create table if not exists public.tenant_project_change_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  project_id uuid not null references public.tenant_projects (id) on delete cascade,
  title text not null default '',
  notes text,
  worker_days numeric not null default 0,
  recommended_price numeric not null default 0,
  client_price numeric not null default 0,
  status text not null default 'draft'
    check (status in ('draft', 'applied', 'cancelled')),
  created_by uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tenant_project_change_orders_tenant_project_idx
  on public.tenant_project_change_orders (tenant_id, project_id);

create index if not exists tenant_project_change_orders_tenant_status_idx
  on public.tenant_project_change_orders (tenant_id, status);

create index if not exists tenant_project_change_orders_tenant_created_at_idx
  on public.tenant_project_change_orders (tenant_id, created_at desc);

alter table public.tenant_project_change_orders enable row level security;

drop policy if exists "service role full access tenant_project_change_orders" on public.tenant_project_change_orders;
create policy "service role full access tenant_project_change_orders"
on public.tenant_project_change_orders for all to service_role using (true) with check (true);
