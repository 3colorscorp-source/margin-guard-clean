-- =============================================================================
-- AI Closer Step 8D — Final idempotency / audit guard SQL (reviewed)
-- =============================================================================
--
-- STATUS: FINAL REVIEWED SQL — DO NOT RUN until owner manually applies in Supabase.
--
-- Based on Step 8C preflight findings:
--   * public.mg_business_id() exists (returns uuid)
--   * public.mg_role() exists (returns text)
--   * Official quote table: public.quotes (tenant_id FK, status default 'DRAFT')
--   * quote_items, quote_labor, labor_tracking_quote depend on quotes.id
--   * quote_labor requires user_id — future conversion must NOT auto-create quote_labor
--   * public.ai_closer_quote_conversions does not exist yet
--   * AI Closer tables use service_role RLS policies (v1 pattern)
--   * RLS enabled on quotes, quote_items, quote_labor, labor_tracking_quote,
--     ai_closer_prequotes, ai_closer_tenant_settings
--
-- Purpose:
--   One ai_closer_prequotes row → at most one conversion audit record.
--   Required before enabling Create Quote in owner UI (Step 8E+).
--
-- Safety (this table alone):
--   * Is only an idempotency/audit guard.
--   * Does NOT create official quotes by itself.
--   * Does NOT send, publish, invoice, or create payments.
--   * Must NOT store internal cost, margin, overhead, or labor-rate details.
--   * No invoice_id, payment_id, deposit_id, or public_token columns.
--
-- Prerequisites:
--   * public.tenants, public.ai_closer_prequotes, public.quotes
--   * public.set_updated_at() (SUPABASE_MARGIN_GUARD_MULTITENANT.sql)
--
-- Related:
--   * docs/AI_CLOSER_STEP8C_SUPABASE_PREFLIGHT_READONLY.sql
--   * docs/AI_CLOSER_STEP8A_DRAFT_QUOTE_CONVERSION_CONTRACT.md
--   * docs/AI_CLOSER_STEP8B_IDEMPOTENCY_GUARD_SQL_DRAFT.sql (superseded by this file)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Table: public.ai_closer_quote_conversions
-- ---------------------------------------------------------------------------
create table if not exists public.ai_closer_quote_conversions (
  id uuid primary key default gen_random_uuid(),

  tenant_id uuid not null
    references public.tenants (id) on delete cascade,

  ai_closer_prequote_id uuid not null
    references public.ai_closer_prequotes (id) on delete cascade,

  -- Set after official DRAFT row insert in public.quotes; null while draft_pending.
  official_quote_id uuid null
    references public.quotes (id) on delete set null,

  status text not null default 'draft_pending',

  -- Optional audit: profiles.id or auth user uuid of owner/admin who initiated conversion.
  created_by uuid null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Owner-safe audit JSON only (e.g. final_price_owner_approved, start_date, owner_note).
  -- Must NOT store: margin, overhead, labor_rate, internal_cost, workers, raw_payload.
  conversion_metadata jsonb not null default '{}'::jsonb,

  constraint ai_closer_quote_conversions_status_check
    check (status in ('draft_pending', 'draft_created', 'failed', 'cancelled')),

  constraint ai_closer_quote_conversions_prequote_uidx
    unique (ai_closer_prequote_id)
);

comment on table public.ai_closer_quote_conversions is
  'AI Closer idempotency/audit guard. One prequote → one conversion record. Does not create quotes, send, publish, invoice, or payments. Required before enabling Create Quote.';

comment on column public.ai_closer_quote_conversions.tenant_id is
  'Must match ai_closer_prequotes.tenant_id; enforced in Netlify conversion handler.';

comment on column public.ai_closer_quote_conversions.official_quote_id is
  'public.quotes.id after DRAFT insert (status DRAFT). Null while pending or if quote row deleted.';

comment on column public.ai_closer_quote_conversions.status is
  'Conversion lifecycle: draft_pending | draft_created | failed | cancelled. Not quotes.status.';

comment on column public.ai_closer_quote_conversions.conversion_metadata is
  'Owner-safe audit JSON only. No internal pricing, margin, overhead, or labor-rate fields.';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
create index if not exists ai_closer_quote_conversions_tenant_id_idx
  on public.ai_closer_quote_conversions (tenant_id);

create index if not exists ai_closer_quote_conversions_prequote_id_idx
  on public.ai_closer_quote_conversions (ai_closer_prequote_id);

