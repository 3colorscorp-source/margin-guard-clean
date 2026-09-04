-- MG-SALES-READY-006B — rollback
-- DO NOT apply unless reverting unused 006B tables.
-- Drops only saas_onboarding and saas_square_webhook_events.
-- Does not UPDATE tenants. Does not touch square_webhook_events.

BEGIN;

DROP TABLE IF EXISTS public.saas_square_webhook_events;
DROP TABLE IF EXISTS public.saas_onboarding;

COMMIT;
