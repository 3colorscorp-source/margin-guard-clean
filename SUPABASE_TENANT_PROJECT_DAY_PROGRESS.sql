-- Per-day Supervisor execution progress (tenant-scoped, no financial fields).

create table if not exists public.tenant_project_day_progress (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  project_id uuid not null references public.tenant_projects (id) on delete cascade,
  operational_snapshot_id uuid null,
  day_number integer not null check (day_number > 0),
  status text not null default 'pending'
    check (status in ('pending', 'completed', 'skipped', 'delayed')),
  completed_at timestamptz null,
  completed_by uuid null,
  completion_note text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists tenant_project_day_progress_unique_day
  on public.tenant_project_day_progress (tenant_id, project_id, day_number);

create index if not exists tenant_project_day_progress_tenant_project_idx
  on public.tenant_project_day_progress (tenant_id, project_id);

alter table public.tenant_project_day_progress enable row level security;

drop policy if exists "service role full access tenant_project_day_progress" on public.tenant_project_day_progress;
create policy "service role full access tenant_project_day_progress"
on public.tenant_project_day_progress for all to service_role using (true) with check (true);

-- Optional day linkage on existing field tables (nullable, backward-compatible):
alter table public.tenant_project_reports
  add column if not exists day_number integer null,
  add column if not exists phase text null;

alter table public.tenant_project_expenses
  add column if not exists day_number integer null,
  add column if not exists phase text null;
