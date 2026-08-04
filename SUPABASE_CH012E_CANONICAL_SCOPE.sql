-- =============================================================================
-- Margin Guard | CH-012E.1 — Canonical Contract Scope of Work (additive)
-- =============================================================================
-- STATUS: MANUAL SUPABASE APPLY REQUIRED — do not run from CI or auto-deploy.
--
-- PURPOSE:
--   Persist customer-approved Scope of Work separately from outbound estimate
--   email copy (quotes.notes), terms, operational plan, and internal notes.
--
-- DEPENDENCIES (MANUAL PRECHECK BEFORE APPLY):
--   REQUIRED: public.quotes
--
-- NOT IN THIS MIGRATION:
--   * broad automatic backfill of historical notes into scope_of_work
--   * alters to invoices, ledger, payment intents, signing, envelopes
-- =============================================================================

alter table public.quotes
  add column if not exists scope_of_work text null;

comment on column public.quotes.scope_of_work is
  'CH-012E.1 — Canonical contractual Scope of Work approved for the customer. Exact editor text only. Never store outbound estimate email, terms, operational plan, or generated demo Day N placeholders here. Email/send copy remains in quotes.notes.';

-- No automatic backfill. Legacy notes may be accepted at read-time only under the
-- documented compatibility rule in netlify/functions/_lib/contract-scope.js;
-- copying into this column requires explicit Owner review/save.
