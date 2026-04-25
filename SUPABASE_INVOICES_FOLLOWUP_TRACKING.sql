-- =============================================================================
-- Margin Guard | Invoice automated follow-up tracking (server-side cron)
-- =============================================================================
-- Run once on Supabase after public.invoices exists.
-- Stores when each reminder wave was successfully sent (Zapier webhook).
-- =============================================================================

DO $prereq$
BEGIN
  IF to_regclass('public.invoices') IS NULL THEN
    RAISE EXCEPTION 'public.invoices is missing.';
  END IF;
END
$prereq$;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS followup_1_sent_at timestamptz;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS followup_2_sent_at timestamptz;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS followup_3_sent_at timestamptz;

COMMENT ON COLUMN public.invoices.followup_1_sent_at IS 'First invoice reminder (+10m after sent_at), Zapier sent.';
COMMENT ON COLUMN public.invoices.followup_2_sent_at IS 'Second reminder (+24h after sent_at).';
COMMENT ON COLUMN public.invoices.followup_3_sent_at IS 'Third reminder (+72h after sent_at).';
