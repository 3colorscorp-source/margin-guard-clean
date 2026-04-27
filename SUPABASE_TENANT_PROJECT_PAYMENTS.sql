-- Margin Guard | Phase 1 — tenant_project_payments (additive payment ledger)
-- Run in Supabase SQL Editor after public.tenants, public.quotes, public.invoices, and public.tenant_projects exist.
-- No triggers; does not modify invoices.paid_amount or balance_due behavior.

create table if not exists public.tenant_project_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  quote_id uuid null references public.quotes (id) on delete set null,
  invoice_id uuid null references public.invoices (id) on delete cascade,
  project_id uuid null references public.tenant_projects (id) on delete set null,
  payment_type text not null
    check (payment_type in ('deposit', 'progress', 'final', 'adjustment')),
  payment_method text not null
    check (payment_method in ('check', 'cash', 'zelle', 'stripe', 'bank_transfer', 'other')),
  amount numeric(14, 2) not null,
  paid_at timestamptz not null default now(),
  notes text not null default '',
  created_by text null,
  created_at timestamptz not null default now(),
  constraint tenant_project_payments_amount_nonzero check (amount <> 0)
);

create index if not exists tenant_project_payments_tenant_invoice_idx
  on public.tenant_project_payments (tenant_id, invoice_id, paid_at desc);

create index if not exists tenant_project_payments_tenant_project_idx
  on public.tenant_project_payments (tenant_id, project_id, paid_at desc);

create index if not exists tenant_project_payments_tenant_quote_idx
  on public.tenant_project_payments (tenant_id, quote_id, paid_at desc);

alter table public.tenant_project_payments enable row level security;

drop policy if exists "service role full access tenant_project_payments" on public.tenant_project_payments;
create policy "service role full access tenant_project_payments"
  on public.tenant_project_payments for all to service_role using (true) with check (true);

comment on table public.tenant_project_payments is
  'Tenant-scoped payment ledger for deposits, progress payments, final payments, and adjustments. Invoices keep paid_amount and balance_due as rollup/cache.';
