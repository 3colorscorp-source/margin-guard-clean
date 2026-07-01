-- =============================================================================
-- AI Closer Step 8B — Idempotency / audit guard for prequote → official DRAFT quote
-- =============================================================================
--
-- STATUS: DRAFT ONLY — DO NOT RUN until owner + Supabase review.
--
-- Purpose:
--   Future-safe conversion log so one public.ai_closer_prequotes row cannot
--   create duplicate official draft quotes.
--
-- Safety:
--   * This SQL is draft only; do not run until reviewed.
--   * This table is only an idempotency/audit guard.
--   * It must NOT create official quotes by itself.
--   * It must NOT send, publish, invoice, or create payments.
--   * It must NOT store internal margin/cost/overhead/labor-rate details.
--   * No invoice_id, payment_id, deposit_id, or public_token columns.
--
-- Prerequisites:
--   * public.tenants exists
--   * public.ai_closer_prequotes exists (docs/AI_CLOSER_STEP2_SUPABASE_STORAGE.sql)
--   * public.quotes exists (official quote table)
--   * public.set_updated_at() trigger function (SUPABASE_MARGIN_GUARD_MULTITENANT.sql)
--
-- Related docs:
--   * docs/AI_CLOSER_STEP8A_DRAFT_QUOTE_CONVERSION_CONTRACT.md
--   * docs/AI_CLOSER_STEP7_QUOTE_MAPPING_AUDIT.md
--
-- Netlify note:
--   Existing AI Closer functions use service_role via supabase-admin (same as Step 2).
--   Owner/admin auth is enforced in Netlify, not via Supabase JWT policies today.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Table: public.ai_closer_quote_conversions
-- ---------------------------------------------------------------------------
create table if not exists public.ai_closer_quote_conversions (
  id uuid primary key default gen_random_uuid(),

  tenant_id uuid not null
    references public.tenants (id) on delete cascade,

  ai_closer_prequote_id uuid not null
    references public.ai_closer_prequotes (id) on delete restrict,

  -- Set after official DRAFT quote insert succeeds; null while draft_pending.
  official_quote_id uuid null
    references public.quotes (id) on delete set null,

  status text not null default 'draft_pending',

  -- profiles.id of owner/admin who initiated conversion (optional audit).
  created_by uuid null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Safe audit metadata only (e.g. final_price_owner_approved, start_date, owner_note).
  -- Must NOT store: margin, overhead, labor_rate, internal_cost, workers JSON, raw_payload.
  conversion_metadata jsonb not null default '{}'::jsonb,

  constraint ai_closer_quote_conversions_status_check
    check (status in ('draft_pending', 'draft_created', 'failed', 'cancelled')),

  constraint ai_closer_quote_conversions_prequote_uidx
    unique (ai_closer_prequote_id)
);

comment on table public.ai_closer_quote_conversions is
  'AI Closer idempotency/audit guard: one prequote → at most one conversion record. Does not create quotes by itself.';

comment on column public.ai_closer_quote_conversions.official_quote_id is
  'Official quotes.id after DRAFT quote insert. Null while draft_pending or if quote deleted (set null).';

comment on column public.ai_closer_quote_conversions.status is
  'draft_pending | draft_created | failed | cancelled — conversion lifecycle only; not quote send status.';

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

