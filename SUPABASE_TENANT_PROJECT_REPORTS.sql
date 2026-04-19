-- Daily Supervisor field reports per tenant project (Supabase).
-- Same pattern as tenant_projects: Netlify resolves tenant from session; service_role via RLS.

create table if not exists public.tenant_project_reports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  project_id uuid not null references public.tenant_projects (id) on delete cascade,
  entry_date date not null,
  hours numeric not null default 0,
  days numeric not null default 0,
  note text,
  created_by uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tenant_project_reports_tenant_project_idx
  on public.tenant_project_reports (tenant_id, project_id);

create index if not exists tenant_project_reports_tenant_entry_date_idx
  on public.tenant_project_reports (tenant_id, entry_date);

alter table public.tenant_project_reports enable row level security;

drop policy if exists "service role full access tenant_project_reports" on public.tenant_project_reports;
create policy "service role full access tenant_project_reports"
on public.tenant_project_reports for all to service_role using (true) with check (true);
