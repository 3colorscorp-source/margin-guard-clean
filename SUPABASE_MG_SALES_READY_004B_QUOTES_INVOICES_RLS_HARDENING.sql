-- MG-SALES-READY-004B — quotes / invoices / quote_items / payments RLS hardening
-- DO NOT apply from CI. Review, then run once in the Supabase SQL editor.
-- Does not delete rows, drop tables, rewrite financial data, or alter 004A tables.
--
-- 004A is already applied. This file does not reapply or undo 004A.
--
-- Proven production issue after 004A:
--   As role anon, quotes / invoices / quote_items remain listable because
--   leftover PUBLIC/anon policies use USING true or
--   USING (public_token IS NOT NULL) without binding a caller-supplied token.
--
-- Current product callers for these tables are Netlify service_role functions.
-- Public invoice/estimate pages must use unguessable public_token through
-- get-public-invoice / get-public-estimate, not direct PostgREST.
--
-- This migration:
--   1) enables RLS on quotes, quote_items, invoices, invoice_payments, payments
--      (skips missing names)
--   2) drops named obsolete PUBLIC/anon/authenticated broad policies
--   3) drops remaining client-facing USING true / public_token IS NOT NULL
--      policies on those tables (keeps service_role-only and tenant-aware)
--   4) revokes PUBLIC/anon/authenticated table privileges
--   5) keeps service_role SELECT/INSERT/UPDATE/DELETE + explicit service_role policy
--
-- No rows are deleted. No 004A table is listed below.

BEGIN;

DO $$
DECLARE
  t text;
  pol text;
  r record;
  role_names text[];
  only_service boolean;
  client_facing boolean;
  qnorm text;
  cnorm text;
  broad boolean;
  tables text[] := ARRAY[
    'quotes',
    'quote_items',
    'invoices',
    'invoice_payments',
    'payments'
  ];
  named_drop text[] := ARRAY[
    'quotes_read_all',
    'quotes_insert_all',
    'quotes_update_owner',
    'allow read quote items',
    'allow insert quote items',
    'invoices_all_auth',
    'public can read invoices by token',
    'public read invoice by token',
    'authenticated read invoices',
    'anon read invoices',
    'authenticated full access invoices',
    'anon full access invoices',
    'payments_all_auth'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE '004B skip missing table %', t;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    FOREACH pol IN ARRAY named_drop LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol, t);
    END LOOP;

    FOR r IN
      SELECT
        p.polname AS policyname,
        p.polroles AS polroles,
        pg_get_expr(p.polqual, p.polrelid) AS qual,
        pg_get_expr(p.polwithcheck, p.polrelid) AS with_check
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = t
    LOOP
      IF r.polroles IS NULL OR r.polroles = '{}'::oid[] OR 0 = ANY (r.polroles) THEN
        role_names := ARRAY['public'];
      ELSE
        SELECT coalesce(array_agg(x.rolname ORDER BY x.rolname), ARRAY[]::text[])
        INTO role_names
        FROM (
          SELECT oid::regrole::text AS rolname
          FROM unnest(r.polroles) AS oid
        ) x;
      END IF;

      only_service := (
        array_length(role_names, 1) = 1
        AND role_names[1] IN ('service_role', 'service_role')
      );
      client_facing := (
        NOT only_service
        AND (
          'anon' = ANY (role_names)
          OR 'authenticated' = ANY (role_names)
          OR 'public' = ANY (role_names)
        )
      );

      qnorm := lower(regexp_replace(coalesce(r.qual, ''), '\s+', '', 'g'));
      cnorm := lower(regexp_replace(coalesce(r.with_check, ''), '\s+', '', 'g'));
      broad := (
        qnorm IN ('true', '(true)')
        OR cnorm IN ('true', '(true)')
        OR qnorm IN ('public_tokenisnotnull', '(public_tokenisnotnull)')
      );

      IF only_service THEN
        RAISE NOTICE '004B keep service_role policy %.%', t, r.policyname;
        CONTINUE;
      END IF;

      IF client_facing AND broad THEN
        RAISE NOTICE '004B drop broad client policy %.%', t, r.policyname;
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, t);
      ELSIF client_facing THEN
        RAISE NOTICE '004B retain tenant-aware client policy %.% qual=%', t, r.policyname, coalesce(r.qual, '');
      END IF;
    END LOOP;

    BEGIN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t);
    EXCEPTION
      WHEN undefined_object THEN NULL;
    END;
    BEGIN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', t);
    EXCEPTION
      WHEN undefined_object THEN NULL;
    END;
    BEGIN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated', t);
    EXCEPTION
      WHEN undefined_object THEN NULL;
    END;

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

-- PHASE 6: report remaining PUBLIC/anon/authenticated broad policies in public.
-- Does not drop them. Review NOTICE output before first paying tenant.
DO $$
DECLARE
  r record;
  role_names text[];
  qnorm text;
  cnorm text;
BEGIN
  FOR r IN
    SELECT
      n.nspname AS schemaname,
      c.relname AS tablename,
      p.polname AS policyname,
      p.polroles AS polroles,
      pg_get_expr(p.polqual, p.polrelid) AS qual,
      pg_get_expr(p.polwithcheck, p.polrelid) AS with_check
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
    ORDER BY c.relname, p.polname
  LOOP
    IF r.polroles IS NULL OR r.polroles = '{}'::oid[] OR 0 = ANY (r.polroles) THEN
      role_names := ARRAY['public'];
    ELSE
      SELECT coalesce(array_agg(x.rolname ORDER BY x.rolname), ARRAY[]::text[])
      INTO role_names
      FROM (
        SELECT oid::regrole::text AS rolname
        FROM unnest(r.polroles) AS oid
      ) x;
    END IF;

    IF NOT (
      'anon' = ANY (role_names)
      OR 'authenticated' = ANY (role_names)
      OR 'public' = ANY (role_names)
    ) THEN
      CONTINUE;
    END IF;

    qnorm := lower(regexp_replace(coalesce(r.qual, ''), '\s+', '', 'g'));
    cnorm := lower(regexp_replace(coalesce(r.with_check, ''), '\s+', '', 'g'));
    IF qnorm IN ('true', '(true)')
       OR cnorm IN ('true', '(true)')
       OR qnorm IN ('public_tokenisnotnull', '(public_tokenisnotnull)')
       OR position('public_tokenisnotnull' in qnorm) > 0 THEN
      RAISE NOTICE '004B remaining broad public-schema policy: %.% name=% roles=% qual=% check=%',
        r.schemaname, r.tablename, r.policyname, role_names, coalesce(r.qual, ''), coalesce(r.with_check, '');
    END IF;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
