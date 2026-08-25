-- =============================================================================
-- Margin Guard | MG-SUPPORT-003B VERIFY (read-only)
-- =============================================================================
-- STATUS: MANUAL. Do not run from CI. Does not insert, update, or delete rows.
-- Run after SUPABASE_MG_SUPPORT_003B_CASES.sql.
-- =============================================================================

do $$
declare
  v_ok boolean := false;
  v_priv text;
begin
  if to_regclass('public.tenant_support_cases') is null then
    raise exception 'MG-SUPPORT-003B VERIFY FAIL: table public.tenant_support_cases missing';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'tenant_support_cases'
      and column_name = 'id' and data_type = 'uuid'
  ) then
    raise exception 'MG-SUPPORT-003B VERIFY FAIL: id uuid missing';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'tenant_support_cases'
      and column_name in (
        'tenant_id','created_by_user_id','status','category','source','subject',
        'question_excerpt','issue_fingerprint','page_path','support_module',
        'related_entity_type','related_entity_ref','idempotency_key',
        'created_at','updated_at'
      )
    group by table_name
    having count(*) = 15
  ) then
    raise exception 'MG-SUPPORT-003B VERIFY FAIL: required columns missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenant_support_cases'::regclass
      and contype = 'u'
      and conname = 'tenant_support_cases_tenant_idempotency_key'
  ) then
    raise exception 'MG-SUPPORT-003B VERIFY FAIL: unique (tenant_id, idempotency_key) missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenant_support_cases'::regclass
      and contype = 'f'
      and pg_get_constraintdef(oid) ilike '%tenants%'
      and pg_get_constraintdef(oid) ilike '%on delete cascade%'
  ) then
    raise exception 'MG-SUPPORT-003B VERIFY FAIL: tenants FK ON DELETE CASCADE missing';
  end if;

  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenant_support_cases'::regclass
      and contype = 'f'
      and pg_get_constraintdef(oid) not ilike '%references public.tenants%'
      and pg_get_constraintdef(oid) not ilike '%references tenants%'
  ) then
    raise exception 'MG-SUPPORT-003B VERIFY FAIL: unexpected foreign key';
  end if;

  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenant_support_cases'::regclass
      and contype = 'u'
      and (
        pg_get_constraintdef(oid) ilike '%unique (tenant_id, id)%'
        or pg_get_constraintdef(oid) ilike '%unique (tenant_id,id)%'
      )
  ) then
    raise exception 'MG-SUPPORT-003B VERIFY FAIL: redundant UNIQUE(tenant_id, id) present';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenant_support_cases'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%open%resolved%'
  ) then
    raise exception 'MG-SUPPORT-003B VERIFY FAIL: status CHECK missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenant_support_cases'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%diagnostic_unavailable%'
  ) then
    raise exception 'MG-SUPPORT-003B VERIFY FAIL: category CHECK missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenant_support_cases'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%invoice_hub%'
  ) then
    raise exception 'MG-SUPPORT-003B VERIFY FAIL: support_module CHECK missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenant_support_cases'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%related_entity_type%'
      and pg_get_constraintdef(oid) ilike '%contract%'
  ) then
    raise exception 'MG-SUPPORT-003B VERIFY FAIL: related_entity_type CHECK missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenant_support_cases'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%[a-f0-9]{64}%'
  ) then
    raise exception 'MG-SUPPORT-003B VERIFY FAIL: issue_fingerprint shape CHECK missing';
  end if;

  select relrowsecurity into v_ok
  from pg_class
  where oid = 'public.tenant_support_cases'::regclass;
  if v_ok is not true then
    raise exception 'MG-SUPPORT-003B VERIFY FAIL: RLS not enabled';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'tenant_support_cases'
      and grantee in ('anon', 'authenticated', 'public')
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'SELECT', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
  ) then
    raise exception 'MG-SUPPORT-003B VERIFY FAIL: anon/authenticated/public have table privileges';
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'tenant_support_cases'
      and roles && array['anon', 'authenticated']::name[]
  ) then
    raise exception 'MG-SUPPORT-003B VERIFY FAIL: client-facing RLS policy present';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'tenant_support_cases'
      and indexname = 'tenant_support_cases_tenant_created_idx'
  ) then
    raise exception 'MG-SUPPORT-003B VERIFY FAIL: tenant created_at index missing';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'tenant_support_cases'
      and indexname = 'tenant_support_cases_tenant_status_created_idx'
  ) then
    raise exception 'MG-SUPPORT-003B VERIFY FAIL: tenant status created_at index missing';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'tenant_support_cases'
      and indexname = 'tenant_support_cases_tenant_entity_idx'
  ) then
    raise exception 'MG-SUPPORT-003B VERIFY FAIL: entity index missing';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'tenant_support_cases'
      and indexname = 'tenant_support_cases_duplicate_lookup_idx'
  ) then
    raise exception 'MG-SUPPORT-003B VERIFY FAIL: duplicate lookup index missing';
  end if;

  raise notice 'MG-SUPPORT-003B VERIFY PASS: table, constraints, RLS, grants, indexes';
end
$$;
