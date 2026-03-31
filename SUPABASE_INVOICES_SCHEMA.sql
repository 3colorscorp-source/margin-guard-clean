create extension if not exists pgcrypto;

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  public_token text unique not null,
  invoice_no text not null,
  customer_name text default '',
  customer_email text default '',
  project_name text default '',
  amount numeric(12,2) not null default 0,
  paid_amount numeric(12,2) not null default 0,
  balance_due numeric(12,2) not null default 0,
  issue_date date,
  due_date date,
  type text default 'service',
  notes text default '',
  payment_link text default '',
  business_name text default '',
  logo_url text default '',
  accent_color text default '',
  currency text default 'USD',
  status text default 'OPEN',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists invoices_public_token_idx on public.invoices(public_token);
create index if not exists invoices_invoice_no_idx on public.invoices(invoice_no);
create index if not exists invoices_status_idx on public.invoices(status);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_invoices_updated_at on public.invoices;
create trigger trg_invoices_updated_at
before update on public.invoices
for each row
execute function public.set_updated_at();

alter table public.invoices enable row level security;

drop policy if exists "public read invoice by token" on public.invoices;
create policy "public read invoice by token"
on public.invoices
for select
to anon, authenticated
using (public_token is not null);

drop policy if exists "service role full access invoices" on public.invoices;
create policy "service role full access invoices"
on public.invoices
for all
to service_role
using (true)
with check (true);
