-- Legacy mirror of Stripe Financial Connections account id (fca_...).
alter table public.tenant_bank_accounts
  add column if not exists provider_account_id text;
