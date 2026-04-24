-- =============================================================================
-- Margin Guard | Invoice Hub — Phase 1: Multi-tenant database foundation
-- =============================================================================
-- PREREQUISITE: Run SUPABASE_INVOICES_SCHEMA.sql first so public.invoices exists.
-- Optional prior steps: SUPABASE_INVOICES_TENANT_ID.sql, SUPABASE_INVOICES_QUOTE_ID.sql,
--   SUPABASE_INVOICES_RLS_FIX.sql (this file is idempotent and subsumes their intent.)
--
-- This migration ONLY touches public.invoices (and policies on it).
-- It does NOT modify quotes, sales, owner, Zapier, Stripe deposit functions, or app code.
--
-- tenant_id NOT NULL: intentionally NOT enforced here. Existing rows may have NULL
-- tenant_id until a backfill job assigns tenants. After backfill, run a follow-up
-- migration: ALTER TABLE public.invoices ALTER COLUMN tenant_id SET NOT NULL;
-- =============================================================================

DO $prereq$
BEGIN
  IF to_regclass('public.invoices') IS NULL THEN
    RAISE EXCEPTION 'public.invoices is missing. Apply SUPABASE_INVOICES_SCHEMA.sql before SUPABASE_INVOICES_MULTITENANT_HARDENING.sql.';
  END IF;
END
$prereq$;

-- -----------------------------------------------------------------------------
-- Columns: tenant scope, quote link, lifecycle & payments (idempotent)
-- -----------------------------------------------------------------------------
alter table public.invoices
  add column if not exists tenant_id uuid;

comment on column public.invoices.tenant_id is
  'Tenant scope for SaaS isolation. Nullable until legacy rows are backfilled; plan NOT NULL after backfill.';

alter table public.invoices
  add column if not exists quote_id uuid;

alter table public.invoices
  add column if not exists sent_at timestamptz;

alter table public.invoices
  add column if not exists paid_at timestamptz;

alter table public.invoices
  add column if not exists voided_at timestamptz;

alter table public.invoices
  add column if not exists pdf_storage_path text;

alter table public.invoices
  add column if not exists payment_status text;

alter table public.invoices
  add column if not exists stripe_checkout_session_id text;

alter table public.invoices
  add column if not exists stripe_payment_intent_id text;

alter table public.invoices
  add column if not exists last_reminder_at timestamptz;

comment on column public.invoices.payment_status is
  'Optional normalized payment lifecycle (e.g. unpaid, partial, paid) distinct from status if needed.';

-- -----------------------------------------------------------------------------
-- Foreign keys (add only if constraint missing; safe on re-run)
-- -----------------------------------------------------------------------------
do $fk$
begin
  if to_regclass('public.tenants') is null then
    raise notice 'public.tenants missing — skip invoices.tenant_id FK until tenants table exists.';
  else
    if not exists (
      select 1
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'public'
        and t.relname = 'invoices'
        and c.conname = 'invoices_tenant_id_fkey'
    ) then
      alter table public.invoices
        add constraint invoices_tenant_id_fkey
        foreign key (tenant_id) references public.tenants (id) on delete set null;
    end if;
  end if;

  if to_regclass('public.quotes') is not null then
    if not exists (
      select 1
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'public'
        and t.relname = 'invoices'
        and c.conname = 'invoices_quote_id_fkey'
    ) then
      alter table public.invoices
        add constraint invoices_quote_id_fkey
        foreign key (quote_id) references public.quotes (id) on delete set null;
    end if;
  else
    raise notice 'public.quotes missing — skip invoices.quote_id FK until quotes table exists.';
  end if;
end
$fk$;

-- -----------------------------------------------------------------------------
-- Indexes: tenant scoping & lookups (idempotent)
-- -----------------------------------------------------------------------------
create index if not exists invoices_tenant_id_idx on public.invoices (tenant_id);

create index if not exists invoices_tenant_created_at_idx
  on public.invoices (tenant_id, created_at desc);

create index if not exists invoices_tenant_status_idx
  on public.invoices (tenant_id, status);

create index if not exists invoices_quote_id_idx on public.invoices (quote_id);

-- public_token: uniqueness is already required by SUPABASE_INVOICES_SCHEMA.sql (UNIQUE on column).
-- Do not add a second unique index on the same column; only document enforcement here.

-- -----------------------------------------------------------------------------
-- Row Level Security: service_role only (no client JWT policies)
-- -----------------------------------------------------------------------------
alter table public.invoices enable row level security;

-- Remove legacy / broad policies (names known from repo; harmless if absent)
drop policy if exists "public read invoice by token" on public.invoices;
drop policy if exists "authenticated read invoices" on public.invoices;
drop policy if exists "anon read invoices" on public.invoices;
drop policy if exists "authenticated full access invoices" on public.invoices;
drop policy if exists "anon full access invoices" on public.invoices;

drop policy if exists "service role full access invoices" on public.invoices;
create policy "service role full access invoices"
on public.invoices
for all
to service_role
using (true)
with check (true);

-- =============================================================================
-- POST-MIGRATION NOTES
-- =============================================================================
-- tenant_id NOT NULL: run backfill, then:
--   ALTER TABLE public.invoices ALTER COLUMN tenant_id SET NOT NULL;
--
-- Optional: partial unique invoice numbers per tenant after backfill:
--   CREATE UNIQUE INDEX IF NOT EXISTS invoices_tenant_invoice_no_uidx
--     ON public.invoices (tenant_id, invoice_no) WHERE tenant_id IS NOT NULL;
-- =============================================================================
-- VERIFICATION QUERIES (run manually in SQL editor; kept as comments)
-- =============================================================================
--
-- 1) Invoices still missing tenant (should go to 0 before NOT NULL):
--   SELECT id, invoice_no, public_token, created_at
--   FROM public.invoices
--   WHERE tenant_id IS NULL
--   ORDER BY created_at DESC;
--
-- 2) Duplicate invoice_no within same tenant (should be 0 rows if you add unique per tenant later):
--   SELECT tenant_id, invoice_no, COUNT(*) AS n
--   FROM public.invoices
--   WHERE tenant_id IS NOT NULL AND invoice_no IS NOT NULL AND btrim(invoice_no) <> ''
--   GROUP BY tenant_id, invoice_no
--   HAVING COUNT(*) > 1;
--
-- 3) RLS enabled and policies on public.invoices:
--   SELECT c.relname, c.relrowsecurity AS rls_enabled
--   FROM pg_class c
--   JOIN pg_namespace n ON n.oid = c.relnamespace
--   WHERE n.nspname = 'public' AND c.relname = 'invoices';
--
--   SELECT polname, polcmd, polroles::regrole[], qual::text, with_check::text
--   FROM pg_policy p
--   JOIN pg_class c ON c.oid = p.polrelid
--   JOIN pg_namespace n ON n.oid = c.relnamespace
--   WHERE n.nspname = 'public' AND c.relname = 'invoices'
--   ORDER BY polname;
--
-- 4) Indexes on public.invoices:
--   SELECT indexname, indexdef
--   FROM pg_indexes
--   WHERE schemaname = 'public' AND tablename = 'invoices'
--   ORDER BY indexname;
--
-- =============================================================================
