-- Server-side dedupe for public estimate open / follow-up sequence (one row per quote).
-- Run on Supabase after public.quotes exists.

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS first_view_tracked_at timestamptz;

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS followup_sequence_started_at timestamptz;

COMMENT ON COLUMN public.quotes.first_view_tracked_at IS 'First time public estimate view tracking claimed (global dedupe).';
COMMENT ON COLUMN public.quotes.followup_sequence_started_at IS 'When follow-up sequence was first started (set with first_view_tracked_at).';
