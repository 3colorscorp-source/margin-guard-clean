-- STEP 3 — Aggregated bucket balances + cash_on_hand for dashboard (no per-account storage).
-- Run in Supabase SQL editor after STEP 1.

alter table public.tenant_financial_summary
  add column if not exists operating_balance numeric(18, 2) not null default 0,
  add column if not exists savings_balance numeric(18, 2) not null default 0,
  add column if not exists profit_balance numeric(18, 2) not null default 0,
  add column if not exists tax_reserve_balance numeric(18, 2) not null default 0,
  add column if not exists cash_on_hand numeric(18, 2) not null default 0;
