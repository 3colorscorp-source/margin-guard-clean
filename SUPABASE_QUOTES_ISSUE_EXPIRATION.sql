-- Quote issue / expiration dates for public estimate header display.
-- Run in Supabase SQL editor before relying on persisted expiration_date on publish.

alter table public.quotes add column if not exists issue_date date null;
alter table public.quotes add column if not exists expiration_date date null;

comment on column public.quotes.issue_date is 'Quote issue date captured at publish time';
comment on column public.quotes.expiration_date is 'Quote expiration date captured at publish time';
