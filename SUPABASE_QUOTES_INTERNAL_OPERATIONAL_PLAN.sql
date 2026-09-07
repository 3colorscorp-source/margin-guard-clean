-- Phase 1 Voice Operational Plan — internal structured daily plan on quotes.
-- DO NOT apply this file to remote Supabase from the Phase 1 PR.
-- Public estimate / PDF / email / Zapier must never select or return this column.

alter table public.quotes
  add column if not exists internal_operational_plan jsonb null;

comment on column public.quotes.internal_operational_plan is
  'Tenant-internal structured daily operational plan (schema_version + stable day_id). Never copy into notes, public estimate, PDF, or email.';
