-- Optional: run in Supabase if quotes table lacks tenant-facing business fields.
-- Used by publish-public-quote and get-public-estimate for public estimate header.

alter table public.quotes add column if not exists business_name text default '';
alter table public.quotes add column if not exists company_name text default '';
alter table public.quotes add column if not exists business_email text default '';
alter table public.quotes add column if not exists business_phone text default '';
alter table public.quotes add column if not exists business_address text default '';
