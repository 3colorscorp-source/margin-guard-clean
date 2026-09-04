-- MG-SALES-READY-004C — revoke leftover browser grants on public.business_branding
-- DO NOT apply from CI. Review, then run once in the Supabase SQL editor.
-- Does not delete rows, rewrite branding data, or alter 004A/004B tables.
--
-- 004A and 004B are already applied. This file does not reapply or undo them.
--
-- After 004C code: no browser .from('business_branding'). Branding is loaded
-- through Netlify get-tenant-branding (service_role + server-resolved tenant).
-- Production currently has RLS + auth.uid() = user_id, so anon sees 0 rows,
-- but anon still has a SELECT grant. This migration removes that grant.

BEGIN;

DO $$
DECLARE
  t text := 'business_branding';
  pol text;
  r record;
  role_names text[];
  only_service boolean;
  client_facing boolean;
  qnorm text;
  cnorm text;
  broad boolean;
BEGIN
  IF to_regclass('public.' || t) IS NULL THEN
    RAISE NOTICE '004C skip missing table %', t;
    RETURN;
  END IF;

  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

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

    only_service := (array_length(role_names, 1) = 1 AND role_names[1] = 'service_role');
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
    );

    IF only_service THEN
      RAISE NOTICE '004C keep service_role policy %', r.policyname;
      CONTINUE;
    END IF;

    IF client_facing AND broad THEN
      RAISE NOTICE '004C drop broad client policy %', r.policyname;
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, t);
    ELSIF client_facing THEN
      RAISE NOTICE '004C retain tenant-aware RLS policy % qual=%', r.policyname, coalesce(r.qual, '');
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
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
