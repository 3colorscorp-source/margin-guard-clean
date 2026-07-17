-- =============================================================================
-- Margin Guard | CH-004A1 — Project Contract Setup Foundation
-- =============================================================================
-- STATUS: MANUAL SUPABASE APPLY REQUIRED
--
-- Apply manually in Supabase SQL Editor only after owner review.
-- Do not run from CI. Do not apply automatically.
--
-- ADDITIVE SCOPE:
--   * public.project_contract_setups
--
-- NOT IN THIS MIGRATION:
--   * payment schedules or payment schedule items
--   * contracts, signatures, executed documents, or audit records
--   * changes to quotes, tenant_projects, invoices, or existing tables
--
-- ROLLBACK (manual, only if required before production data exists):
--   drop table if exists public.project_contract_setups cascade;
-- =============================================================================

create table if not exists public.project_contract_setups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  project_id uuid not null references public.tenant_projects (id) on delete cascade,
  quote_id uuid not null references public.quotes (id) on delete cascade,

  property_address_line1 text not null default ''
    check (char_length(property_address_line1) <= 200),
  property_address_line2 text not null default ''
    check (char_length(property_address_line2) <= 200),
  property_city text not null default ''
    check (char_length(property_city) <= 120),
  property_state text not null default ''
    check (char_length(property_state) <= 80),
  property_postal_code text not null default ''
    check (char_length(property_postal_code) <= 32),
  property_confirmed_at timestamptz null,

  warranty_duration_value integer null
    check (warranty_duration_value is null or warranty_duration_value >= 0),
  warranty_duration_unit text not null default 'months'
    check (warranty_duration_unit in ('days', 'months', 'years')),
  warranty_summary text not null default ''
    check (char_length(warranty_summary) <= 4000),
  warranty_exclusions text not null default ''
    check (char_length(warranty_exclusions) <= 4000),
  warranty_confirmed_at timestamptz null,

  signature_method text not null default 'not_configured'
    check (signature_method in ('sign_on_device', 'email_link', 'both', 'not_configured')),

  state_module_code text not null default ''
    check (char_length(state_module_code) <= 80),
  state_notice_pack_status text not null default 'unsupported'
    check (state_notice_pack_status in ('approved', 'unsupported', 'missing', 'not_applicable')),
  state_notice_pack_version text not null default ''
    check (char_length(state_notice_pack_version) <= 80),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint project_contract_setups_tenant_project_quote_key
    unique (tenant_id, project_id, quote_id)
);

comment on table public.project_contract_setups is
  'Tenant-scoped project contract setup. Confirmation timestamps are server-controlled. State notice metadata does not claim legal compliance.';

comment on column public.project_contract_setups.tenant_id is
  'Resolved from authenticated server session only; never accepted from browser input.';

comment on column public.project_contract_setups.property_confirmed_at is
  'Set by the Owner/Admin endpoint only after explicit confirmation of structured property fields.';

comment on column public.project_contract_setups.warranty_confirmed_at is
  'Set by the Owner/Admin endpoint only after explicit confirmation of entered warranty terms.';

comment on column public.project_contract_setups.state_notice_pack_status is
  'Legal-module availability metadata only. Approved requires a separately reviewed notice pack.';

create index if not exists project_contract_setups_tenant_id_idx
  on public.project_contract_setups (tenant_id);

create index if not exists project_contract_setups_tenant_project_idx
  on public.project_contract_setups (tenant_id, project_id);

create index if not exists project_contract_setups_tenant_quote_idx
  on public.project_contract_setups (tenant_id, quote_id);

drop trigger if exists trg_project_contract_setups_updated_at
  on public.project_contract_setups;
create trigger trg_project_contract_setups_updated_at
before update on public.project_contract_setups
for each row execute function public.set_updated_at();

alter table public.project_contract_setups enable row level security;

drop policy if exists "service role full access project_contract_setups"
  on public.project_contract_setups;
create policy "service role full access project_contract_setups"
on public.project_contract_setups
for all
to service_role
using (true)
with check (true);

-- No anon or authenticated policies. Browser access is through Netlify handlers.
-- This migration inserts no rows.