create index if not exists ai_closer_quote_conversions_official_quote_id_idx
  on public.ai_closer_quote_conversions (official_quote_id)
  where official_quote_id is not null;

create index if not exists ai_closer_quote_conversions_created_at_idx
  on public.ai_closer_quote_conversions (created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
drop trigger if exists trg_ai_closer_quote_conversions_updated_at
  on public.ai_closer_quote_conversions;

create trigger trg_ai_closer_quote_conversions_updated_at
before update on public.ai_closer_quote_conversions
for each row
execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS — v1: service_role only (matches ai_closer_prequotes / ai_closer_tenant_settings)
-- ---------------------------------------------------------------------------
alter table public.ai_closer_quote_conversions enable row level security;

drop policy if exists "service role full access ai_closer_quote_conversions"
  on public.ai_closer_quote_conversions;

create policy "service role full access ai_closer_quote_conversions"
on public.ai_closer_quote_conversions
for all
to service_role
using (true)
with check (true);

-- Future owner/admin authenticated policies (NOT enabled in v1):
--   Preflight confirmed public.mg_business_id() and public.mg_role() exist.
--   A future migration may add policies such as:
--     tenant_id = public.mg_business_id()
--     and lower(public.mg_role()) in ('owner', 'admin')
--   Review with Supabase before enabling; Netlify service_role path remains primary for AI Closer.

-- ---------------------------------------------------------------------------
-- Application flow (Netlify — not executed by this SQL)
-- ---------------------------------------------------------------------------
-- 1. INSERT conversion status=draft_pending (unique prequote_id prevents duplicate).
-- 2. INSERT public.quotes status='DRAFT' with owner-approved total only (separate function).
--    * Do NOT insert quote_labor (requires user_id per preflight).
--    * Do NOT insert quote_items unless a safe draft path is defined.
--    * Do NOT call allocate_next_quote_number unless owner approves number consumption.
--    * Do NOT mint public_token or call send-quote-zapier.
-- 3. UPDATE conversion SET official_quote_id=?, status=draft_created.
-- On failure: UPDATE status=failed. Idempotent retry returns existing row if draft_created.

-- ---------------------------------------------------------------------------
-- SELECT-only verification (run manually after owner-approved apply)
-- ---------------------------------------------------------------------------
--
-- -- Confirm table exists
-- select table_name
-- from information_schema.tables
-- where table_schema = 'public'
--   and table_name = 'ai_closer_quote_conversions';
--
-- -- Confirm RLS enabled
-- select relname, relrowsecurity, relforcerowsecurity
-- from pg_class
-- where oid = 'public.ai_closer_quote_conversions'::regclass;
--
-- -- Confirm service_role policy exists
-- select policyname, roles, cmd
-- from pg_policies
-- where schemaname = 'public'
--   and tablename = 'ai_closer_quote_conversions'
-- order by policyname;
--
-- -- Confirm unique constraint on ai_closer_prequote_id
-- select conname, pg_get_constraintdef(oid) as definition
-- from pg_constraint
-- where conrelid = 'public.ai_closer_quote_conversions'::regclass
--   and contype = 'u';
--
-- -- Confirm indexes exist
-- select indexname, indexdef
-- from pg_indexes
-- where schemaname = 'public'
--   and tablename = 'ai_closer_quote_conversions'
-- order by indexname;
--
-- -- Confirm zero rows immediately after creation
-- select count(*) as row_count from public.ai_closer_quote_conversions;

-- ---------------------------------------------------------------------------
-- ROLLBACK — MANUAL ONLY (commented; run only if reversing migration)
-- ---------------------------------------------------------------------------
-- WARNING: Drops conversion audit history. Does not delete public.quotes rows.
--
-- drop trigger if exists trg_ai_closer_quote_conversions_updated_at
--   on public.ai_closer_quote_conversions;
-- drop policy if exists "service role full access ai_closer_quote_conversions"
--   on public.ai_closer_quote_conversions;
-- drop table if exists public.ai_closer_quote_conversions;

-- ---------------------------------------------------------------------------
-- Sign-off checklist (manual)
-- ---------------------------------------------------------------------------
-- [ ] Owner reviewed this file in Supabase SQL editor
-- [ ] Step 8C preflight results match expectations
-- [ ] Table created with zero rows
-- [ ] No official quotes created by this script
-- [ ] Create Quote remains disabled in UI until Step 8E+ function + UI ship
