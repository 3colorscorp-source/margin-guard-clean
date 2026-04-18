-- =============================================================================
-- A) OPTIONAL PRE-FLIGHT BACKUP (run first; outside the transaction below is fine)
-- =============================================================================
-- CREATE TABLE public.tenant_financial_summary_migration_backup AS
-- TABLE public.tenant_financial_summary;
-- -- or: pg_dump -t public.tenant_financial_summary ...
--
-- =============================================================================
-- B) ALTER-FIRST MIGRATION (preferred when id stays uuid PK and FKs unchanged)
-- =============================================================================
-- tenant_financial_summary — PRO snapshot model alignment (safe ALTER-first path)
-- Target shape (matches sync-tenant-financial-summary.js + STEP 1 + STEP 3):
--   period_start, period_end, currency, total_inflow, total_outflow, net_change,
--   source, computed_at, created_at, updated_at,
--   operating_balance, savings_balance, profit_balance, tax_reserve_balance, cash_on_hand
-- Unique: (tenant_id, period_start, period_end, currency)
-- =============================================================================
-- Run in a transaction after backup. Review constraints on your live DB first.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Add any missing PRO columns (idempotent)
-- ---------------------------------------------------------------------------
ALTER TABLE public.tenant_financial_summary
  ADD COLUMN IF NOT EXISTS period_start date,
  ADD COLUMN IF NOT EXISTS period_end date,
  ADD COLUMN IF NOT EXISTS currency text,
  ADD COLUMN IF NOT EXISTS total_inflow numeric(18, 2),
  ADD COLUMN IF NOT EXISTS total_outflow numeric(18, 2),
  ADD COLUMN IF NOT EXISTS net_change numeric(18, 2),
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS computed_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS operating_balance numeric(18, 2),
  ADD COLUMN IF NOT EXISTS savings_balance numeric(18, 2),
  ADD COLUMN IF NOT EXISTS profit_balance numeric(18, 2),
  ADD COLUMN IF NOT EXISTS tax_reserve_balance numeric(18, 2),
  ADD COLUMN IF NOT EXISTS cash_on_hand numeric(18, 2);

-- ---------------------------------------------------------------------------
-- 2) Backfill from simplified one-row-per-tenant rows (UTC “today” as snapshot day)
--    Evaluates using prior column values per row (PostgreSQL UPDATE semantics).
-- ---------------------------------------------------------------------------
UPDATE public.tenant_financial_summary
SET
  period_start = COALESCE(period_start, (timezone('UTC', now()))::date),
  period_end = COALESCE(period_end, (timezone('UTC', now()))::date),
  currency = COALESCE(NULLIF(trim(currency), ''), 'USD'),
  total_inflow = COALESCE(total_inflow, 0),
  total_outflow = COALESCE(total_outflow, 0),
  net_change = COALESCE(net_change, 0),
  source = CASE
    WHEN source IN ('aggregate', 'manual', 'stripe') THEN source
    ELSE 'stripe'
  END,
  computed_at = COALESCE(computed_at, now()),
  created_at = COALESCE(created_at, now()),
  updated_at = COALESCE(updated_at, now()),
  operating_balance = COALESCE(operating_balance, 0),
  savings_balance = COALESCE(savings_balance, 0),
  profit_balance = COALESCE(profit_balance, 0),
  tax_reserve_balance = COALESCE(tax_reserve_balance, 0),
  cash_on_hand = COALESCE(
    cash_on_hand,
    COALESCE(operating_balance, 0) + COALESCE(savings_balance, 0)
      + COALESCE(profit_balance, 0) + COALESCE(tax_reserve_balance, 0)
  );

