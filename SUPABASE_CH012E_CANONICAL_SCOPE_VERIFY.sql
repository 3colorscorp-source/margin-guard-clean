-- =============================================================================
-- Margin Guard | CH-012E.1 — Canonical Scope VERIFY (read-only checks)
-- =============================================================================
-- Run after SUPABASE_CH012E_CANONICAL_SCOPE.sql
-- Does not mutate data.
-- =============================================================================

do $$
declare
  col_exists boolean;
  col_udt text;
  col_nullable text;
  col_comment text;
begin
  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'quotes'
      and column_name = 'scope_of_work'
  ) into col_exists;

  if not col_exists then
    raise exception 'VERIFY FAIL: public.quotes.scope_of_work column missing';
  end if;

  select udt_name, is_nullable
    into col_udt, col_nullable
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'quotes'
    and column_name = 'scope_of_work';

  if col_udt is distinct from 'text' then
    raise exception 'VERIFY FAIL: scope_of_work type expected text, got %', col_udt;
  end if;

  if col_nullable is distinct from 'YES' then
    raise exception 'VERIFY FAIL: scope_of_work must be nullable';
  end if;

  select pg_catalog.col_description(
    (quote_ident('public') || '.' || quote_ident('quotes'))::regclass,
    a.attnum
  )
  into col_comment
  from pg_catalog.pg_attribute a
  where a.attrelid = 'public.quotes'::regclass
    and a.attname = 'scope_of_work'
    and not a.attisdropped;

  if col_comment is null or position('CH-012E.1' in col_comment) = 0 then
    raise exception 'VERIFY FAIL: scope_of_work column comment missing or incomplete';
  end if;

  raise notice 'VERIFY PASS: public.quotes.scope_of_work exists (text, nullable) with CH-012E.1 comment';
  raise notice 'VERIFY NOTE: blank Scope allowed at DB; contract freeze must block in application layer';
  raise notice 'VERIFY NOTE: no broad backfill — notes and scope_of_work coexist independently';
end $$;

-- Independence smoke (read-only shape): both columns present on quotes.
select
  'quotes.notes' as field,
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'quotes' and column_name = 'notes'
  ) as present
union all
select
  'quotes.scope_of_work',
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'quotes' and column_name = 'scope_of_work'
  );
