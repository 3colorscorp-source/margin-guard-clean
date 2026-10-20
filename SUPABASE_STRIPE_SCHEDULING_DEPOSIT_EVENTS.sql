-- Stripe scheduling deposit reconciliation.
-- UNAPPLIED. Review and apply in the Supabase SQL editor separately.
-- Do NOT run this against production from Cursor.
--
-- Does not add balance_effect.
-- Does not change tenant_project_payments constraints.
-- Does not rewrite historical manual, additional, or legacy deposit rows.
-- payment_type = deposit remains available for more than one owner-recorded row.
--
-- SECURITY INVOKER:
--   Netlify calls this with the service_role key. service_role bypasses RLS.
--   SECURITY DEFINER is not used. search_path is fixed anyway.
--   EXECUTE is revoked from PUBLIC, anon, and authenticated.

BEGIN;

CREATE TABLE IF NOT EXISTS public.stripe_scheduling_deposit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants (id),
  quote_id uuid NOT NULL REFERENCES public.quotes (id),
  project_id uuid NOT NULL REFERENCES public.tenant_projects (id),
  checkout_session_id text NOT NULL,
  stripe_account_id text NOT NULL,
  currency text NOT NULL,
  gross_amount numeric(14, 2) NOT NULL,
  disposition text NOT NULL,
  applied_payment_id uuid NULL REFERENCES public.tenant_project_payments (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stripe_scheduling_deposit_events_session_uidx
    UNIQUE (tenant_id, checkout_session_id),
  CONSTRAINT stripe_scheduling_deposit_events_amount_positive
    CHECK (gross_amount > 0),
  CONSTRAINT stripe_scheduling_deposit_events_disposition_check
    CHECK (disposition IN ('applied', 'needs_review')),
  CONSTRAINT stripe_scheduling_deposit_events_applied_payment_check
    CHECK (
      (disposition = 'needs_review' AND applied_payment_id IS NULL)
      OR (disposition = 'applied' AND applied_payment_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS stripe_scheduling_deposit_one_applied_uidx
  ON public.stripe_scheduling_deposit_events (tenant_id, quote_id)
  WHERE disposition = 'applied';

CREATE INDEX IF NOT EXISTS stripe_scheduling_deposit_events_quote_idx
  ON public.stripe_scheduling_deposit_events (tenant_id, quote_id, disposition);

COMMENT ON TABLE public.stripe_scheduling_deposit_events IS
  'Stripe Checkout evidence for scheduling deposits. Applied means one contract credit exists in tenant_project_payments. needs_review preserves an additional real charge without crediting it again.';

ALTER TABLE public.stripe_scheduling_deposit_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service role full access stripe_scheduling_deposit_events"
  ON public.stripe_scheduling_deposit_events;
CREATE POLICY "service role full access stripe_scheduling_deposit_events"
  ON public.stripe_scheduling_deposit_events
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON TABLE public.stripe_scheduling_deposit_events FROM PUBLIC;
REVOKE ALL ON TABLE public.stripe_scheduling_deposit_events FROM anon;
REVOKE ALL ON TABLE public.stripe_scheduling_deposit_events FROM authenticated;
GRANT ALL ON TABLE public.stripe_scheduling_deposit_events TO service_role;

CREATE OR REPLACE FUNCTION public.record_verified_scheduling_deposit(
  p_tenant_id uuid,
  p_quote_id uuid,
  p_project_id uuid,
  p_checkout_session_id text,
  p_stripe_account_id text,
  p_currency text,
  p_gross_amount numeric,
  p_paid_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_quote public.quotes%ROWTYPE;
  v_project public.tenant_projects%ROWTYPE;
  v_event public.stripe_scheduling_deposit_events%ROWTYPE;
  v_applied public.stripe_scheduling_deposit_events%ROWTYPE;
  v_payment public.tenant_project_payments%ROWTYPE;
  v_session text;
  v_currency text;
  v_gross numeric(14, 2);
  v_required_cents bigint;
  v_gross_cents bigint;
  v_blocking_other boolean := false;
  v_same_payment public.tenant_project_payments%ROWTYPE;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  v_session := btrim(coalesce(p_checkout_session_id, ''));
  v_currency := lower(btrim(coalesce(p_currency, '')));
  IF p_tenant_id IS NULL OR p_quote_id IS NULL OR p_project_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_reference');
  END IF;
  IF char_length(v_session) < 8 OR char_length(v_session) > 255 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_session');
  END IF;
  IF btrim(coalesce(p_stripe_account_id, '')) = '' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_session');
  END IF;
  IF v_currency <> 'usd' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_currency');
  END IF;
  -- p_paid_at is the confirmed charge time from the succeeded Charge balance
  -- transaction. It is not PaymentIntent.created. An existing quote
  -- deposit_paid_at is kept below with COALESCE and is never replaced.
  IF p_paid_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_paid_at');
  END IF;
  IF p_gross_amount IS NULL OR p_gross_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_amount');
  END IF;
  v_gross := round(p_gross_amount, 2);
  v_gross_cents := round(v_gross * 100);

  SELECT *
    INTO v_quote
  FROM public.quotes
  WHERE id = p_quote_id
    AND tenant_id = p_tenant_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'quote_not_found');
  END IF;

  SELECT *
    INTO v_project
  FROM public.tenant_projects
  WHERE id = p_project_id
    AND tenant_id = p_tenant_id
    AND quote_id = p_quote_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'project_mismatch');
  END IF;

  IF v_quote.deposit_required IS NULL OR v_quote.deposit_required <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'amount_mismatch');
  END IF;
  v_required_cents := round(round(v_quote.deposit_required, 2) * 100);
  IF v_required_cents < 50 OR v_required_cents IS DISTINCT FROM v_gross_cents THEN
    RETURN jsonb_build_object('ok', false, 'code', 'amount_mismatch');
  END IF;

  SELECT *
    INTO v_event
  FROM public.stripe_scheduling_deposit_events
  WHERE tenant_id = p_tenant_id
    AND checkout_session_id = v_session
  FOR UPDATE;
  IF FOUND THEN
    IF v_event.quote_id IS DISTINCT FROM p_quote_id
       OR v_event.project_id IS DISTINCT FROM p_project_id
       OR round(v_event.gross_amount, 2) IS DISTINCT FROM v_gross
       OR lower(v_event.currency) IS DISTINCT FROM v_currency THEN
      RETURN jsonb_build_object('ok', false, 'code', 'session_conflict');
    END IF;
    RETURN jsonb_build_object(
      'ok', true,
      'outcome', 'already_recorded',
      'disposition', v_event.disposition,
      'event_id', v_event.id,
      'payment_id', v_event.applied_payment_id,
      'gross_amount', v_event.gross_amount,
      'paid_at', p_paid_at
    );
  END IF;

  SELECT *
    INTO v_same_payment
  FROM public.tenant_project_payments
  WHERE tenant_id = p_tenant_id
    AND idempotency_key = v_session
  FOR UPDATE;

  SELECT EXISTS (
    SELECT 1
    FROM public.tenant_project_payments
    WHERE tenant_id = p_tenant_id
      AND payment_type = 'deposit'
      AND amount > 0
      AND coalesce(idempotency_key, '') IS DISTINCT FROM v_session
      AND (
        quote_id = p_quote_id
        OR (project_id = p_project_id AND quote_id IS NULL)
      )
  ) INTO v_blocking_other;

  SELECT *
    INTO v_applied
  FROM public.stripe_scheduling_deposit_events
  WHERE tenant_id = p_tenant_id
    AND quote_id = p_quote_id
    AND disposition = 'applied'
  FOR UPDATE;

  IF v_same_payment.id IS NOT NULL
     AND v_applied.id IS NULL
     AND NOT v_blocking_other
     AND v_same_payment.quote_id = p_quote_id
     AND v_same_payment.project_id = p_project_id
     AND v_same_payment.payment_type = 'deposit'
     AND lower(v_same_payment.payment_method) = 'stripe'
     AND round(v_same_payment.amount, 2) = v_gross THEN
    INSERT INTO public.stripe_scheduling_deposit_events (
      tenant_id, quote_id, project_id, checkout_session_id, stripe_account_id,
      currency, gross_amount, disposition, applied_payment_id
    ) VALUES (
      p_tenant_id, p_quote_id, p_project_id, v_session, btrim(p_stripe_account_id),
      v_currency, v_gross, 'applied', v_same_payment.id
    );
    UPDATE public.quotes
      SET deposit_paid = true,
          deposit_paid_amount = v_gross,
          deposit_paid_at = COALESCE(deposit_paid_at, p_paid_at)
    WHERE id = p_quote_id
      AND tenant_id = p_tenant_id;
    UPDATE public.tenant_projects
      SET deposit_paid = true,
          updated_at = now(),
          status = CASE
            WHEN lower(btrim(coalesce(status, ''))) = 'signed' THEN 'deposit_paid'
            ELSE status
          END
    WHERE id = p_project_id
      AND tenant_id = p_tenant_id
      AND quote_id = p_quote_id;
    RETURN jsonb_build_object(
      'ok', true,
      'outcome', 'already_recorded',
      'disposition', 'applied',
      'payment_id', v_same_payment.id,
      'gross_amount', v_gross,
      'paid_at', COALESCE(v_quote.deposit_paid_at, p_paid_at)
    );
  END IF;

  IF v_applied.id IS NOT NULL OR v_blocking_other OR v_same_payment.id IS NOT NULL THEN
    INSERT INTO public.stripe_scheduling_deposit_events (
      tenant_id, quote_id, project_id, checkout_session_id, stripe_account_id,
      currency, gross_amount, disposition, applied_payment_id
    ) VALUES (
      p_tenant_id, p_quote_id, p_project_id, v_session, btrim(p_stripe_account_id),
      v_currency, v_gross, 'needs_review', NULL
    )
    RETURNING * INTO v_event;
    RETURN jsonb_build_object(
      'ok', true,
      'outcome', 'needs_review',
      'disposition', 'needs_review',
      'event_id', v_event.id,
      'payment_id', NULL,
      'gross_amount', v_gross,
      'paid_at', p_paid_at
    );
  END IF;

  BEGIN
    INSERT INTO public.tenant_project_payments (
      tenant_id, quote_id, project_id, invoice_id, payment_type, payment_method,
      amount, paid_at, notes, created_by, idempotency_key
    ) VALUES (
      p_tenant_id,
      p_quote_id,
      p_project_id,
      NULL,
      'deposit',
      'stripe',
      v_gross,
      p_paid_at,
      'Stripe Checkout scheduling deposit. Card processing fee is not part of this credit.',
      'stripe-scheduling-deposit',
      v_session
    )
    RETURNING * INTO v_payment;

    INSERT INTO public.stripe_scheduling_deposit_events (
      tenant_id, quote_id, project_id, checkout_session_id, stripe_account_id,
      currency, gross_amount, disposition, applied_payment_id
    ) VALUES (
      p_tenant_id, p_quote_id, p_project_id, v_session, btrim(p_stripe_account_id),
      v_currency, v_gross, 'applied', v_payment.id
    )
    RETURNING * INTO v_event;
  EXCEPTION
    WHEN unique_violation THEN
      INSERT INTO public.stripe_scheduling_deposit_events (
        tenant_id, quote_id, project_id, checkout_session_id, stripe_account_id,
        currency, gross_amount, disposition, applied_payment_id
      ) VALUES (
        p_tenant_id, p_quote_id, p_project_id, v_session, btrim(p_stripe_account_id),
        v_currency, v_gross, 'needs_review', NULL
      )
      RETURNING * INTO v_event;
      RETURN jsonb_build_object(
        'ok', true,
        'outcome', 'needs_review',
        'disposition', 'needs_review',
        'event_id', v_event.id,
        'payment_id', NULL,
        'gross_amount', v_gross,
        'paid_at', p_paid_at
      );
  END;

  UPDATE public.quotes
    SET deposit_paid = true,
        deposit_paid_amount = v_gross,
        deposit_paid_at = COALESCE(deposit_paid_at, p_paid_at)
  WHERE id = p_quote_id
    AND tenant_id = p_tenant_id;

  UPDATE public.tenant_projects
    SET deposit_paid = true,
        updated_at = now(),
        status = CASE
          WHEN lower(btrim(coalesce(status, ''))) = 'signed' THEN 'deposit_paid'
          ELSE status
        END
  WHERE id = p_project_id
    AND tenant_id = p_tenant_id
    AND quote_id = p_quote_id;

  RETURN jsonb_build_object(
    'ok', true,
    'outcome', 'applied_new',
    'disposition', 'applied',
    'event_id', v_event.id,
    'payment_id', v_payment.id,
    'gross_amount', v_gross,
    'paid_at', p_paid_at
  );
END;
$$;

COMMENT ON FUNCTION public.record_verified_scheduling_deposit(
  uuid, uuid, uuid, text, text, text, numeric, timestamptz
) IS
  'Atomically applies one scheduling deposit credit per tenant and quote, or preserves an additional Stripe charge as needs_review. Does not refund or delete payments.';

REVOKE ALL ON FUNCTION public.record_verified_scheduling_deposit(
  uuid, uuid, uuid, text, text, text, numeric, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_verified_scheduling_deposit(
  uuid, uuid, uuid, text, text, text, numeric, timestamptz
) FROM anon;
REVOKE ALL ON FUNCTION public.record_verified_scheduling_deposit(
  uuid, uuid, uuid, text, text, text, numeric, timestamptz
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_verified_scheduling_deposit(
  uuid, uuid, uuid, text, text, text, numeric, timestamptz
) TO service_role;

COMMIT;
