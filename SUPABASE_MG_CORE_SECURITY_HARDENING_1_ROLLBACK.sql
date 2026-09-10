-- MG-CORE-SECURITY-HARDENING-1 — emergency rollback
-- Restores the previous grant and search_path state from production catalog
-- yaagobzgozzozibublmj: table ACL arwdDxtm (SELECT, INSERT, UPDATE, DELETE,
-- TRUNCATE, REFERENCES, TRIGGER, MAINTAIN) for anon, authenticated, and
-- service_role. Functions had EXECUTE for PUBLIC, anon, authenticated, and
-- service_role. All 34 functions had proconfig = null.
-- DO NOT execute this file. It is kept for emergency recovery only.
-- Re-granting anon/authenticated would reopen Data API access.
-- Does not modify policies or RLS.

BEGIN;

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.device_sessions TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.device_sessions TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.quote_annual_counters TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.quote_annual_counters TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.sales_approvals TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.sales_approvals TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.tenant_devices TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.tenant_devices TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.tenant_project_change_orders TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.tenant_project_change_orders TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.tenant_project_expenses TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.tenant_project_expenses TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.tenant_project_operational_snapshots TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.tenant_project_operational_snapshots TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.users TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.users TO service_role;

GRANT EXECUTE ON FUNCTION public.activate_next_invoice_for_quote(uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.activate_next_invoice_for_quote(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activate_next_invoice_for_quote(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.calc_quote_labor_cost(uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.calc_quote_labor_cost(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.calc_quote_labor_cost(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.create_payment_schedule_from_quote(uuid, uuid, numeric, text, text, text, date) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_payment_schedule_from_quote(uuid, uuid, numeric, text, text, text, date) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_payment_schedule_from_quote(uuid, uuid, numeric, text, text, text, date) TO service_role;

GRANT EXECUTE ON FUNCTION public.refresh_invoice_payment_totals(uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_invoice_payment_totals(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_invoice_payment_totals(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.register_invoice_payment(uuid, numeric) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_invoice_payment(uuid, numeric) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_invoice_payment(uuid, numeric) TO service_role;

GRANT EXECUTE ON FUNCTION public.register_invoice_payment(uuid, uuid, numeric, text, text, text, text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_invoice_payment(uuid, uuid, numeric, text, text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_invoice_payment(uuid, uuid, numeric, text, text, text, text) TO service_role;

GRANT EXECUTE ON FUNCTION public.mg_business_id() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.mg_business_id() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mg_business_id() TO service_role;

GRANT EXECUTE ON FUNCTION public.mg_role() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.mg_role() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mg_role() TO service_role;

ALTER FUNCTION public.assert_device_session_same_tenant() RESET search_path;
ALTER FUNCTION public.assert_tenant_device_membership_same_tenant() RESET search_path;
ALTER FUNCTION public.platform_activity_events_reject_mutation() RESET search_path;
ALTER FUNCTION public.platform_domain_event_outbox_reject_mutation() RESET search_path;
ALTER FUNCTION public.prevent_tenant_devices_tenant_id_change() RESET search_path;
ALTER FUNCTION public.set_updated_at() RESET search_path;
ALTER FUNCTION public.tenant_contract_certificates_protect_immutable() RESET search_path;
ALTER FUNCTION public.tenant_contract_envelopes_assert_refs() RESET search_path;
ALTER FUNCTION public.tenant_contract_envelopes_touch_updated_at() RESET search_path;
ALTER FUNCTION public.tenant_contract_invitation_delivery_attempts_protect_delete() RESET search_path;
ALTER FUNCTION public.tenant_contract_invitation_delivery_attempts_protect_update() RESET search_path;
ALTER FUNCTION public.tenant_contract_invitation_generations_assert_refs() RESET search_path;
ALTER FUNCTION public.tenant_contract_invitation_generations_protect_delete() RESET search_path;
ALTER FUNCTION public.tenant_contract_invitation_generations_protect_update() RESET search_path;
ALTER FUNCTION public.tenant_contract_invitations_assert_refs() RESET search_path;
ALTER FUNCTION public.tenant_contract_invitations_protect_terminal() RESET search_path;
ALTER FUNCTION public.tenant_contract_packages_assert_refs() RESET search_path;
ALTER FUNCTION public.tenant_contract_packages_protect_immutable() RESET search_path;
ALTER FUNCTION public.tenant_contract_signature_events_append_only() RESET search_path;
ALTER FUNCTION public.tenant_contract_signed_artifacts_protect_immutable() RESET search_path;
ALTER FUNCTION public.tenant_contract_signers_assert_refs() RESET search_path;
ALTER FUNCTION public.tenant_contract_signers_touch_updated_at() RESET search_path;
ALTER FUNCTION public.tenant_contract_signing_tokens_assert_refs() RESET search_path;
ALTER FUNCTION public.tenant_contract_signing_tokens_protect_immutable() RESET search_path;
ALTER FUNCTION public.tenant_contract_signing_tokens_touch_updated_at() RESET search_path;
ALTER FUNCTION public.tenant_project_payment_intents_assert_refs() RESET search_path;
ALTER FUNCTION public.activate_next_invoice_for_quote(uuid) RESET search_path;
ALTER FUNCTION public.calc_quote_labor_cost(uuid) RESET search_path;
ALTER FUNCTION public.create_payment_schedule_from_quote(uuid, uuid, numeric, text, text, text, date) RESET search_path;
ALTER FUNCTION public.refresh_invoice_payment_totals(uuid) RESET search_path;
ALTER FUNCTION public.register_invoice_payment(uuid, numeric) RESET search_path;
ALTER FUNCTION public.register_invoice_payment(uuid, uuid, numeric, text, text, text, text) RESET search_path;
ALTER FUNCTION public.mg_business_id() RESET search_path;
ALTER FUNCTION public.mg_role() RESET search_path;

NOTIFY pgrst, 'reload schema';

COMMIT;
