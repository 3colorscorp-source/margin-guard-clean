-- Public client workflow: exclusions initials + change-order policy acknowledgment (per quote, by public_token).
-- Run in Supabase SQL editor if these columns are missing.

alter table public.quotes add column if not exists exclusions_initials text default '';
alter table public.quotes add column if not exists exclusions_acknowledged_at timestamptz;
alter table public.quotes add column if not exists change_order_acknowledged_at timestamptz;
