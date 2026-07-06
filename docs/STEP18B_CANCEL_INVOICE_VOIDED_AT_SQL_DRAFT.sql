-- =============================================================================
-- Margin Guard Step 18B — Cancel Invoice voided_at SQL Migration Draft
-- =============================================================================
-- STEP18B CANCEL INVOICE VOIDED_AT SQL DRAFT
-- DRAFT ONLY. DO NOT APPLY UNTIL OWNER APPROVAL.
--
-- SAFETY NOTES:
--   * This file is a draft only; it has NOT been applied to production.
--   * Non-destructive: adds one nullable column only.
--   * No existing rows are updated or backfilled.
--   * No default value is set on voided_at.
--   * No RLS or policy changes.
--   * No invoice, payment, or email behavior changes by itself.
--   * Applying this column enables cancel-tenant-invoice.js to store voided_at
--     when an owner voids/cancels an invoice (status = void).
--
-- CONTEXT (Step 18A):
--   cancel-tenant-invoice.js PATCHes status = 'void' and voided_at = now().
--   Production public.invoices lacks voided_at, causing PGRST204.
-- =============================================================================

alter table public.invoices
  add column if not exists voided_at timestamptz;

comment on column public.invoices.voided_at is
  'Timestamp when an invoice was voided/cancelled. Nullable for active invoices. Used by the Cancel Invoice workflow.';

-- Verification after applying, only when owner approves:
-- select column_name, data_type, is_nullable
-- from information_schema.columns
-- where table_schema = 'public'
--   and table_name = 'invoices'
--   and column_name = 'voided_at';
