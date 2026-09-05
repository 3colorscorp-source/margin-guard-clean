-- MG-SALES-READY-007B — Invoice Hub payment recording integrity
-- UNAPPLIED. Review and apply in the Supabase SQL editor separately.
-- Do NOT run from Cursor. Does not UPDATE/DELETE historical payment rows.
-- Does not repair tenant_id-null invoices. Does not change invoices_status_check.
--
-- Dollars contract:
--   tenant_project_payments.amount stays numeric dollars (numeric(14,2)).
--   round(p_amount, 2) is 2-decimal precision only — never multiply by 100 before write.
--
-- SECURITY INVOKER (not DEFINER):
--   Netlify calls this RPC with the service_role key. service_role already has
--   table access and bypasses RLS. DEFINER would widen the trusted computing base
--   without adding a needed privilege, so it is not used.

BEGIN;

ALTER TABLE public.tenant_project_payments
  ADD COLUMN IF NOT EXISTS idempotency_key text;

COMMENT ON COLUMN public.tenant_project_payments.idempotency_key IS
  'Nullable. New Invoice Hub payments send a UUID. Historical rows remain NULL. Unique per tenant when present.';

CREATE UNIQUE INDEX IF NOT EXISTS tenant_project_payments_tenant_idempotency_uidx
  ON public.tenant_project_payments (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE OR REPLACE FUNCTION public.record_tenant_invoice_payment(
  p_tenant_id uuid,
  p_invoice_id uuid,
  p_payment_type text,
  p_payment_method text,
  p_amount numeric,
  p_paid_at timestamptz,
  p_notes text,
  p_created_by text,
  p_idempotency_key text,
  p_quote_id uuid DEFAULT NULL,
  p_project_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inv public.invoices%ROWTYPE;
  v_pay public.tenant_project_payments%ROWTYPE;
  v_status text;
  v_amount numeric(14, 2);
  v_ledger numeric(14, 2);
  v_remaining numeric(14, 2);
  v_new_paid numeric(14, 2);
  v_new_balance numeric(14, 2);
  v_now timestamptz := timezone('utc', now());
  v_paid_at timestamptz;
  v_type text;
  v_method text;
  v_notes text;
  v_quote uuid;
  v_epsilon numeric := 0.005;
BEGIN
  IF p_tenant_id IS NULL OR p_invoice_id IS NULL THEN
    RAISE EXCEPTION 'MG_PAY:%', 'invoice_not_found' USING ERRCODE = '22023';
  END IF;

  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'MG_PAY:%', 'missing_idempotency_key' USING ERRCODE = '22023';
  END IF;

  v_type := lower(btrim(coalesce(p_payment_type, '')));
  v_method := lower(btrim(coalesce(p_payment_method, '')));
  IF v_type NOT IN ('deposit', 'progress', 'final', 'adjustment') THEN
    RAISE EXCEPTION 'MG_PAY:%', 'invalid_payment_type' USING ERRCODE = '22023';
  END IF;
  IF v_method NOT IN ('check', 'cash', 'zelle', 'stripe', 'bank_transfer', 'other') THEN
    RAISE EXCEPTION 'MG_PAY:%', 'invalid_payment_method' USING ERRCODE = '22023';
  END IF;

  IF p_amount IS NULL THEN
    RAISE EXCEPTION 'MG_PAY:%', 'invalid_amount' USING ERRCODE = '22023';
  END IF;

  -- Dollars in, dollars stored. round(..., 2) is precision, not a cents conversion.
  v_amount := round(p_amount, 2);
  IF v_amount = 0 THEN
    RAISE EXCEPTION 'MG_PAY:%', 'zero_amount' USING ERRCODE = '22023';
  END IF;
  IF v_type IN ('deposit', 'progress', 'final') AND v_amount < 0 THEN
    RAISE EXCEPTION 'MG_PAY:%', 'negative_normal_payment' USING ERRCODE = '22023';
  END IF;

  v_paid_at := coalesce(p_paid_at, v_now);
  v_notes := coalesce(p_notes, '');

  SELECT *
    INTO v_inv
    FROM public.invoices
   WHERE id = p_invoice_id
     AND tenant_id = p_tenant_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MG_PAY:%', 'invoice_not_found' USING ERRCODE = '22023';
  END IF;

  v_status := lower(btrim(coalesce(v_inv.status, '')));
  IF v_status = 'archived' THEN
    RAISE EXCEPTION 'MG_PAY:%', 'invoice_archived' USING ERRCODE = '22023';
  END IF;
  IF v_status IN ('cancelled', 'canceled') THEN
    RAISE EXCEPTION 'MG_PAY:%', 'invoice_cancelled' USING ERRCODE = '22023';
  END IF;
  -- Reject if a void row exists. Do not write status 'void' from this function.
  IF v_status = 'void' THEN
    RAISE EXCEPTION 'MG_PAY:%', 'invoice_void' USING ERRCODE = '22023';
  END IF;

  IF p_quote_id IS NOT NULL
     AND v_inv.quote_id IS NOT NULL
     AND v_inv.quote_id IS DISTINCT FROM p_quote_id THEN
    RAISE EXCEPTION 'MG_PAY:%', 'quote_mismatch' USING ERRCODE = '22023';
  END IF;

  IF p_project_id IS NOT NULL THEN
    PERFORM 1
      FROM public.tenant_projects
     WHERE id = p_project_id
       AND tenant_id = p_tenant_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'MG_PAY:%', 'project_not_found' USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT *
    INTO v_pay
    FROM public.tenant_project_payments
   WHERE tenant_id = p_tenant_id
     AND idempotency_key = p_idempotency_key;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'payment', to_jsonb(v_pay),
      'invoice', jsonb_build_object(
        'id', v_inv.id,
        'paid_amount', v_inv.paid_amount,
        'balance_due', v_inv.balance_due,
        'status', v_inv.status,
        'paid_at', v_inv.paid_at
      )
    );
  END IF;

  SELECT coalesce(sum(amount), 0)
    INTO v_ledger
    FROM public.tenant_project_payments
   WHERE tenant_id = p_tenant_id
     AND invoice_id = p_invoice_id;

  v_remaining := round(coalesce(v_inv.amount, 0) - v_ledger, 2);

  IF v_type IN ('deposit', 'progress', 'final') THEN
    IF v_remaining <= v_epsilon THEN
      RAISE EXCEPTION 'MG_PAY:%', 'invoice_already_paid' USING ERRCODE = '22023';
    END IF;
    IF v_amount > v_remaining + v_epsilon THEN
      RAISE EXCEPTION 'MG_PAY:%', 'payment_exceeds_remaining_balance' USING ERRCODE = '22023';
    END IF;
  END IF;

  v_quote := coalesce(p_quote_id, v_inv.quote_id);

  BEGIN
    INSERT INTO public.tenant_project_payments (
      tenant_id,
      quote_id,
      invoice_id,
      project_id,
      payment_type,
      payment_method,
      amount,
      paid_at,
      notes,
      created_by,
      idempotency_key
    ) VALUES (
      p_tenant_id,
      v_quote,
      p_invoice_id,
      p_project_id,
      v_type,
      v_method,
      v_amount,
      v_paid_at,
      v_notes,
      p_created_by,
      p_idempotency_key
    )
    RETURNING * INTO v_pay;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT *
        INTO v_pay
        FROM public.tenant_project_payments
       WHERE tenant_id = p_tenant_id
         AND idempotency_key = p_idempotency_key;
      RETURN jsonb_build_object(
        'ok', true,
        'idempotent', true,
        'payment', to_jsonb(v_pay),
        'invoice', jsonb_build_object(
          'id', v_inv.id,
          'paid_amount', v_inv.paid_amount,
          'balance_due', v_inv.balance_due,
          'status', v_inv.status,
          'paid_at', v_inv.paid_at
        )
      );
  END;

  SELECT coalesce(sum(amount), 0)
    INTO v_new_paid
    FROM public.tenant_project_payments
   WHERE tenant_id = p_tenant_id
     AND invoice_id = p_invoice_id;

  v_new_paid := round(v_new_paid, 2);
  v_new_balance := round(coalesce(v_inv.amount, 0) - v_new_paid, 2);
  IF v_new_balance < 0 AND v_new_balance > (0 - v_epsilon) THEN
    v_new_balance := 0;
  END IF;
  IF v_new_balance < 0 THEN
    v_new_balance := 0;
  END IF;

  IF v_new_balance <= v_epsilon THEN
    v_new_balance := 0;
    UPDATE public.invoices
       SET paid_amount = v_new_paid,
           balance_due = 0,
           status = 'paid',
           paid_at = coalesce(v_inv.paid_at, v_paid_at, v_now),
           updated_at = v_now
     WHERE id = v_inv.id
       AND tenant_id = p_tenant_id
    RETURNING * INTO v_inv;
  ELSE
    UPDATE public.invoices
       SET paid_amount = v_new_paid,
           balance_due = v_new_balance,
           updated_at = v_now
     WHERE id = v_inv.id
       AND tenant_id = p_tenant_id
    RETURNING * INTO v_inv;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'payment', to_jsonb(v_pay),
    'invoice', jsonb_build_object(
      'id', v_inv.id,
      'paid_amount', v_inv.paid_amount,
      'balance_due', v_inv.balance_due,
      'status', v_inv.status,
      'paid_at', v_inv.paid_at
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_tenant_invoice_payment(
  uuid, uuid, text, text, numeric, timestamptz, text, text, text, uuid, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_tenant_invoice_payment(
  uuid, uuid, text, text, numeric, timestamptz, text, text, text, uuid, uuid
) FROM anon;
REVOKE ALL ON FUNCTION public.record_tenant_invoice_payment(
  uuid, uuid, text, text, numeric, timestamptz, text, text, text, uuid, uuid
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_tenant_invoice_payment(
  uuid, uuid, text, text, numeric, timestamptz, text, text, text, uuid, uuid
) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
