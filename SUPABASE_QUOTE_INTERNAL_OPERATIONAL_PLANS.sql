-- Phase 1 Voice Operational Plan — dedicated internal table.
-- DO NOT apply this file to remote Supabase from this PR.
-- Never select or return this table from public estimate, accept, PDF, email, or Zapier.

create table if not exists public.quote_internal_operational_plans (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  document jsonb not null,
  schema_version integer not null default 1,
  last_updated_by_membership_id uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint quote_internal_operational_plans_tenant_quote_uidx unique (tenant_id, quote_id),
  constraint quote_internal_operational_plans_document_object
    check (jsonb_typeof(document) = 'object')
);

comment on table public.quote_internal_operational_plans is
  'Tenant-internal structured daily operational plan. Service-role Netlify only. Never expose on public quote APIs.';

comment on column public.quote_internal_operational_plans.document is
  'Versioned JSON: schema_version, source, days[].day_id, client_scope, internal tasks/assignments. No labor rates.';

comment on column public.quote_internal_operational_plans.last_updated_by_membership_id is
  'Membership id that last confirmed the plan, when the session has one.';

create index if not exists quote_internal_operational_plans_quote_id_idx
  on public.quote_internal_operational_plans (quote_id);

alter table public.quote_internal_operational_plans enable row level security;
alter table public.quote_internal_operational_plans force row level security;

revoke all on table public.quote_internal_operational_plans from public;
revoke all on table public.quote_internal_operational_plans from anon;
revoke all on table public.quote_internal_operational_plans from authenticated;

grant select, insert, update, delete on table public.quote_internal_operational_plans to service_role;

drop policy if exists "service role full access quote_internal_operational_plans"
  on public.quote_internal_operational_plans;

create policy "service role full access quote_internal_operational_plans"
  on public.quote_internal_operational_plans
  for all
  to service_role
  using (true)
  with check (true);
