-- Required for multi-tenant invoices and public invoice filtering (get-public-invoice).
-- Run if public.invoices exists but lacks tenant_id.

alter table public.invoices
  add column if not exists tenant_id uuid references public.tenants (id) on delete set null;

create index if not exists invoices_tenant_id_idx on public.invoices (tenant_id);
