-- =============================================================================
-- READ ONLY — Supabase preflight
-- =============================================================================
-- Do not run if any non-SELECT statement is added to this file.
-- Purpose: inspect existing helpers/schema before AI Closer draft conversion.
--
-- AI Closer Step 8C — documentation only. Do not apply schema changes from here.
-- Run each query manually in Supabase SQL editor after owner approval.
-- Replace <tenant-uuid> placeholders where noted.
--
-- What to look for:
--   * Tenant/auth helpers for owner/admin RLS (if any exist beyond service_role)
--   * Whether service_role-only Netlify access is the established AI Closer pattern
--   * Whether public.quotes supports draft-only rows (nullable total, token, number)
--   * Whether allocate_next_quote_number RPC has sequence side effects
--   * Whether public_token / publish / send are separate from draft insert
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Existing helper functions (tenant / business / auth / role / profile)
-- -----------------------------------------------------------------------------

-- Functions named mg_business_id or mg_role (if present)
select
  n.nspname as schema_name,
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as arguments,
  pg_get_function_result(p.oid) as result_type
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('mg_business_id', 'mg_role')
order by p.proname;

-- Broader scan: public functions related to tenant, business, role, profile, membership
select
  n.nspname as schema_name,
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as arguments
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and (
    p.proname ilike '%tenant%'
    or p.proname ilike '%business%'
    or p.proname ilike '%role%'
    or p.proname ilike '%profile%'
    or p.proname ilike '%membership%'
    or p.proname ilike '%auth%'
  )
order by p.proname, arguments;

-- -----------------------------------------------------------------------------
-- B) Profiles / membership / tenants structure (metadata only)
-- -----------------------------------------------------------------------------

select
  column_name,
  data_type,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'profiles'
order by ordinal_position;

select
  column_name,
  data_type,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'tenants'
order by ordinal_position;

-- Basic counts only (no row dumps)
select count(*) as profiles_count from public.profiles;
select count(*) as tenants_count from public.tenants;

select role, status, count(*) as cnt
from public.profiles
group by role, status
order by role, status;

-- -----------------------------------------------------------------------------
-- C) Official quote-related tables (information_schema)
-- -----------------------------------------------------------------------------

-- Likely core tables
select
  table_name
from information_schema.tables
where table_schema = 'public'
  and table_type = 'BASE TABLE'
  and table_name in (
    'quotes',
    'tenant_quotes',
    'estimates',
    'tenant_projects',
    'tenant_contacts',
    'invoices',
    'ai_closer_prequotes',
    'ai_closer_tenant_settings',
    'ai_closer_quote_conversions'
  )
order by table_name;

-- Any public table name containing quote, estimate, project, or contact
select
  table_name
from information_schema.tables
where table_schema = 'public'
  and table_type = 'BASE TABLE'
  and (
    table_name ilike '%quote%'
    or table_name ilike '%estimate%'
    or table_name ilike '%project%'
    or table_name ilike '%contact%'
  )
order by table_name;

-- Columns for public.quotes (primary official quote table in this repo)
select
  column_name,
  data_type,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'quotes'
order by ordinal_position;

-- Columns for tenant_projects (if exists)
select
  column_name,
  data_type,
  is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'tenant_projects'
order by ordinal_position;

-- Columns for tenant_contacts (if exists)
select
  column_name,
  data_type,
  is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'tenant_contacts'
order by ordinal_position;

-- -----------------------------------------------------------------------------
-- D) Quote-related functions / RPCs (names and arguments only — do not call RPCs)
-- -----------------------------------------------------------------------------

select
  n.nspname as schema_name,
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as arguments,
  pg_get_function_result(p.oid) as result_type
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and (
    p.proname ilike '%quote%'
    or p.proname ilike '%invoice%'
    or p.proname ilike '%publish%'
    or p.proname ilike '%deposit%'
    or p.proname ilike '%balance%'
    or p.proname ilike '%allocate%'
    or p.proname ilike '%token%'
  )
order by p.proname, arguments;

-- Explicit check for quote numbering RPC referenced in publish-public-quote.js
select
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as arguments
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'allocate_next_quote_number';

-- -----------------------------------------------------------------------------
-- E) RLS enabled flags and policies
-- -----------------------------------------------------------------------------

-- RLS enabled on key tables
select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relname in (
    'ai_closer_prequotes',
    'ai_closer_tenant_settings',
    'ai_closer_quote_conversions',
    'quotes',
    'profiles',
    'tenants',
    'invoices',
    'tenant_projects',
    'tenant_contacts'
  )
order by c.relname;

-- Policies on AI Closer tables
select
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('ai_closer_prequotes', 'ai_closer_tenant_settings', 'ai_closer_quote_conversions')
order by tablename, policyname;

-- Policies on quotes and quote-like tables
select
  schemaname,
  tablename,
  policyname,
  roles,
  cmd
from pg_policies
where schemaname = 'public'
  and (
    tablename = 'quotes'
    or tablename ilike '%quote%'
    or tablename ilike '%estimate%'
  )
order by tablename, policyname;

