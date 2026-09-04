-- MG-SALES-READY-006A — rollback (restores the UNSAFE default)
-- DO NOT apply unless reverting 006A. Restoring default 'active' reopens the
-- risk that a forgotten plan_status on INSERT grants SaaS access before payment.
-- This rollback does NOT UPDATE existing rows.

BEGIN;

ALTER TABLE public.tenants
  ALTER COLUMN plan_status SET DEFAULT 'active';

COMMIT;
