-- Denormalized profit metrics on tenant_projects (updated by recalc-project-profit Netlify function).

alter table public.tenant_projects
  add column if not exists labor_consumed_total numeric not null default 0;

alter table public.tenant_projects
  add column if not exists unexpected_expense_total numeric not null default 0;

alter table public.tenant_projects
  add column if not exists real_profit_total numeric not null default 0;

alter table public.tenant_projects
  add column if not exists real_margin_pct numeric not null default 0;

update public.tenant_projects set labor_consumed_total = 0 where labor_consumed_total is null;
update public.tenant_projects set unexpected_expense_total = 0 where unexpected_expense_total is null;
update public.tenant_projects set real_profit_total = 0 where real_profit_total is null;
update public.tenant_projects set real_margin_pct = 0 where real_margin_pct is null;
