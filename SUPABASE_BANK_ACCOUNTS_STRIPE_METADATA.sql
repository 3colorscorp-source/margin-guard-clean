-- Optional: run in Supabase if tenant_bank_accounts lacks Stripe display fields.
-- Enables complete-financial-connections to persist institution_name, last4, category.

alter table public.tenant_bank_accounts
  add column if not exists institution_name text not null default '';

alter table public.tenant_bank_accounts
  add column if not exists account_last4 text not null default '';

alter table public.tenant_bank_accounts
  add column if not exists account_category text not null default '';
