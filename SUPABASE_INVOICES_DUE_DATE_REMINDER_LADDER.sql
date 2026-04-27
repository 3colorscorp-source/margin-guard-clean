-- =============================================================================
-- Margin Guard | Past-due invoice reminder ladder (D1 / D3 / D7 / D14)
-- =============================================================================
-- Tracks one successful Zapier post per stage. Used by invoice-followups-due.js
-- with ZAPIER_INVOICE_REMINDER_WEBHOOK. Run after public.invoices exists.
-- =============================================================================

DO $prereq$
BEGIN
  IF to_regclass('public.invoices') IS NULL THEN
    RAISE EXCEPTION 'public.invoices is missing.';
  END IF;
END
$prereq$;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS reminder_d1_sent_at timestamptz;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS reminder_d3_sent_at timestamptz;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS reminder_d7_sent_at timestamptz;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS reminder_d14_sent_at timestamptz;

COMMENT ON COLUMN public.invoices.reminder_d1_sent_at IS 'Past-due reminder D1 (1 calendar day after due_date), Zapier sent.';
COMMENT ON COLUMN public.invoices.reminder_d3_sent_at IS 'Past-due reminder D3 (3 calendar days after due_date), Zapier sent.';
COMMENT ON COLUMN public.invoices.reminder_d7_sent_at IS 'Past-due reminder D7 (7 calendar days after due_date), Zapier sent.';
COMMENT ON COLUMN public.invoices.reminder_d14_sent_at IS 'Past-due reminder D14 (14 calendar days after due_date), Zapier sent.';
