-- Immutable operational execution plan per signed project (Supervisor reads this later).
-- Run after tenant_projects + quotes exist.

create table if not exists public.tenant_project_operational_snapshots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  project_id uuid not null references public.tenant_projects (id) on delete cascade,
  quote_id uuid null references public.quotes (id) on delete set null,
  operational_plan jsonb not null default '[]'::jsonb,
  estimated_days numeric not null default 0,
  estimated_hours numeric not null default 0,
  worker_count integer not null default 0,
  commitment_date date null,
  locked_at timestamptz not null default now(),
  source text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tenant_project_operational_snapshots_tenant_project_unique unique (tenant_id, project_id)
);

create index if not exists tenant_project_operational_snapshots_tenant_idx
  on public.tenant_project_operational_snapshots (tenant_id);

create index if not exists tenant_project_operational_snapshots_project_idx
  on public.tenant_project_operational_snapshots (project_id);

-- If table already exists without commitment_date:
alter table public.tenant_project_operational_snapshots
  add column if not exists commitment_date date null;
