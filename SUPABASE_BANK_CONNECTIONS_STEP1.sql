-- STEP 1 — Tenant-scoped foundation for blind, read-only financial dashboard (Stripe Financial Connections).
-- No payouts, transfers, or money movement. Aggregates only in tenant_financial_summary.
-- Run in Supabase SQL editor after public.tenants exists.
-- Application must enforce: no admin reads of tenant bank rows except aggregated summaries per product rules.

-- ---------------------------------------------------------------------------
-- 1) Connection lifecycle (Stripe Financial Connections Session / link state)
-- ---------------------------------------------------------------------------
create table if not exists public.tenant_bank_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  -- Stripe Financial Connections Session id (e.g. fcs_...) after creation; nullable until created
  stripe_fc_session_id text,
  status text not null default 'pending'
    check (status in ('pending', 'requires_action', 'active', 'cancelled', 'failed', 'disconnected')),
  -- Platform Stripe Customer id if the session is created for this tenant (optional; may live on tenants elsewhere)
  stripe_customer_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create index if not exists tenant_bank_connections_tenant_id_idx
  on public.tenant_bank_connections (tenant_id);

create index if not exists tenant_bank_connections_stripe_fc_session_id_idx
  on public.tenant_bank_connections (stripe_fc_session_id)
  where stripe_fc_session_id is not null;

-- ---------------------------------------------------------------------------
-- 2) Linked accounts (Stripe Financial Connections Account ids only — no PAN/RFC, no admin-facing labels from the bank)
-- ---------------------------------------------------------------------------
create table if not exists public.tenant_bank_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  tenant_bank_connection_id uuid not null references public.tenant_bank_connections (id) on delete cascade,
  -- Globally unique Stripe Financial Connections Account id (fca_...)
  stripe_fc_account_id text not null,
  status text not null default 'active'
    check (status in ('active', 'disconnected', 'inactive')),
  -- Optional tenant-entered nickname only (not synced from institution for admin surfacing)
  tenant_label text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  constraint tenant_bank_accounts_stripe_fc_account_id_key unique (stripe_fc_account_id)
);

create index if not exists tenant_bank_accounts_tenant_id_idx
  on public.tenant_bank_accounts (tenant_id);

create index if not exists tenant_bank_accounts_connection_id_idx
  on public.tenant_bank_accounts (tenant_bank_connection_id);

-- ---------------------------------------------------------------------------
-- 3) Map at most one linked account per logical bucket per tenant (Operating / Savings / Profit / Tax Reserve)
-- ---------------------------------------------------------------------------
create table if not exists public.tenant_financial_account_mapping (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  tenant_bank_account_id uuid not null references public.tenant_bank_accounts (id) on delete cascade,
  bucket text not null
    check (bucket in ('operating', 'savings', 'profit', 'tax_reserve')),
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  constraint tenant_financial_account_mapping_tenant_bucket_key unique (tenant_id, bucket),
  constraint tenant_financial_account_mapping_tenant_account_key unique (tenant_id, tenant_bank_account_id)
);

create index if not exists tenant_financial_account_mapping_tenant_id_idx
  on public.tenant_financial_account_mapping (tenant_id);

-- ---------------------------------------------------------------------------
-- 4) Pre-aggregated summaries only (dashboard consumes these — not raw balances per account for admins)
-- ---------------------------------------------------------------------------
create table if not exists public.tenant_financial_summary (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  period_start date not null,
  period_end date not null,
  currency text not null default 'USD',
  -- Blind aggregates; semantics defined by app (e.g. rolled-up inflows/outflows — no per-account breakdown here)
  total_inflow numeric(18, 2) not null default 0,
  total_outflow numeric(18, 2) not null default 0,
  net_change numeric(18, 2) not null default 0,
  source text not null default 'aggregate'
    check (source in ('aggregate', 'manual', 'stripe')),
  computed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  constraint tenant_financial_summary_period_chk check (period_end >= period_start),
  constraint tenant_financial_summary_tenant_period_key unique (tenant_id, period_start, period_end, currency)
);

create index if not exists tenant_financial_summary_tenant_id_idx
  on public.tenant_financial_summary (tenant_id);

create index if not exists tenant_financial_summary_period_idx
  on public.tenant_financial_summary (tenant_id, period_start desc, period_end desc);

-- ---------------------------------------------------------------------------
-- RLS: service role only for now (same pattern as other Margin Guard tables); tighten with tenant JWT policies later.
-- ---------------------------------------------------------------------------
alter table public.tenant_bank_connections enable row level security;
alter table public.tenant_bank_accounts enable row level security;
alter table public.tenant_financial_account_mapping enable row level security;
alter table public.tenant_financial_summary enable row level security;

drop policy if exists "service role full access tenant_bank_connections" on public.tenant_bank_connections;
create policy "service role full access tenant_bank_connections"
on public.tenant_bank_connections for all to service_role using (true) with check (true);

drop policy if exists "service role full access tenant_bank_accounts" on public.tenant_bank_accounts;
create policy "service role full access tenant_bank_accounts"
on public.tenant_bank_accounts for all to service_role using (true) with check (true);

drop policy if exists "service role full access tenant_financial_account_mapping" on public.tenant_financial_account_mapping;
create policy "service role full access tenant_financial_account_mapping"
on public.tenant_financial_account_mapping for all to service_role using (true) with check (true);

drop policy if exists "service role full access tenant_financial_summary" on public.tenant_financial_summary;
create policy "service role full access tenant_financial_summary"
on public.tenant_financial_summary for all to service_role using (true) with check (true);
