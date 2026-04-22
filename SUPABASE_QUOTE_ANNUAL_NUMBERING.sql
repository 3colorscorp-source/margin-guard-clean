-- Annual quote numbers per tenant: YYYY-0001, reset each calendar year (UTC).
-- Run after public.tenants and public.quotes exist.

-- ---------------------------------------------------------------------------
-- Counter table (concurrency-safe via INSERT ... ON CONFLICT DO UPDATE)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.quote_annual_counters (
  tenant_id uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  quote_year integer NOT NULL,
  last_sequence integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT timezone ('utc', now()),
  PRIMARY KEY (tenant_id, quote_year)
);

CREATE INDEX IF NOT EXISTS quote_annual_counters_year_idx
  ON public.quote_annual_counters (quote_year);

-- ---------------------------------------------------------------------------
-- Allocate next sequence for tenant + current UTC year; returns jsonb.
-- PostgREST RPC: POST /rest/v1/rpc/allocate_next_quote_number  body: {"p_tenant_id":"<uuid>"}
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.allocate_next_quote_number (uuid);

CREATE OR REPLACE FUNCTION public.allocate_next_quote_number (p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  y int := (EXTRACT(YEAR FROM (timezone ('utc', now())))::integer);
  new_seq int;
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'tenant_id required';
  END IF;

  INSERT INTO public.quote_annual_counters (tenant_id, quote_year, last_sequence)
  VALUES (p_tenant_id, y, 1)
  ON CONFLICT (tenant_id, quote_year)
  DO UPDATE SET
    last_sequence = public.quote_annual_counters.last_sequence + 1,
    updated_at = timezone ('utc', now())
  RETURNING last_sequence INTO new_seq;

  RETURN jsonb_build_object(
    'quote_year', y,
    'quote_sequence', new_seq,
    'quote_number_display', format('%s-%s', y, lpad(new_seq::text, 4, '0'))
  );
END;
$$;

REVOKE ALL ON FUNCTION public.allocate_next_quote_number (uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.allocate_next_quote_number (uuid) TO service_role;

-- Refresh PostgREST schema cache so the RPC appears immediately (safe if listener is absent).
NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- quotes columns (persisted display number)
-- ---------------------------------------------------------------------------
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS quote_year integer;

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS quote_sequence integer;

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS quote_number_display text;

-- Uniqueness: one row per tenant/year/sequence; one display string per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS quotes_tenant_year_sequence_uidx
  ON public.quotes (tenant_id, quote_year, quote_sequence)
  WHERE quote_year IS NOT NULL AND quote_sequence IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS quotes_tenant_quote_number_display_uidx
  ON public.quotes (tenant_id, quote_number_display)
  WHERE quote_number_display IS NOT NULL AND quote_number_display <> '';
