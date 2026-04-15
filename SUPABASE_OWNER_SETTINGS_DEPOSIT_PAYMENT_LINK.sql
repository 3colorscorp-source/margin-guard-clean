-- Optional Stripe Payment Link per tenant (one row per tenant in owner_settings).
-- Run in Supabase SQL editor. Does not alter existing columns or RLS.

alter table public.owner_settings
add column if not exists deposit_payment_link text;

comment on column public.owner_settings.deposit_payment_link is 'Optional Stripe Payment Link URL for project deposits (tenant-specific).';
