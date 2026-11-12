-- Optional 3D view / proposal PDFs attached to an existing quote row.
-- Not a new table: metadata lives on public.quotes.proposal_pdfs.
-- Binary files stay in the private estimate-pdfs bucket (tenant/YYYY-MM-DD/file.pdf).
-- Run in the Supabase SQL editor before Owner/Seller upload can persist.

alter table public.quotes
  add column if not exists proposal_pdfs jsonb not null default '[]'::jsonb;

comment on column public.quotes.proposal_pdfs is
  'Optional proposal/3D-view PDF metadata for this quote only: [{id, name, object_path, size, uploaded_at}]. Paths must stay tenant-prefixed in estimate-pdfs.';

-- Reload PostgREST so the app can read/write the new column immediately.
notify pgrst, 'reload schema';
