-- Project deposits: Stripe Connect (per-tenant). Run in Supabase SQL editor.
-- SaaS subscription (platform Stripe customer on tenants.stripe_customer_id) stays separate.

alter table public.tenants add column if not exists stripe_account_id text;
alter table public.tenants add column if not exists stripe_charges_enabled boolean default false;
alter table public.tenants add column if not exists stripe_details_submitted boolean default false;

comment on column public.tenants.stripe_account_id is 'Stripe Connect connected account id (acct_...) for project deposits.';
comment on column public.tenants.stripe_charges_enabled is 'True when Connect account can accept charges.';
comment on column public.tenants.stripe_details_submitted is 'True when Connect onboarding details submitted.';
