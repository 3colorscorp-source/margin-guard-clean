-- =============================================================================
-- Margin Guard | MG-SUPPORT-003C — Support Admin inbox (additive)
-- =============================================================================
-- STATUS: MANUAL SUPABASE APPLY REQUIRED — do not run from CI or auto-deploy.
--
-- PURPOSE:
--   Add resolved_at for platform-admin resolve/reopen, plus a cross-tenant
--   status/created index for the Support Inbox list.
--
-- NOT IN THIS MIGRATION:
--   * assignment / priority / SLA / notes / messages
--   * owner case history
--   * RLS or grant changes
--   * rewriting live support-case rows
--
-- DEPENDENCIES:
--   REQUIRED: public.tenant_support_cases (MG-SUPPORT-003B)
-- =============================================================================

alter table public.tenant_support_cases
  add column if not exists resolved_at timestamptz null;

comment on column public.tenant_support_cases.resolved_at is
  'UTC time the case was marked resolved. Null while open. Cleared on reopen.';

create index if not exists tenant_support_cases_status_created_idx
  on public.tenant_support_cases (status, created_at desc);
