-- Who worked a Supervisor field day, stored with the labor report or unexpected expense.
-- Nullable and backward-compatible. The app still saves if this column is not applied yet.

alter table public.tenant_project_reports
  add column if not exists crew jsonb null;

alter table public.tenant_project_expenses
  add column if not exists crew jsonb null;
