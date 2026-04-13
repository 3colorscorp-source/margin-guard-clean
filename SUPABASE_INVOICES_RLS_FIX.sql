-- P0: Close anon/authenticated table reads on public.invoices.
-- Invoice HTML must use Netlify get-public-invoice.js (service_role REST only).

drop policy if exists "public read invoice by token" on public.invoices;

drop policy if exists "service role full access invoices" on public.invoices;
create policy "service role full access invoices"
on public.invoices
for all
to service_role
using (true)
with check (true);
