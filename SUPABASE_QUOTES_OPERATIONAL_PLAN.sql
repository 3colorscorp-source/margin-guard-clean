-- Operational execution plan on quotes (Send Estimate → public accept bridge).
-- Run in Supabase SQL editor before publishing quotes with an operational plan.

alter table public.quotes add column if not exists operational_plan jsonb default '[]'::jsonb;
alter table public.quotes add column if not exists start_date date null;
alter table public.quotes add column if not exists due_date date null;
alter table public.quotes add column if not exists estimated_days numeric null;
alter table public.quotes add column if not exists estimated_hours numeric null;
alter table public.quotes add column if not exists operational_estimated_days_override numeric null;
alter table public.quotes add column if not exists operational_estimated_hours_override numeric null;

comment on column public.quotes.operational_plan is 'Normalized day-by-day crew schedule captured at publish time';
comment on column public.quotes.start_date is 'Planned project start date at publish time';
comment on column public.quotes.due_date is 'Target finish / commitment date at publish time';
