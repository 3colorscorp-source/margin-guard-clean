-- Production rollback for the scheduling-deposit RPC.
-- UNAPPLIED. Do not run this file from Cursor.
-- Do not run the function removal until new Checkout Sessions are already closed.
--
-- This file does not remove public.stripe_scheduling_deposit_events.
-- This file does not remove rows from tenant_project_payments.
-- This file does not remove applied credits, needs_review events, or ledger rows.
-- After any live event or applied payment exists, keep the evidence table.
-- Removing that table is a separate reviewed action and is intentionally absent here.
--
-- Operational sequence
-- 1. Close new scheduling Checkout Sessions before disabling the RPC.
--    In the Netlify production environment set:
--      SCHEDULING_DEPOSIT_CHECKOUT_ENABLED=false
--    Redeploy the current production functions so the process loads that value.
--    Confirm create-project-deposit-session returns scheduling_deposit_maintenance
--    and does not call Stripe.
--    Leave finalize-project-deposit deployed. A Checkout Session that is already
--    paid must still be able to record through the RPC.
-- 2. Wait until a customer can no longer start a new session.
-- 3. Only then run the function removal at the bottom of this file in the
--    Supabase SQL editor. New automatic credits stop. Existing rows stay.
-- 4. Keep checkout closed until the function is restored. Reopening checkout
--    while the function is absent lets a customer pay with no ledger credit.
--
-- Interrupted migration
-- SUPABASE_STRIPE_SCHEDULING_DEPOSIT_EVENTS.sql is one transaction.
-- If it stops before COMMIT, PostgreSQL rolls that transaction back.
-- No events table and no function remain from that attempt.
-- Run the migration file again. Do not remove payment rows to retry it.
--
-- Interrupted deployment
-- Netlify keeps the previous production deploy until a new deploy succeeds.
-- If the new functions are live and the SQL is not:
--   Public verification fails closed and checkout stays closed.
--   Recovery: apply the migration file. It is safe to re-run.
--   Then confirm an unpaid estimate can open checkout.
-- If the SQL committed and the function deploy did not:
--   The previous finalize remains and does not call this RPC.
--   Recovery: deploy the functions that call record_verified_scheduling_deposit.
--   Do not remove the function to clean up a deploy that has not finished.
-- If checkout was closed and the function removal below already ran:
--   Leave SCHEDULING_DEPOSIT_CHECKOUT_ENABLED=false.
--   Restore the function by re-running the migration file.
--   Confirm service_role can execute it and anon cannot.
--   Only then set SCHEDULING_DEPOSIT_CHECKOUT_ENABLED=true and redeploy.
--
-- Do not refund, delete, or replay a production payment as part of rollback.

BEGIN;

DROP FUNCTION IF EXISTS public.record_verified_scheduling_deposit(
  uuid, uuid, uuid, text, text, text, numeric, timestamptz
);

COMMIT;
