-- MG-CORE-SECURITY-HARDENING-1 — verification
-- Run after the apply file. Read-only checks; rolls back any local writes.
-- Fails closed if grants, search_path, RLS, or policies are wrong.

BEGIN TRANSACTION READ ONLY;

DO $$
DECLARE
  bad text;
  rel text;
  tables text[] := ARRAY[
    'device_sessions',
    'quote_annual_counters',
    'sales_approvals',
    'tenant_devices',
    'tenant_project_change_orders',
    'tenant_project_expenses',
    'tenant_project_operational_snapshots',
    'users'
  ];
  fns text[] := ARRAY[
    'public.ai_closer_set_updated_at()',
    'public.platform_activity_events_reject_mutation()',
    'public.platform_domain_event_outbox_reject_mutation()',
    'public.qsl_recalc()',
    'public.set_updated_at()',
    'public.sync_owner_profit_cols()',
    'public.tenant_contract_certificates_protect_immutable()',
    'public.tenant_contract_envelopes_assert_refs()',
    'public.tenant_contract_envelopes_touch_updated_at()',
    'public.tenant_contract_invitation_delivery_attempts_protect_delete()',
    'public.tenant_contract_invitation_delivery_attempts_protect_update()',
    'public.tenant_contract_invitation_generations_assert_refs()',
    'public.tenant_contract_invitation_generations_protect_delete()',
    'public.tenant_contract_invitation_generations_protect_update()',
    'public.tenant_contract_invitations_assert_refs()',
    'public.tenant_contract_invitations_protect_terminal()',
    'public.tenant_contract_packages_assert_refs()',
    'public.tenant_contract_packages_protect_immutable()',
    'public.tenant_contract_signature_events_append_only()',
    'public.tenant_contract_signed_artifacts_protect_immutable()',
    'public.tenant_contract_signers_assert_refs()',
    'public.tenant_contract_signers_touch_updated_at()',
    'public.tenant_contract_signing_tokens_assert_refs()',
    'public.tenant_contract_signing_tokens_protect_immutable()',
    'public.tenant_contract_signing_tokens_touch_updated_at()',
    'public.tenant_project_payment_intents_assert_refs()',
    'public.activate_next_invoice_for_quote(uuid)',
    'public.calc_quote_labor_cost(uuid)',
    'public.create_payment_schedule_from_quote(uuid, uuid, numeric, text, text, text, date)',
    'public.refresh_invoice_payment_totals(uuid)',
    'public.register_invoice_payment(uuid, numeric)',
    'public.register_invoice_payment(uuid, uuid, numeric, text, text, text, text)',
    'public.mg_business_id()',
    'public.mg_role()'
  ];
  mut_rpcs text[] := ARRAY[
    'public.activate_next_invoice_for_quote(uuid)',
    'public.calc_quote_labor_cost(uuid)',
    'public.create_payment_schedule_from_quote(uuid, uuid, numeric, text, text, text, date)',
    'public.refresh_invoice_payment_totals(uuid)',
    'public.register_invoice_payment(uuid, numeric)',
    'public.register_invoice_payment(uuid, uuid, numeric, text, text, text, text)'
  ];
  ident text;
  fn_oid oid;
  cfg text;
  has_path boolean;
