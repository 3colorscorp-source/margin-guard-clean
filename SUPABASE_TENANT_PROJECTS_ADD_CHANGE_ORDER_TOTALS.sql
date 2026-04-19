-- Track applied change-order revenue on tenant_projects for Supervisor / reporting.

alter table public.tenant_projects
  add column if not exists applied_change_order_total numeric not null default 0;

alter table public.tenant_projects
  add column if not exists projected_revenue_total numeric null;

-- Backfill: never overwrite non-null projected_revenue_total.
update public.tenant_projects
set applied_change_order_total = 0
where applied_change_order_total is null;

update public.tenant_projects
set projected_revenue_total = sale_price
where projected_revenue_total is null
  and sale_price is not null;
