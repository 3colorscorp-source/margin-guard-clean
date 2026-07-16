-- =============================================================================
-- Margin Guard | CH-001A — Contract Foundation (Tenant Legal + Preferences)
-- =============================================================================
-- STATUS: MANUAL SUPABASE APPLY REQUIRED
--
-- Apply manually in Supabase SQL Editor after owner review.
-- Do not run from CI. Do not apply automatically.
--
-- PREREQUISITES:
--   * public.tenants (SUPABASE_MARGIN_GUARD_MULTITENANT.sql)
--   * public.set_updated_at() trigger function
--
-- SCOPE (additive only):
--   * tenant_legal_profiles
--   * tenant_contract_preferences
--
-- NOT IN THIS MIGRATION:
--   * trade_profiles / tenant_trade_profiles tables
--   * tenant_project_properties
--   * contract / snapshot / signature tables
--   * changes to quotes, tenant_projects, invoices, tenants core
--
-- ROLLBACK (manual, after apply):
--   drop table if exists public.tenant_contract_preferences cascade;
--   drop table if exists public.tenant_legal_profiles cascade;
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. tenant_legal_profiles — one row per tenant (contractor legal identity)
-- -----------------------------------------------------------------------------

create table if not exists public.tenant_legal_profiles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique references public.tenants (id) on delete cascade,

  legal_business_name text not null default '',
  dba_name text not null default '',
  entity_type text not null default '',

  business_address_line1 text not null default '',
  business_address_line2 text not null default '',
  business_city text not null default '',
  business_state text not null default '',
  business_postal_code text not null default '',

  mailing_same_as_business boolean not null default true,
  mailing_address_line1 text not null default '',
  mailing_address_line2 text not null default '',
  mailing_city text not null default '',
  mailing_state text not null default '',
  mailing_postal_code text not null default '',

  business_phone text not null default '',
  business_email text not null default '',

  contractor_license_status text not null default 'unknown'
    check (contractor_license_status in ('licensed', 'not_required', 'exempt', 'unknown')),
  contractor_license_number text not null default '',
  contractor_license_classification text not null default '',
  contractor_license_state text not null default '',
  contractor_license_expiration date null,

  bond_company text not null default '',
  bond_number text not null default '',
  general_liability_carrier text not null default '',
  general_liability_policy_number text not null default '',
  workers_comp_status text not null default '',
  workers_comp_carrier text not null default '',
  workers_comp_policy_number text not null default '',

  authorized_signer_name text not null default '',
  authorized_signer_title text not null default '',

  primary_service_state text not null default '',
  timezone text not null default '',
  default_contract_language text not null default 'en'
    check (default_contract_language in ('en', 'es', 'bilingual')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.tenant_legal_profiles is
  'Tenant-scoped legal identity for contract preparation. Netlify handlers MUST derive tenant_id from session — never trust client body.';

comment on column public.tenant_legal_profiles.tenant_id is
  'One legal profile per tenant. Unique constraint enforces isolation.';

create index if not exists tenant_legal_profiles_tenant_id_idx
  on public.tenant_legal_profiles (tenant_id);

drop trigger if exists trg_tenant_legal_profiles_updated_at on public.tenant_legal_profiles;
create trigger trg_tenant_legal_profiles_updated_at
before update on public.tenant_legal_profiles
for each row execute function public.set_updated_at();

alter table public.tenant_legal_profiles enable row level security;

drop policy if exists "service role full access tenant_legal_profiles" on public.tenant_legal_profiles;
create policy "service role full access tenant_legal_profiles"
on public.tenant_legal_profiles
for all
to service_role
using (true)
with check (true);

-- -----------------------------------------------------------------------------
-- 2. tenant_contract_preferences — one row per tenant (universal contract defaults)
-- -----------------------------------------------------------------------------

create table if not exists public.tenant_contract_preferences (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique references public.tenants (id) on delete cascade,

  primary_trade_module text not null default 'custom'
    check (primary_trade_module in (
      'general_remodeling',
      'tile_installation',
      'flooring',
      'roofing',
      'plumbing',
      'electrical',
      'hvac',
      'painting',
      'landscaping',
      'cleaning',
      'handyman',
      'concrete',
      'solar',
      'pool_service',
      'custom'
    )),
  custom_trade_label text not null default '',

  default_contract_name text not null default '',
  default_warranty_duration_value integer null
    check (default_warranty_duration_value is null or default_warranty_duration_value >= 0),
  default_warranty_duration_unit text not null default 'months'
    check (default_warranty_duration_unit in ('days', 'months', 'years')),
  change_order_requirement text not null default 'price_change_only'
    check (change_order_requirement in ('always', 'price_change_only', 'optional')),
  require_customer_initials boolean not null default true,
  default_signer_mode text not null default 'one_customer'
    check (default_signer_mode in ('one_customer', 'all_property_owners', 'custom')),
  default_contract_language text not null default 'en'
    check (default_contract_language in ('en', 'es', 'bilingual')),
  dispute_resolution_preference text not null default 'unset'
    check (dispute_resolution_preference in ('court', 'mediation', 'arbitration', 'unset')),
  default_signature_order text not null default 'customer_first'
    check (default_signature_order in ('customer_first', 'contractor_first', 'any_order')),
  automatically_attach_warranty boolean not null default false,
  automatically_attach_completion_certificate boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.tenant_contract_preferences is
  'Tenant business defaults for contract workflow. Not legal compliance settings. Trade-specific fields belong in future Trade Modules.';

comment on column public.tenant_contract_preferences.primary_trade_module is
  'Universal trade module code from in-app registry (contract-trade-modules.js). Not a database FK in CH-001A.';

create index if not exists tenant_contract_preferences_tenant_id_idx
  on public.tenant_contract_preferences (tenant_id);

drop trigger if exists trg_tenant_contract_preferences_updated_at on public.tenant_contract_preferences;
create trigger trg_tenant_contract_preferences_updated_at
before update on public.tenant_contract_preferences
for each row execute function public.set_updated_at();

alter table public.tenant_contract_preferences enable row level security;

drop policy if exists "service role full access tenant_contract_preferences" on public.tenant_contract_preferences;
create policy "service role full access tenant_contract_preferences"
on public.tenant_contract_preferences
for all
to service_role
using (true)
with check (true);

-- No anon or authenticated policies — browser access via Netlify functions only.