-- ---------------------------------------------------------------------------
-- 3) Enforce NOT NULL + defaults (align with PRO DDL)
-- ---------------------------------------------------------------------------
ALTER TABLE public.tenant_financial_summary
  ALTER COLUMN period_start SET NOT NULL,
  ALTER COLUMN period_end SET NOT NULL,
  ALTER COLUMN currency SET NOT NULL,
  ALTER COLUMN currency SET DEFAULT 'USD',
  ALTER COLUMN total_inflow SET NOT NULL,
  ALTER COLUMN total_inflow SET DEFAULT 0,
  ALTER COLUMN total_outflow SET NOT NULL,
  ALTER COLUMN total_outflow SET DEFAULT 0,
  ALTER COLUMN net_change SET NOT NULL,
  ALTER COLUMN net_change SET DEFAULT 0,
  ALTER COLUMN source SET NOT NULL,
  ALTER COLUMN source SET DEFAULT 'aggregate',
  ALTER COLUMN computed_at SET NOT NULL,
  ALTER COLUMN computed_at SET DEFAULT now(),
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN operating_balance SET NOT NULL,
  ALTER COLUMN operating_balance SET DEFAULT 0,
  ALTER COLUMN savings_balance SET NOT NULL,
  ALTER COLUMN savings_balance SET DEFAULT 0,
  ALTER COLUMN profit_balance SET NOT NULL,
  ALTER COLUMN profit_balance SET DEFAULT 0,
  ALTER COLUMN tax_reserve_balance SET NOT NULL,
  ALTER COLUMN tax_reserve_balance SET DEFAULT 0,
  ALTER COLUMN cash_on_hand SET NOT NULL,
  ALTER COLUMN cash_on_hand SET DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 4) Source + period checks (idempotent)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenant_financial_summary_source_chk'
      AND conrelid = 'public.tenant_financial_summary'::regclass
  ) THEN
    ALTER TABLE public.tenant_financial_summary
      ADD CONSTRAINT tenant_financial_summary_source_chk
      CHECK (source IN ('aggregate', 'manual', 'stripe'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenant_financial_summary_period_chk'
      AND conrelid = 'public.tenant_financial_summary'::regclass
  ) THEN
    ALTER TABLE public.tenant_financial_summary
      ADD CONSTRAINT tenant_financial_summary_period_chk
      CHECK (period_end >= period_start);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5) Drop simplified “one row per tenant” uniqueness (blocks PRO snapshots)
--    Adjust names if \d shows different constraint names.
-- ---------------------------------------------------------------------------
ALTER TABLE public.tenant_financial_summary
  DROP CONSTRAINT IF EXISTS tenant_financial_summary_tenant_id_key;

ALTER TABLE public.tenant_financial_summary
  DROP CONSTRAINT IF EXISTS tenant_financial_summary_tenant_id_unique;

-- If another single-column UNIQUE on tenant_id remains, drop it by name from pg_catalog.

-- ---------------------------------------------------------------------------
-- 6) PRO composite uniqueness (one snapshot per tenant per day per currency)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenant_financial_summary_tenant_period_key'
      AND conrelid = 'public.tenant_financial_summary'::regclass
  ) THEN
    ALTER TABLE public.tenant_financial_summary
      ADD CONSTRAINT tenant_financial_summary_tenant_period_key
      UNIQUE (tenant_id, period_start, period_end, currency);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 7) Helpful indexes (idempotent)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS tenant_financial_summary_tenant_id_idx
  ON public.tenant_financial_summary (tenant_id);

CREATE INDEX IF NOT EXISTS tenant_financial_summary_period_idx
  ON public.tenant_financial_summary (tenant_id, period_start DESC, period_end DESC);

COMMIT;

