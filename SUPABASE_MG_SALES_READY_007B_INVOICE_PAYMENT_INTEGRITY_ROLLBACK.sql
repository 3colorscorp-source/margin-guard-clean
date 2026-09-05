-- MG-SALES-READY-007B rollback — UNAPPLIED.
-- Drops the RPC and unique index. Leaves idempotency_key column in place
-- (nullable, unused by historical rows) so rollback cannot collide with
-- any payment row written after a partial apply.

BEGIN;

DROP FUNCTION IF EXISTS public.record_tenant_invoice_payment(
  uuid, uuid, text, text, numeric, timestamptz, text, text, text, uuid, uuid
);

DROP INDEX IF EXISTS public.tenant_project_payments_tenant_idempotency_uidx;

NOTIFY pgrst, 'reload schema';

COMMIT;
