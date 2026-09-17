-- =============================================================================
-- Margin Guard | CH-084 — Require contractor signature (tenant preference)
-- =============================================================================
-- STATUS: MANUAL SUPABASE APPLY REQUIRED
--
-- Apply manually in Supabase SQL Editor after owner review.
-- Do not run from CI. Do not apply automatically.
-- Apply this file, then SUPABASE_CH084_REQUIRE_CONTRACTOR_SIGNATURE_VERIFY.sql
-- BEFORE merging the application PR.
--
-- PREREQUISITES:
--   * public.tenant_contract_preferences (SUPABASE_CH001A_CONTRACT_FOUNDATION.sql)
--
-- SCOPE (additive, idempotent):
--   * require_contractor_signature boolean not null default false
--
-- Existing rows stay false via the column default. That is not a backfill of
-- dual-party signing. Frozen packages, envelopes, certificates, PDFs, and
-- completed signatures are not rewritten.
--
-- Application freeze copies the live preference into snapshot_json.signing_policy.
-- Snapshots without that field remain customer-only.
--
-- Three Colors Corp enables dual signing from Business Settings after apply.
-- Other tenants stay customer-only until they enable the same checkbox.
--
-- NOT IN THIS MIGRATION:
--   * UPDATE of tenant_contract_packages / snapshot_json
--   * UPDATE of envelopes, signers, tokens, events, certificates, PDFs
--   * RLS policy changes
--   * backfill / tenant-specific UPDATE
-- =============================================================================

do $$
begin
  if to_regclass('public.tenant_contract_preferences') is null then
    raise exception 'CH-084 blocked: missing public.tenant_contract_preferences';
  end if;
end
$$;

alter table public.tenant_contract_preferences
  add column if not exists require_contractor_signature boolean not null default false;

comment on column public.tenant_contract_preferences.require_contractor_signature is
  'When true, new freezes require an explicit contractor (owner) in-app signature before the customer can be sent the signing link. Default false keeps existing tenants customer-only. Not a signature. Does not mutate frozen snapshots.';
