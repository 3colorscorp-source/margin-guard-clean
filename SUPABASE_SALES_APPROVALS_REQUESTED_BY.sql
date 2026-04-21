-- Optional: store the logged-in rep email on each sales approval row (Sales Admin "Seller" column).
-- Run in Supabase SQL editor if create-sales-approval should persist requested_by_email.

alter table public.sales_approvals
  add column if not exists requested_by_email text not null default '';
