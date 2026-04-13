-- Required for multi-tenant quotes: publish-public-quote sets tenant_id on insert.
-- Run if public.quotes exists but lacks tenant_id.

alter table public.quotes
  add column if not exists tenant_id uuid references public.tenants (id) on delete set null;

create index if not exists quotes_tenant_id_idx on public.quotes (tenant_id);
