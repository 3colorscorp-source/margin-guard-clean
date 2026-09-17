-- =============================================================================
-- Margin Guard | CH-082 — Tenant Standard Warranty Preset
-- =============================================================================
-- STATUS: MANUAL SUPABASE APPLY REQUIRED
--
-- Apply manually in Supabase SQL Editor after owner review.
-- Do not run from CI. Do not apply automatically.
--
-- PREREQUISITES:
--   * public.tenant_contract_preferences (SUPABASE_CH001A_CONTRACT_FOUNDATION.sql)
--
-- SCOPE (additive, idempotent):
--   * default_warranty_enabled boolean not null default false
--   * default_warranty_summary text not null default ''
--   * default_warranty_exclusions text not null default ''
--   * char_length <= 4000 checks on summary and exclusions
--
-- NOT IN THIS MIGRATION:
--   * Contract Builder UI
--   * project_contract_setups
--   * frozen packages / snapshots / PDFs / signatures
--   * warranty_notice legal-notice text
--   * RLS policy changes
--   * backfill from existing contracts or fixtures
--   * automatically_attach_warranty (unchanged)
--
-- Existing rows receive enabled=false and empty summary/exclusions via
-- column defaults. That is not copied contract language.
-- =============================================================================

do $$
begin
  if to_regclass('public.tenant_contract_preferences') is null then
    raise exception 'CH-082 blocked: missing public.tenant_contract_preferences';
  end if;
end
$$;

alter table public.tenant_contract_preferences
  add column if not exists default_warranty_enabled boolean not null default false,
  add column if not exists default_warranty_summary text not null default '',
  add column if not exists default_warranty_exclusions text not null default '';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tenant_contract_preferences_default_warranty_summary_len'
      and conrelid = 'public.tenant_contract_preferences'::regclass
  ) then
    alter table public.tenant_contract_preferences
      add constraint tenant_contract_preferences_default_warranty_summary_len
      check (char_length(default_warranty_summary) <= 4000);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'tenant_contract_preferences_default_warranty_exclusions_len'
      and conrelid = 'public.tenant_contract_preferences'::regclass
  ) then
    alter table public.tenant_contract_preferences
      add constraint tenant_contract_preferences_default_warranty_exclusions_len
      check (char_length(default_warranty_exclusions) <= 4000);
  end if;
end
$$;

comment on column public.tenant_contract_preferences.default_warranty_enabled is
  'When true, this tenant authored a complete standard warranty that may be offered on future drafts. Does not auto-confirm or mutate existing or frozen contracts. Distinct from automatically_attach_warranty.';

comment on column public.tenant_contract_preferences.default_warranty_summary is
  'Tenant-authored warranty coverage summary. Empty by default. Not a legal-notice field and not a global Margin Guard template.';

comment on column public.tenant_contract_preferences.default_warranty_exclusions is
  'Tenant-authored warranty exclusions. Empty by default. Not copied from contracts, fixtures, or legal notices.';
