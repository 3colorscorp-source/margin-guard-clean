-- Optional: link invoices to quotes for multi-tenant reporting (publish-public-invoice sends quote_id when available).
-- Run in Supabase SQL editor if invoices.quote_id is not present yet.

alter table public.invoices
  add column if not exists quote_id uuid references public.quotes (id) on delete set null;

create index if not exists invoices_quote_id_idx on public.invoices (quote_id);
