-- Quoted labor plan (read-only in Supervisor). Run once in Supabase if the column is missing.
alter table public.tenant_projects
  add column if not exists quoted_labor_plan jsonb not null default '[]'::jsonb;
