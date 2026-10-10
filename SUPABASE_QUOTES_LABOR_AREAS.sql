-- Quote labor areas (optional). Manual apply in the Supabase SQL editor.
-- Does not backfill or recalculate existing quotes. Null means no area breakdown.

alter table public.quotes
  add column if not exists labor_area_breakdown jsonb null;

comment on column public.quotes.labor_area_breakdown is
  'Optional area breakdown for one quote. Names and client scope are free text. public_subtotals are sell prices frozen at publish or owner reprice. Null keeps the quote as a single labor total.';
