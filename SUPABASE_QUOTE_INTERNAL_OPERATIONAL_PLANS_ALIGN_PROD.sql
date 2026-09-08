-- Align production public.mg_confirm_quote_operational_plan with the repo.
-- DO NOT apply without explicit owner authorization.
-- DO NOT run from CI. Paste into the Supabase SQL editor only after
-- SUPABASE_QUOTE_INTERNAL_OPERATIONAL_PLANS_INSPECT.sql.
--
-- Why this exists:
-- PR #21 omits untyped nulls (Owner has no session membership) and empty
-- p_operational_plan []. Production already returned PGRST202 when
-- p_membership_id was omitted. PostgREST will keep failing until the live
-- function has those defaults in pg_proc AND the schema cache is reloaded.
--
-- This script is idempotent:
--   * table / index / RLS / policy use IF NOT EXISTS or DROP IF EXISTS
--   * every existing overload of this name is dropped, then one 11-arg
--     function is created with DEFAULT NULL / '[]'::jsonb
--   * NOTIFY reloads the PostgREST schema cache
-- It does not delete quote rows or send email/webhooks.

BEGIN;

-- One live signature only. Extra overloads make PostgREST PGRST202 on omit.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'mg_confirm_quote_operational_plan'
  LOOP
    EXECUTE format(
      'DROP FUNCTION IF EXISTS public.mg_confirm_quote_operational_plan(%s)',
      r.args
    );
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS public.quote_internal_operational_plans (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  document jsonb not null,
  schema_version integer not null default 1,
  last_updated_by_membership_id uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint quote_internal_operational_plans_tenant_quote_uidx unique (tenant_id, quote_id),
  constraint quote_internal_operational_plans_document_object
    check (jsonb_typeof(document) = 'object')
);

COMMENT ON TABLE public.quote_internal_operational_plans IS
  'Tenant-internal structured daily operational plan. Service-role Netlify only. Never expose on public quote APIs.';

COMMENT ON COLUMN public.quote_internal_operational_plans.document IS
  'Versioned JSON: schema_version, source, days[].day_id, client_scope, internal tasks/assignments. No labor rates.';

COMMENT ON COLUMN public.quote_internal_operational_plans.last_updated_by_membership_id IS
  'Membership id that last confirmed the plan, when the session has one.';

CREATE INDEX IF NOT EXISTS quote_internal_operational_plans_quote_id_idx
  ON public.quote_internal_operational_plans (quote_id);

ALTER TABLE public.quote_internal_operational_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quote_internal_operational_plans FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.quote_internal_operational_plans FROM public;
REVOKE ALL ON TABLE public.quote_internal_operational_plans FROM anon;
REVOKE ALL ON TABLE public.quote_internal_operational_plans FROM authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.quote_internal_operational_plans TO service_role;

DROP POLICY IF EXISTS "service role full access quote_internal_operational_plans"
  ON public.quote_internal_operational_plans;

