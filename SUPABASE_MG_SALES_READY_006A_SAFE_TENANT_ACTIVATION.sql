-- MG-SALES-READY-006A — safe tenant activation default
-- DO NOT apply from Cursor/CI. Review, then run once in the Supabase SQL editor.
--
-- Proven issue: public.tenants.plan_status defaults to 'active' with no CHECK.
-- A manually created tenant row can become SaaS-active before payment if the
-- admin forgets to set plan_status.
--
-- This migration ONLY changes the column DEFAULT to 'pending'.
-- It does NOT UPDATE existing rows.
-- The current production Three Colors tenant remains unchanged.
--
-- Application invariant: only plan_status = 'active' (trim, case-insensitive)
-- receives owner SaaS access. pending / canceled / expired / inactive / unknown
-- fail closed. Activation for first 1-5 customers is a platform-admin manual
-- UPDATE after QuickBooks or Square payment is CONFIRMED.
-- See docs/MG_SALES_READY_006A_FIRST_CUSTOMER_RUNBOOK.md

BEGIN;

ALTER TABLE public.tenants
  ALTER COLUMN plan_status SET DEFAULT 'pending';

COMMIT;
