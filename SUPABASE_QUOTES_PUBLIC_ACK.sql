-- Public client workflow: exclusions initials, change-order acknowledgment, and related PATCH fields.
-- Safe to run once in Supabase SQL editor (idempotent).

-- Acknowledgment columns (get-public-estimate SELECT + patch-public-quote-ack PATCH)
alter table public.quotes add column if not exists exclusions_initials text default '';
alter table public.quotes add column if not exists exclusions_acknowledged_at timestamptz;
alter table public.quotes add column if not exists change_order_acknowledged_at timestamptz;

-- Used by patch-public-quote-ack, update-public-estimate-status, and other quote PATCH handlers
alter table public.quotes add column if not exists updated_at timestamptz;

-- Set when the client accepts the estimate (update-public-estimate-status)
alter table public.quotes add column if not exists accepted_at timestamptz;