-- =============================================================================
-- C) RECREATE PATH (use only if ALTER is unsafe — e.g. tenant_id is PRIMARY KEY,
--    wrong column types, or a UNIQUE(tenant_id) cannot be dropped without rebuild)
--    Run backup (section A) first. Inspects: \d public.tenant_financial_summary
-- =============================================================================
--
-- BEGIN;
--
-- CREATE TABLE public.tenant_financial_summary_migration_backup AS
-- TABLE public.tenant_financial_summary;
--
-- DROP TABLE IF EXISTS public.tenant_financial_summary CASCADE;
--
-- CREATE TABLE public.tenant_financial_summary (
--   id uuid primary key default gen_random_uuid(),
--   tenant_id uuid not null references public.tenants (id) on delete cascade,
--   period_start date not null,
--   period_end date not null,
--   currency text not null default 'USD',
--   total_inflow numeric(18, 2) not null default 0,
--   total_outflow numeric(18, 2) not null default 0,
--   net_change numeric(18, 2) not null default 0,
--   source text not null default 'aggregate'
--     check (source in ('aggregate', 'manual', 'stripe')),
--   computed_at timestamptz not null default now(),
--   created_at timestamptz not null default now(),
--   updated_at timestamptz,
--   operating_balance numeric(18, 2) not null default 0,
--   savings_balance numeric(18, 2) not null default 0,
--   profit_balance numeric(18, 2) not null default 0,
--   tax_reserve_balance numeric(18, 2) not null default 0,
--   cash_on_hand numeric(18, 2) not null default 0,
--   constraint tenant_financial_summary_period_chk check (period_end >= period_start),
--   constraint tenant_financial_summary_tenant_period_key unique (tenant_id, period_start, period_end, currency)
-- );
--
-- CREATE INDEX tenant_financial_summary_tenant_id_idx
--   ON public.tenant_financial_summary (tenant_id);
-- CREATE INDEX tenant_financial_summary_period_idx
--   ON public.tenant_financial_summary (tenant_id, period_start desc, period_end desc);
--
-- INSERT INTO public.tenant_financial_summary (
--   id,
--   tenant_id,
--   period_start,
--   period_end,
--   currency,
--   total_inflow,
--   total_outflow,
--   net_change,
--   source,
--   computed_at,
--   created_at,
--   updated_at,
--   operating_balance,
--   savings_balance,
--   profit_balance,
--   tax_reserve_balance,
--   cash_on_hand
-- )
-- SELECT
--   COALESCE(b.id, gen_random_uuid()),
--   b.tenant_id,
--   COALESCE(b.period_start, (timezone('UTC', now()))::date),
--   COALESCE(b.period_end, (timezone('UTC', now()))::date),
--   COALESCE(NULLIF(trim(b.currency::text), ''), 'USD'),
--   COALESCE(b.total_inflow, 0),
--   COALESCE(b.total_outflow, 0),
--   COALESCE(b.net_change, 0),
--   CASE
--     WHEN b.source::text IN ('aggregate', 'manual', 'stripe') THEN b.source::text
--     ELSE 'stripe'
--   END,
--   COALESCE(b.computed_at, now()),
--   COALESCE(b.created_at, now()),
--   b.updated_at,
--   COALESCE(b.operating_balance, 0),
--   COALESCE(b.savings_balance, 0),
--   COALESCE(b.profit_balance, 0),
--   COALESCE(b.tax_reserve_balance, 0),
--   COALESCE(
--     b.cash_on_hand,
--     COALESCE(b.operating_balance, 0) + COALESCE(b.savings_balance, 0)
--       + COALESCE(b.profit_balance, 0) + COALESCE(b.tax_reserve_balance, 0)
--   )
-- FROM public.tenant_financial_summary_migration_backup b;
--
-- ALTER TABLE public.tenant_financial_summary ENABLE ROW LEVEL SECURITY;
-- DROP POLICY IF EXISTS "service role full access tenant_financial_summary" ON public.tenant_financial_summary;
-- CREATE POLICY "service role full access tenant_financial_summary"
-- ON public.tenant_financial_summary FOR ALL TO service_role USING (true) WITH CHECK (true);
--
-- COMMIT;
--
-- Adjust the INSERT SELECT if your backup columns differ (omit missing columns, fix casts).