create index if not exists ai_closer_quote_conversions_tenant_created_idx
  on public.ai_closer_quote_conversions (tenant_id, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at trigger (reuses public.set_updated_at when present)
-- ---------------------------------------------------------------------------
drop trigger if exists trg_ai_closer_quote_conversions_updated_at
  on public.ai_closer_quote_conversions;

create trigger trg_ai_closer_quote_conversions_updated_at
before update on public.ai_closer_quote_conversions
for each row
execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS — enabled; no public access
-- ---------------------------------------------------------------------------
alter table public.ai_closer_quote_conversions enable row level security;

-- Primary production path (matches docs/AI_CLOSER_STEP2_SUPABASE_STORAGE.sql):
-- Netlify functions use service_role; owner/admin gate lives in function code.
drop policy if exists "service role full access ai_closer_quote_conversions"
  on public.ai_closer_quote_conversions;

create policy "service role full access ai_closer_quote_conversions"
on public.ai_closer_quote_conversions
for all
to service_role
using (true)
with check (true);

-- ---------------------------------------------------------------------------
-- TODO: Owner/admin authenticated policies (DO NOT ENABLE without Supabase review)
-- ---------------------------------------------------------------------------
-- The repo does NOT currently define a verified JWT/RLS helper for owner/admin
-- tenant scoping on AI Closer tables. All AI Closer Netlify handlers resolve
-- tenant via profiles.auth_user_id + session (see ai-closer-list-prequotes.js).
--
-- Before adding policies below:
--   1. Confirm Supabase Auth is wired to profiles.auth_user_id in production.
--   2. Confirm whether authenticated role should be `authenticated` or custom.
--   3. Add a reviewed helper, e.g. public.is_active_owner_or_admin_for_tenant(uuid).
--   4. Reject seller/supervisor roles unless explicitly approved.
--
-- Example pattern (COMMENTED OUT — not safe to run as-is):
--
-- create or replace function public.is_active_owner_or_admin_for_tenant(p_tenant_id uuid)
-- returns boolean
-- language sql
-- stable
-- security definer
-- set search_path = public
-- as $$
--   select exists (
--     select 1
--     from public.profiles p
--     where p.auth_user_id = auth.uid()
--       and p.tenant_id = p_tenant_id
--       and p.status = 'active'
--       and lower(p.role) in ('owner', 'admin')
--   );
-- $$;
--
-- drop policy if exists "owner admin select ai_closer_quote_conversions"
--   on public.ai_closer_quote_conversions;
-- create policy "owner admin select ai_closer_quote_conversions"
-- on public.ai_closer_quote_conversions
-- for select
-- to authenticated
-- using (public.is_active_owner_or_admin_for_tenant(tenant_id));
--
-- drop policy if exists "owner admin insert ai_closer_quote_conversions"
--   on public.ai_closer_quote_conversions;
-- create policy "owner admin insert ai_closer_quote_conversions"
-- on public.ai_closer_quote_conversions
-- for insert
-- to authenticated
-- with check (public.is_active_owner_or_admin_for_tenant(tenant_id));
--
-- drop policy if exists "owner admin update ai_closer_quote_conversions"
--   on public.ai_closer_quote_conversions;
-- create policy "owner admin update ai_closer_quote_conversions"
-- on public.ai_closer_quote_conversions
-- for update
-- to authenticated
-- using (public.is_active_owner_or_admin_for_tenant(tenant_id))
-- with check (public.is_active_owner_or_admin_for_tenant(tenant_id));
--
-- No DELETE policy for authenticated users (audit retention).
-- No anon/public policies.

-- ---------------------------------------------------------------------------
-- Recommended conversion flow (application layer — not enforced by this table alone)
-- ---------------------------------------------------------------------------
-- 1. INSERT conversion row status=draft_pending (unique prequote_id prevents race duplicate).
-- 2. INSERT official quotes row status=draft (separate Step 8C function).
-- 3. UPDATE conversion SET official_quote_id=?, status=draft_created.
-- On failure: UPDATE status=failed; do NOT create invoice/payment/send.
-- Idempotent retry: if row exists with draft_created, return existing official_quote_id.

-- ---------------------------------------------------------------------------
-- SELECT-only verification queries (run manually after owner-approved apply)
-- ---------------------------------------------------------------------------
--
-- -- Confirm table exists
-- select table_name
-- from information_schema.tables
-- where table_schema = 'public'
--   and table_name = 'ai_closer_quote_conversions';
--
-- -- Confirm RLS enabled
-- select relname, relrowsecurity
-- from pg_class
-- where oid = 'public.ai_closer_quote_conversions'::regclass;
--
-- -- Confirm policies exist
-- select polname, polcmd, polroles::regrole[]
-- from pg_policy
-- where polrelid = 'public.ai_closer_quote_conversions'::regclass
-- order by polname;
--
-- -- Confirm unique constraint on ai_closer_prequote_id
-- select conname, pg_get_constraintdef(oid) as definition
-- from pg_constraint
-- where conrelid = 'public.ai_closer_quote_conversions'::regclass
--   and contype = 'u';
--
-- -- Confirm status check constraint
-- select conname, pg_get_constraintdef(oid) as definition
-- from pg_constraint
-- where conrelid = 'public.ai_closer_quote_conversions'::regclass
--   and contype = 'c';
--
-- -- Confirm no duplicate ai_closer_prequote_id values (should return 0 rows)
-- select ai_closer_prequote_id, count(*) as cnt
-- from public.ai_closer_quote_conversions
-- group by ai_closer_prequote_id
-- having count(*) > 1;
--
-- -- Sample tenant-scoped audit read (replace tenant uuid)
-- select id, tenant_id, ai_closer_prequote_id, official_quote_id, status, created_at
-- from public.ai_closer_quote_conversions
-- where tenant_id = '<tenant-uuid>'
-- order by created_at desc
-- limit 25;
