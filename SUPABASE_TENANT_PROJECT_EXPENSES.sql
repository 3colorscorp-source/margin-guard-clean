-- Supervisor unexpected expenses per tenant project (Supabase).
-- Same pattern as tenant_project_reports: Netlify resolves tenant from session; service_role via RLS.

create table if not exists public.tenant_project_expenses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  project_id uuid not null references public.tenant_projects (id) on delete cascade,
  expense_date date not null,
  amount numeric not null default 0,
  note text,
  created_by uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tenant_project_expenses_tenant_project_idx
  on public.tenant_project_expenses (tenant_id, project_id);

create index if not exists tenant_project_expenses_tenant_expense_date_idx
  on public.tenant_project_expenses (tenant_id, expense_date);

alter table public.tenant_project_expenses enable row level security;

drop policy if exists "service role full access tenant_project_expenses" on public.tenant_project_expenses;
create policy "service role full access tenant_project_expenses"
on public.tenant_project_expenses for all to service_role using (true) with check (true);
