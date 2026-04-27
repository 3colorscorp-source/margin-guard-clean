-- Invoice payment purpose label (UI + storage only; no payment logic).
alter table public.invoices
  add column if not exists invoice_label text default '';

comment on column public.invoices.invoice_label is 'Human-readable purpose of this invoice (e.g. deposit, progress payment).';
