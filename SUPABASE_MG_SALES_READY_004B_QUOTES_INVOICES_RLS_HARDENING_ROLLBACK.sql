-- MG-SALES-READY-004B — emergency rollback (service_role path only)
-- DO NOT apply unless the hardening migration broke a Netlify service-role flow.
-- This rollback does NOT restore anon/authenticated table grants or USING true
-- client policies. Restoring those would re-open the proven production exposure.
--
-- Does not delete rows, rewrite financial data, or alter 004A tables.

BEGIN;

DO $$
DECLARE
  t text;
  pol text;
  tables text[] := ARRAY[
    'quotes',
    'quote_items',
    'invoices',
    'invoice_payments',
    'payments'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
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
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- DANGER — not part of this rollback. Re-granting anon/authenticated or
-- recreating quotes_read_all / invoices_all_auth / public_token IS NOT NULL
-- policies would restore the proven public surface.
-- Do not uncomment for first-tenant launch.
-- -- GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.quotes TO anon, authenticated;
-- -- GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.invoices TO anon, authenticated;
