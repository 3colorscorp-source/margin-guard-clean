-- STEP 4C: timestamps for approval decisions. Run in Supabase after sales_approvals exists.

alter table public.sales_approvals
  add column if not exists updated_at timestamptz;

alter table public.sales_approvals
  add column if not exists approved_at timestamptz;
