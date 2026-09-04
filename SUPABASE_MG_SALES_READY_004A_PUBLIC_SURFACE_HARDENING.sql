-- MG-SALES-READY-004A — Supabase public surface hardening
-- DO NOT apply from CI. Review, then run once in the Supabase SQL editor.
-- Does not delete rows, drop tables, or rewrite SECURITY DEFINER function bodies.
--
-- Proven production issue: RLS disabled + broad anon/authenticated grants on
-- tenant project/bank/summary tables, and SECURITY DEFINER EXECUTE for PUBLIC/anon.
-- Current Margin Guard app accesses those tables only via Netlify service_role.
-- Public quote/invoice flows use unguessable public_token through Netlify, not RPC.
--
-- This migration:
--   1) enables RLS on the listed tables (skips missing names)
--   2) revokes PUBLIC/anon/authenticated table privileges
--   3) keeps service_role SELECT/INSERT/UPDATE/DELETE + explicit service_role policy
--   4) revokes EXECUTE on listed SECURITY DEFINER functions from PUBLIC/anon/authenticated
--   5) grants EXECUTE to service_role only
--   6) sets search_path = public, pg_temp on those functions
--
-- No function is left executable by anon merely because it may contain a token check.

BEGIN;

DO $$
DECLARE
  t text;
  pol text;
  tables text[] := ARRAY[
    'project_daily_costs',
    'quote_change_requests',
    'square_webhook_events',
    'tenant_bank_accounts',
    'tenant_bank_connections',
    'tenant_financial_account_mapping',
    'tenant_financial_account_mapping_backup',
    'tenant_financial_summary',
    'tenant_financial_summary_backup',
    'tenant_financial_summary_migration_backup',
    'tenant_project_reports',
    'tenant_projects'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE '004A skip missing table %', t;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

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

DO $$
DECLARE
  r record;
  fnames text[] := ARRAY[
    'allocate_next_quote_number',
    'approve_public_quote',
    'create_deposit_and_balance',
    'create_invoice_from_quote',
    'get_invoice_by_id',
    'get_invoice_email_payload',
    'get_public_quote',
    'get_seller_quote_context',
    'get_supervisor_project_context',
    'get_supervisor_quote_context',
    'mark_deposit_paid',
    'mark_invoice_ready_to_send',
    'mark_quote_completed',
    'mark_quote_sent',
    'mark_quote_viewed',
    'recalc_financial_snapshot',
    'send_quote',
    'update_labor_usage',
    'upsert_quote_service_line'
  ];
  ident text;
BEGIN
  FOR r IN
    SELECT n.nspname AS nsp, p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY (fnames)
  LOOP
    ident := format('%I.%I(%s)', r.nsp, r.proname, r.args);

    EXECUTE 'ALTER FUNCTION ' || ident || ' SET search_path = public, pg_temp';

    BEGIN
      EXECUTE 'REVOKE ALL ON FUNCTION ' || ident || ' FROM PUBLIC';
    EXCEPTION
      WHEN undefined_object THEN NULL;
    END;
    BEGIN
      EXECUTE 'REVOKE ALL ON FUNCTION ' || ident || ' FROM anon';
    EXCEPTION
      WHEN undefined_object THEN NULL;
    END;
    BEGIN
      EXECUTE 'REVOKE ALL ON FUNCTION ' || ident || ' FROM authenticated';
    EXCEPTION
      WHEN undefined_object THEN NULL;
    END;

    EXECUTE 'GRANT EXECUTE ON FUNCTION ' || ident || ' TO service_role';
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
