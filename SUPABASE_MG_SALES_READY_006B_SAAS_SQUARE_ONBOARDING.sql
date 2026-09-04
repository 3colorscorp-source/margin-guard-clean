-- MG-SALES-READY-006B — Square SaaS onboarding + webhook event tables
-- DO NOT apply from Cursor/CI. Review, then run once in the Supabase SQL editor.
-- Does not UPDATE existing tenants. Does not alter public.square_webhook_events.
-- Does not enable automatic activation (that is a Netlify env kill switch).

BEGIN;

CREATE TABLE IF NOT EXISTS public.saas_onboarding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants (id),
  provider text NOT NULL,
  external_invoice_id text NOT NULL,
  external_payment_id text NULL,
  expected_amount_cents bigint NOT NULL,
  currency text NOT NULL,
  status text NOT NULL,
  terms_accepted_at timestamptz NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz NULL,
  activated_at timestamptz NULL,
  term_start_at timestamptz NULL,
  term_expires_at timestamptz NULL,
  last_error_code text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_onboarding_provider_square CHECK (provider = 'square'),
  CONSTRAINT saas_onboarding_amount_positive CHECK (expected_amount_cents > 0),
  CONSTRAINT saas_onboarding_currency_upper CHECK (currency = upper(currency)),
  CONSTRAINT saas_onboarding_status_known CHECK (
    status IN (
      'registered',
      'paid_verified',
      'activated',
      'ignored',
      'failed',
      'admin_review'
    )
  ),
  CONSTRAINT saas_onboarding_provider_invoice_unique UNIQUE (provider, external_invoice_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS saas_onboarding_provider_payment_uidx
  ON public.saas_onboarding (provider, external_payment_id)
  WHERE external_payment_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS saas_onboarding_one_open_square_per_tenant
  ON public.saas_onboarding (tenant_id)
  WHERE provider = 'square'
    AND status IN ('registered', 'paid_verified', 'failed', 'admin_review');

COMMENT ON TABLE public.saas_onboarding IS
  'Margin Guard SaaS billing onboarding. Square invoice correlation only. Not tenant project payments.';

CREATE TABLE IF NOT EXISTS public.saas_square_webhook_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  square_environment text NULL,
  external_invoice_id text NULL,
  external_payment_id text NULL,
  processing_status text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz NULL,
  processed_at timestamptz NULL,
  last_error_code text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_square_webhook_events_status_known CHECK (
    processing_status IN (
      'received',
      'verified',
      'processing',
      'activated',
      'ignored',
      'failed'
    )
  )
);

COMMENT ON TABLE public.saas_square_webhook_events IS
  'Idempotent Square SaaS webhook receipts. No raw body, PII, or payment credentials.';

DO $$
DECLARE
  t text;
  pol text;
  tables text[] := ARRAY['saas_onboarding', 'saas_square_webhook_events'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
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

COMMIT;
