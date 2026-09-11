-- MG-CORE-SECURITY-HARDENING-1 — grants + function search_path
-- DO NOT apply from CI. Review, then run once in the Supabase SQL editor.
-- Does not INSERT/UPDATE/DELETE rows, drop objects, create/drop policies,
-- enable/disable RLS, or rewrite function bodies.
--
-- Evidence (repo, origin/main ee2655f):
--   * No public/ JS uses supabase.from() on the eight server-only tables.
--   * Browser loads expenses/change-orders via Netlify functions + service_role.
--   * No .rpc() calls exist in public/ or netlify/ JS for the mutation RPCs.
--   * Netlify handlers read/write those tables through supabaseRequest (service_role).
--
-- 34 ALTER FUNCTION signatures from the production public catalog of
-- functions with mutable search_path (no overloads invented).

BEGIN;

REVOKE ALL ON TABLE public.device_sessions FROM PUBLIC;
REVOKE ALL ON TABLE public.device_sessions FROM anon;
REVOKE ALL ON TABLE public.device_sessions FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.device_sessions TO service_role;

REVOKE ALL ON TABLE public.quote_annual_counters FROM PUBLIC;
REVOKE ALL ON TABLE public.quote_annual_counters FROM anon;
REVOKE ALL ON TABLE public.quote_annual_counters FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.quote_annual_counters TO service_role;

REVOKE ALL ON TABLE public.sales_approvals FROM PUBLIC;
REVOKE ALL ON TABLE public.sales_approvals FROM anon;
REVOKE ALL ON TABLE public.sales_approvals FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sales_approvals TO service_role;

REVOKE ALL ON TABLE public.tenant_devices FROM PUBLIC;
REVOKE ALL ON TABLE public.tenant_devices FROM anon;
REVOKE ALL ON TABLE public.tenant_devices FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tenant_devices TO service_role;

REVOKE ALL ON TABLE public.tenant_project_change_orders FROM PUBLIC;
REVOKE ALL ON TABLE public.tenant_project_change_orders FROM anon;
REVOKE ALL ON TABLE public.tenant_project_change_orders FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tenant_project_change_orders TO service_role;

REVOKE ALL ON TABLE public.tenant_project_expenses FROM PUBLIC;
REVOKE ALL ON TABLE public.tenant_project_expenses FROM anon;
REVOKE ALL ON TABLE public.tenant_project_expenses FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tenant_project_expenses TO service_role;

REVOKE ALL ON TABLE public.tenant_project_operational_snapshots FROM PUBLIC;
REVOKE ALL ON TABLE public.tenant_project_operational_snapshots FROM anon;
REVOKE ALL ON TABLE public.tenant_project_operational_snapshots FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tenant_project_operational_snapshots TO service_role;

REVOKE ALL ON TABLE public.users FROM PUBLIC;
REVOKE ALL ON TABLE public.users FROM anon;
REVOKE ALL ON TABLE public.users FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.users TO service_role;

