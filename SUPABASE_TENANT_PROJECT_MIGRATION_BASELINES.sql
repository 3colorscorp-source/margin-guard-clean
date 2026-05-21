-- Migrated project baseline (Square / external) — Supervisor field timeline, not contract $.
-- Run after public.tenant_projects exists.

create table if not exists public.tenant_project_migration_baselines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  project_id uuid not null references public.tenant_projects (id) on delete cascade,
  external_source text not null default 'Square',
  actual_start_date date null,
  target_finish_date date null,
  estimated_total_days numeric not null default 0,
  days_completed_to_date numeric not null default 0,
  progress_pct numeric not null default 0,
  current_phase text null,
  remaining_scope_notes text null,
  original_contract_reference text null,
  baseline_set_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tenant_project_migration_baselines_tenant_project_unique unique (tenant_id, project_id)
);

create index if not exists tenant_project_migration_baselines_tenant_idx
  on public.tenant_project_migration_baselines (tenant_id);

create index if not exists tenant_project_migration_baselines_project_idx
  on public.tenant_project_migration_baselines (project_id);