BEGIN
  IF array_length(fns, 1) <> 34 THEN
    RAISE EXCEPTION 'HARDENING-1 VERIFY FAIL: expected 34 target functions';
  END IF;

  FOREACH rel IN ARRAY tables LOOP
    IF to_regclass('public.' || rel) IS NULL THEN
      RAISE EXCEPTION 'HARDENING-1 VERIFY FAIL: missing table public.%', rel;
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = rel
        AND c.relrowsecurity
    ) THEN
      RAISE EXCEPTION 'HARDENING-1 VERIFY FAIL: public.% lost RLS', rel;
    END IF;
    IF has_table_privilege('anon', 'public.' || rel, 'SELECT')
       OR has_table_privilege('anon', 'public.' || rel, 'INSERT')
       OR has_table_privilege('anon', 'public.' || rel, 'UPDATE')
       OR has_table_privilege('anon', 'public.' || rel, 'DELETE')
       OR has_table_privilege('authenticated', 'public.' || rel, 'SELECT')
       OR has_table_privilege('authenticated', 'public.' || rel, 'INSERT')
       OR has_table_privilege('authenticated', 'public.' || rel, 'UPDATE')
       OR has_table_privilege('authenticated', 'public.' || rel, 'DELETE') THEN
      RAISE EXCEPTION 'HARDENING-1 VERIFY FAIL: anon/authenticated still granted on public.%', rel;
    END IF;
    IF NOT (
      has_table_privilege('service_role', 'public.' || rel, 'SELECT')
      AND has_table_privilege('service_role', 'public.' || rel, 'INSERT')
      AND has_table_privilege('service_role', 'public.' || rel, 'UPDATE')
      AND has_table_privilege('service_role', 'public.' || rel, 'DELETE')
    ) THEN
      RAISE EXCEPTION 'HARDENING-1 VERIFY FAIL: service_role missing table privileges on public.%', rel;
    END IF;
    IF EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      WHERE n.nspname = 'public'
        AND c.relname = rel
        AND a.grantee = 0
        AND a.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
    ) THEN
      RAISE EXCEPTION 'HARDENING-1 VERIFY FAIL: PUBLIC still granted on public.%', rel;
    END IF;
  END LOOP;

  FOREACH ident IN ARRAY fns LOOP
    fn_oid := to_regprocedure(ident);
    IF fn_oid IS NULL THEN
      RAISE EXCEPTION 'HARDENING-1 VERIFY FAIL: missing function %', ident;
    END IF;
    SELECT coalesce(array_to_string(p.proconfig, ','), '') INTO cfg
    FROM pg_proc p
    WHERE p.oid = fn_oid;
    has_path := cfg LIKE '%search_path=%';
    IF NOT has_path THEN
      RAISE EXCEPTION 'HARDENING-1 VERIFY FAIL: mutable search_path on %', ident;
    END IF;
  END LOOP;

  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.proname, p.oid)
  INTO bad
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prokind IN ('f', 'p')
    AND coalesce(array_to_string(p.proconfig, ','), '') NOT LIKE '%search_path=%';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'HARDENING-1 VERIFY FAIL: public function still has mutable search_path: %', bad;
  END IF;

  FOREACH ident IN ARRAY mut_rpcs LOOP
    IF has_function_privilege('anon', ident, 'EXECUTE')
       OR has_function_privilege('authenticated', ident, 'EXECUTE') THEN
      RAISE EXCEPTION 'HARDENING-1 VERIFY FAIL: forbidden EXECUTE remains on %', ident;
    END IF;
    IF NOT has_function_privilege('service_role', ident, 'EXECUTE') THEN
      RAISE EXCEPTION 'HARDENING-1 VERIFY FAIL: service_role lost EXECUTE on %', ident;
    END IF;
    IF EXISTS (
      SELECT 1
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      WHERE p.oid = to_regprocedure(ident)
        AND a.grantee = 0
        AND a.privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'HARDENING-1 VERIFY FAIL: PUBLIC still has EXECUTE on %', ident;
    END IF;
  END LOOP;

  IF NOT has_function_privilege('authenticated', 'public.mg_business_id()', 'EXECUTE') THEN
    RAISE EXCEPTION 'HARDENING-1 VERIFY FAIL: authenticated lost EXECUTE on mg_business_id()';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.mg_role()', 'EXECUTE') THEN
    RAISE EXCEPTION 'HARDENING-1 VERIFY FAIL: authenticated lost EXECUTE on mg_role()';
  END IF;
  IF has_function_privilege('anon', 'public.mg_business_id()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.mg_role()', 'EXECUTE') THEN
    RAISE EXCEPTION 'HARDENING-1 VERIFY FAIL: anon still has EXECUTE on mg helpers';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    WHERE n.nspname = 'public'
      AND p.proname IN ('mg_business_id', 'mg_role')
      AND a.grantee = 0
      AND a.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'HARDENING-1 VERIFY FAIL: PUBLIC still has EXECUTE on mg helpers';
  END IF;

  RAISE NOTICE 'HARDENING-1 VERIFY PASS';
END $$;

ROLLBACK;