CREATE POLICY "service role full access quote_internal_operational_plans"
  ON public.quote_internal_operational_plans
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.mg_confirm_quote_operational_plan(
  p_tenant_id uuid,
  p_quote_id uuid,
  p_document jsonb,
  p_schema_version integer default 1,
  p_membership_id uuid default null,
  p_operational_plan jsonb default '[]'::jsonb,
  p_estimated_days numeric default null,
  p_estimated_hours numeric default null,
  p_start_date date default null,
  p_due_date date default null,
  p_scope_of_work text default null
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_quote public.quotes%rowtype;
BEGIN
  IF p_document IS NULL OR jsonb_typeof(p_document) <> 'object' THEN
    RAISE EXCEPTION 'p_document must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF p_operational_plan IS NULL OR jsonb_typeof(p_operational_plan) <> 'array' THEN
    RAISE EXCEPTION 'p_operational_plan must be a JSON array' USING ERRCODE = '22023';
  END IF;

  SELECT q.*
    INTO v_quote
    FROM public.quotes q
   WHERE q.id = p_quote_id
     AND q.tenant_id = p_tenant_id
   FOR UPDATE;

  IF v_quote.id IS NULL THEN
    RAISE EXCEPTION 'quote not found for tenant' USING ERRCODE = 'P0002';
  END IF;

  IF lower(btrim(coalesce(v_quote.status, ''))) NOT IN (
    'draft', 'ready_to_send', 'sent', 'pending', 'declined', 'rejected'
  )
    OR v_quote.accepted_at IS NOT NULL
    OR v_quote.deposit_paid_at IS NOT NULL
    OR nullif(btrim(coalesce(v_quote.exclusions_initials, '')), '') IS NOT NULL
    OR v_quote.exclusions_acknowledged_at IS NOT NULL
    OR v_quote.change_order_acknowledged_at IS NOT NULL
    OR EXISTS (
      SELECT 1
        FROM public.tenant_projects tp
       WHERE tp.tenant_id = p_tenant_id
         AND tp.quote_id = p_quote_id
    )
    OR EXISTS (
      SELECT 1
        FROM public.invoices i
       WHERE i.tenant_id = p_tenant_id
         AND i.quote_id = p_quote_id
         AND lower(btrim(coalesce(i.status, ''))) NOT IN (
           'void', 'archived', 'cancelled', 'canceled'
         )
    )
    OR EXISTS (
      SELECT 1
        FROM public.tenant_project_payments tpp
       WHERE tpp.tenant_id = p_tenant_id
         AND (
           tpp.quote_id = p_quote_id
           OR tpp.invoice_id IN (
             SELECT i.id
               FROM public.invoices i
              WHERE i.tenant_id = p_tenant_id
                AND i.quote_id = p_quote_id
           )
         )
    )
  THEN
    RAISE EXCEPTION 'quote is locked and cannot be edited' USING ERRCODE = '55000';
  END IF;

  UPDATE public.quotes q
     SET operational_plan = p_operational_plan,
         estimated_days = p_estimated_days,
         estimated_hours = p_estimated_hours,
         start_date = coalesce(p_start_date, q.start_date),
         due_date = coalesce(p_due_date, q.due_date),
         scope_of_work = coalesce(nullif(btrim(p_scope_of_work), ''), q.scope_of_work),
         updated_at = timezone('utc', now())
   WHERE q.id = p_quote_id
     AND q.tenant_id = p_tenant_id;

  INSERT INTO public.quote_internal_operational_plans (
    quote_id,
    tenant_id,
    document,
    schema_version,
    last_updated_by_membership_id,
    created_at,
    updated_at
  ) VALUES (
    p_quote_id,
    p_tenant_id,
    p_document,
    greatest(coalesce(p_schema_version, 1), 1),
    p_membership_id,
    timezone('utc', now()),
    timezone('utc', now())
  )
  ON CONFLICT (tenant_id, quote_id) DO UPDATE
    SET document = excluded.document,
        schema_version = excluded.schema_version,
        last_updated_by_membership_id = excluded.last_updated_by_membership_id,
        updated_at = excluded.updated_at;

  RETURN jsonb_build_object(
    'ok', true,
    'quote_id', p_quote_id,
    'tenant_id', p_tenant_id,
    'persisted', true
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.mg_confirm_quote_operational_plan(
  uuid, uuid, jsonb, integer, uuid, jsonb, numeric, numeric, date, date, text
) FROM public;
REVOKE ALL ON FUNCTION public.mg_confirm_quote_operational_plan(
  uuid, uuid, jsonb, integer, uuid, jsonb, numeric, numeric, date, date, text
) FROM anon;
REVOKE ALL ON FUNCTION public.mg_confirm_quote_operational_plan(
  uuid, uuid, jsonb, integer, uuid, jsonb, numeric, numeric, date, date, text
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.mg_confirm_quote_operational_plan(
  uuid, uuid, jsonb, integer, uuid, jsonb, numeric, numeric, date, date, text
) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- Post-apply check (read-only). Expect one row, 11 args, pronargdefaults = 8,
-- and defaults on p_membership_id / p_operational_plan.
SELECT
  count(*) AS overload_count,
  max(p.pronargs) AS pronargs,
  max(p.pronargdefaults) AS pronargdefaults,
  max(pg_get_function_arguments(p.oid)) AS args_with_defaults
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'mg_confirm_quote_operational_plan';
