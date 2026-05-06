-- Tenant-level payment instructions and optional external payment link for public invoices.
-- Run in Supabase SQL editor. Does not alter RLS.

alter table public.owner_settings
add column if not exists payment_instructions text;

alter table public.owner_settings
add column if not exists payment_link text;

comment on column public.owner_settings.payment_instructions is 'Tenant-owned text shown on public invoice page (how to pay).';
comment on column public.owner_settings.payment_link is 'Optional tenant-owned URL (e.g. bank portal); opened in new tab from public invoice.';
