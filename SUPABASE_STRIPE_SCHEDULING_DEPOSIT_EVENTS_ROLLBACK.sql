-- Rollback for the scheduling-deposit RPC only.
-- UNAPPLIED. Do not run from Cursor.
--
-- Drops the function so new automatic credits stop.
-- Does not delete tenant_project_payments rows.
-- Does not drop public.stripe_scheduling_deposit_events.
-- After any live event or applied payment exists, keep the evidence table.
-- Dropping that table is a separate reviewed action and is intentionally absent here.

BEGIN;

DROP FUNCTION IF EXISTS public.record_verified_scheduling_deposit(
  uuid, uuid, uuid, text, text, text, numeric, timestamptz
);

COMMIT;
