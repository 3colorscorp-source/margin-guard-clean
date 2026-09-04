-- MG-SALES-READY-004A — emergency rollback (service_role path only)
-- DO NOT apply unless the hardening migration broke a Netlify service-role flow.
-- This rollback does NOT restore anon/authenticated table or EXECUTE grants.
-- Restoring those grants would re-open the proven production exposure.
--
-- Does not delete rows or drop backup tables.

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
    EXECUTE 'GRANT EXECUTE ON FUNCTION ' || ident || ' TO service_role';
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- DANGER — not part of this rollback. Re-granting anon/authenticated would
-- restore the proven public surface. Do not uncomment for first-tenant launch.
-- -- GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tenant_projects TO anon, authenticated;
-- -- GRANT EXECUTE ON FUNCTION public.get_invoice_by_id TO PUBLIC;
