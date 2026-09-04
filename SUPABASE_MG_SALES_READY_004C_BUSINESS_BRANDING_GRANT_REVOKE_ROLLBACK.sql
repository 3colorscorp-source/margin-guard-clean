-- MG-SALES-READY-004C — emergency rollback (service_role path only)
-- DO NOT apply unless get-tenant-branding service-role reads of business_branding
-- broke. Live branding is tenant_branding via Netlify; this table is leftover.
-- This rollback does NOT restore anon/authenticated grants.

BEGIN;

DO $$
DECLARE
  t text := 'business_branding';
  pol text;
BEGIN
  IF to_regclass('public.' || t) IS NULL THEN
    RETURN;
  END IF;

  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO service_role',
    t
  );

  pol := 'service role full access ' || t;
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol, t);
  EXECUTE format(
    'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
    pol,
    t
  );
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- DANGER — not part of this rollback.
-- -- GRANT SELECT ON TABLE public.business_branding TO anon, authenticated;