REVOKE ALL ON FUNCTION public.activate_next_invoice_for_quote(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.activate_next_invoice_for_quote(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.activate_next_invoice_for_quote(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.activate_next_invoice_for_quote(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.calc_quote_labor_cost(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.calc_quote_labor_cost(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.calc_quote_labor_cost(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.calc_quote_labor_cost(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.create_payment_schedule_from_quote(uuid, uuid, numeric, text, text, text, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_payment_schedule_from_quote(uuid, uuid, numeric, text, text, text, date) FROM anon;
REVOKE ALL ON FUNCTION public.create_payment_schedule_from_quote(uuid, uuid, numeric, text, text, text, date) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_payment_schedule_from_quote(uuid, uuid, numeric, text, text, text, date) TO service_role;

REVOKE ALL ON FUNCTION public.refresh_invoice_payment_totals(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_invoice_payment_totals(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.refresh_invoice_payment_totals(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_invoice_payment_totals(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.register_invoice_payment(uuid, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.register_invoice_payment(uuid, numeric) FROM anon;
REVOKE ALL ON FUNCTION public.register_invoice_payment(uuid, numeric) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.register_invoice_payment(uuid, numeric) TO service_role;

REVOKE ALL ON FUNCTION public.register_invoice_payment(uuid, uuid, numeric, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.register_invoice_payment(uuid, uuid, numeric, text, text, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.register_invoice_payment(uuid, uuid, numeric, text, text, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.register_invoice_payment(uuid, uuid, numeric, text, text, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.mg_business_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mg_business_id() FROM anon;
GRANT EXECUTE ON FUNCTION public.mg_business_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.mg_business_id() TO service_role;

REVOKE ALL ON FUNCTION public.mg_role() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mg_role() FROM anon;
GRANT EXECUTE ON FUNCTION public.mg_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.mg_role() TO service_role;

ALTER FUNCTION public.ai_closer_set_updated_at()
SET search_path = pg_catalog, public;
ALTER FUNCTION public.platform_activity_events_reject_mutation()
SET search_path = pg_catalog, public;
ALTER FUNCTION public.platform_domain_event_outbox_reject_mutation()
SET search_path = pg_catalog, public;
ALTER FUNCTION public.qsl_recalc()
SET search_path = pg_catalog, public;
ALTER FUNCTION public.set_updated_at()
SET search_path = pg_catalog, public;
ALTER FUNCTION public.sync_owner_profit_cols()
SET search_path = pg_catalog, public;
ALTER FUNCTION public.tenant_contract_certificates_protect_immutable()
SET search_path = pg_catalog, public;
ALTER FUNCTION public.tenant_contract_envelopes_assert_refs()
SET search_path = pg_catalog, public;
ALTER FUNCTION public.tenant_contract_envelopes_touch_updated_at()
SET search_path = pg_catalog, public;
ALTER FUNCTION public.tenant_contract_invitation_delivery_attempts_protect_delete()
SET search_path = pg_catalog, public;
ALTER FUNCTION public.tenant_contract_invitation_delivery_attempts_protect_update()
SET search_path = pg_catalog, public;
ALTER FUNCTION public.tenant_contract_invitation_generations_assert_refs()
SET search_path = pg_catalog, public;
ALTER FUNCTION public.tenant_contract_invitation_generations_protect_delete()
SET search_path = pg_catalog, public;
ALTER FUNCTION public.tenant_contract_invitation_generations_protect_update()
SET search_path = pg_catalog, public;
ALTER FUNCTION public.tenant_contract_invitations_assert_refs()
SET search_path = pg_catalog, public;
ALTER FUNCTION public.tenant_contract_invitations_protect_terminal()
SET search_path = pg_catalog, public;
ALTER FUNCTION public.tenant_contract_packages_assert_refs()
SET search_path = pg_catalog, public;
ALTER FUNCTION public.tenant_contract_packages_protect_immutable()
SET search_path = pg_catalog, public;
ALTER FUNCTION public.tenant_contract_signature_events_append_only()
SET search_path = pg_catalog, public;
ALTER FUNCTION public.tenant_contract_signed_artifacts_protect_immutable()
SET search_path = pg_catalog, public;
ALTER FUNCTION public.tenant_contract_signers_assert_refs()
SET search_path = pg_catalog, public;
ALTER FUNCTION public.tenant_contract_signers_touch_updated_at()
SET search_path = pg_catalog, public;
ALTER FUNCTION public.tenant_contract_signing_tokens_assert_refs()
SET search_path = pg_catalog, public;
ALTER FUNCTION public.tenant_contract_signing_tokens_protect_immutable()
SET search_path = pg_catalog, public;
ALTER FUNCTION public.tenant_contract_signing_tokens_touch_updated_at()
SET search_path = pg_catalog, public;
ALTER FUNCTION public.tenant_project_payment_intents_assert_refs()
SET search_path = pg_catalog, public;
ALTER FUNCTION public.activate_next_invoice_for_quote(uuid)
SET search_path = pg_catalog, public;
ALTER FUNCTION public.calc_quote_labor_cost(uuid)
SET search_path = pg_catalog, public;
ALTER FUNCTION public.create_payment_schedule_from_quote(uuid, uuid, numeric, text, text, text, date)
SET search_path = pg_catalog, public;
ALTER FUNCTION public.refresh_invoice_payment_totals(uuid)
SET search_path = pg_catalog, public;
ALTER FUNCTION public.register_invoice_payment(uuid, numeric)
SET search_path = pg_catalog, public;
ALTER FUNCTION public.register_invoice_payment(uuid, uuid, numeric, text, text, text, text)
SET search_path = pg_catalog, public;
ALTER FUNCTION public.mg_business_id()
SET search_path = pg_catalog, public;
ALTER FUNCTION public.mg_role()
SET search_path = pg_catalog, public;

NOTIFY pgrst, 'reload schema';

COMMIT;