-- Policies on profiles / tenants
select
  schemaname,
  tablename,
  policyname,
  roles,
  cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('profiles', 'tenants')
order by tablename, policyname;

-- -----------------------------------------------------------------------------
-- F) Constraints and indexes (quote-like + AI Closer)
-- -----------------------------------------------------------------------------

-- Unique / check / FK constraints on public.quotes
select
  con.conname as constraint_name,
  con.contype as constraint_type,
  pg_get_constraintdef(con.oid) as definition
from pg_constraint con
join pg_class rel on rel.oid = con.conrelid
join pg_namespace nsp on nsp.oid = rel.relnamespace
where nsp.nspname = 'public'
  and rel.relname = 'quotes'
order by con.contype, con.conname;

-- Indexes on public.quotes (quote number, public token, tenant)
select
  indexname,
  indexdef
from pg_indexes
where schemaname = 'public'
  and tablename = 'quotes'
order by indexname;

-- Constraints on ai_closer_prequotes
select
  con.conname as constraint_name,
  con.contype as constraint_type,
  pg_get_constraintdef(con.oid) as definition
from pg_constraint con
join pg_class rel on rel.oid = con.conrelid
join pg_namespace nsp on nsp.oid = rel.relnamespace
where nsp.nspname = 'public'
  and rel.relname = 'ai_closer_prequotes'
order by con.contype, con.conname;

-- -----------------------------------------------------------------------------
-- G) AI Closer table columns
-- -----------------------------------------------------------------------------

select
  column_name,
  data_type,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'ai_closer_prequotes'
order by ordinal_position;

select
  column_name,
  data_type,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'ai_closer_tenant_settings'
order by ordinal_position;

-- -----------------------------------------------------------------------------
-- H) Safety checks for future conversion design
-- -----------------------------------------------------------------------------

-- H1) Confirm whether ai_closer_quote_conversions already exists (expect 0 rows before Step 8B apply)
select
  table_name
from information_schema.tables
where table_schema = 'public'
  and table_name = 'ai_closer_quote_conversions';

-- H2) Look for quotes columns that could store ai_closer_prequote_id or conversion metadata
select
  column_name,
  data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'quotes'
  and (
    column_name ilike '%prequote%'
    or column_name ilike '%ai_closer%'
    or column_name ilike '%metadata%'
    or column_name ilike '%source%'
    or column_name ilike '%json%'
    or column_name ilike '%external%'
    or column_name ilike '%conversion%'
  )
order by column_name;

-- H3) Draft feasibility: nullable commercial / public-link columns on quotes
select
  column_name,
  is_nullable,
  data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'quotes'
  and column_name in (
    'status',
    'total',
    'deposit_required',
    'public_token',
    'quote_number_display',
    'quote_year',
    'quote_sequence',
    'payment_link',
    'currency'
  )
order by column_name;

-- H4) Sample distinct quote statuses (counts only — assess draft support)
select status, count(*) as cnt
from public.quotes
group by status
order by cnt desc;

-- H5) Whether quotes already link to contacts (optional future mapping)
select
  column_name,
  is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'quotes'
  and column_name = 'contact_id';

-- H6) AI Closer prequote counts by status (tenant-scoped; replace uuid)
select status, count(*) as cnt
from public.ai_closer_prequotes
where tenant_id = '<tenant-uuid>'
group by status
order by status;

-- -----------------------------------------------------------------------------
-- Interpretation guide (read results manually)
-- -----------------------------------------------------------------------------
-- Tenant/auth helpers:
--   * If no mg_* helpers exist, AI Closer likely continues service_role in Netlify
--     with owner/admin checks in function code (see ai-closer-list-prequotes.js).
--   * Do not enable JWT RLS policies until a reviewed helper exists.
--
-- service_role-only access:
--   * AI Closer Step 2 uses service_role policies only — safest match for conversion.
--
-- Draft-only official quote:
--   * Check H3: if total/deposit_required/public_token are NOT NULL without defaults,
--     draft insert may need explicit placeholders or schema change.
--   * quote-edit-guard.js lists editable status including 'draft'.
--
-- Quote number allocation:
--   * allocate_next_quote_number increments tenant sequence — side effect on call.
--   * Prefer deferring RPC until owner promotes draft to send (Step 8A contract).
--
-- public_token / publish:
--   * publish-public-quote.js mints token and sets READY_TO_SEND — separate from draft.
--   * send-quote-zapier.js is email/publish — must not run on conversion.
--
-- Idempotency storage:
--   * If H2 shows no ai_closer_prequote_id on quotes, conversion log table (Step 8B draft)
--     is safer than adding column to quotes without migration review.
--   * If H1 shows conversion table already applied, verify unique on ai_closer_prequote_id.

-- -----------------------------------------------------------------------------
-- Preflight checklist (manual sign-off)
-- -----------------------------------------------------------------------------
-- [ ] This file contains SELECT statements only
-- [ ] No schema mutation planned from preflight results alone
-- [ ] No data mutation performed
-- [ ] No quote creation
-- [ ] No invoice/payment creation
-- [ ] No email/publish action triggered by these queries
