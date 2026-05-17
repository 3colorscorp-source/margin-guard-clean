-- Phase 1 — Original estimate economics on tenant_projects (additive).
-- Run in Supabase SQL Editor after public.tenant_projects exists.
-- quoted_labor_plan column already exists (SUPABASE_TENANT_PROJECTS_QUOTED_LABOR_PLAN.sql).

alter table public.tenant_projects
  add column if not exists estimated_labor_cost numeric not null default 0;

alter table public.tenant_projects
  add column if not exists estimated_material_cost numeric not null default 0;

alter table public.tenant_projects
  add column if not exists estimated_profit numeric not null default 0;

alter table public.tenant_projects
  add column if not exists estimated_profit_margin numeric not null default 0;

alter table public.tenant_projects
  add column if not exists quoted_labor_plan_locked_at timestamptz null;

update public.tenant_projects set estimated_labor_cost = 0 where estimated_labor_cost is null;
update public.tenant_projects set estimated_material_cost = 0 where estimated_material_cost is null;
update public.tenant_projects set estimated_profit = 0 where estimated_profit is null;
update public.tenant_projects set estimated_profit_margin = 0 where estimated_profit_margin is null;
