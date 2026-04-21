-- One-time secret for owner email approve/decline links (hashed at rest). Run after sales_approvals exists.
-- Used by create-sales-approval.js (PATCH) and sales-approval-email-action.js (GET validate).

alter table public.sales_approvals
  add column if not exists email_action_token_hash text not null default '';

comment on column public.sales_approvals.email_action_token_hash is
  'SHA-256 hex of random token emailed to tenant owner for yellow-margin approval links only.';
