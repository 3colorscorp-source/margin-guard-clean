-- =============================================================================
-- Margin Guard | MG-SUPPORT-003C VERIFY (read-only)
-- =============================================================================
-- STATUS: MANUAL. Do not run from CI. Does not insert, update, or delete rows.
-- Run after SUPABASE_MG_SUPPORT_003C_ADMIN.sql.
-- =============================================================================

do $$
declare
  v_ok boolean := false;
  v_nullable text;
  v_type text;
begin
  if to_regclass('public.tenant_support_cases') is null then
    raise exception 'MG-SUPPORT-003C VERIFY FAIL: table public.tenant_support_cases missing';
  end if;

  select data_type, is_nullable
    into v_type, v_nullable
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'tenant_support_cases'
    and column_name = 'resolved_at';

  if v_type is null then
    raise exception 'MG-SUPPORT-003C VERIFY FAIL: resolved_at missing';
  end if;

  if v_type is distinct from 'timestamp with time zone' then
    raise exception 'MG-SUPPORT-003C VERIFY FAIL: resolved_at is not timestamptz';
  end if;

  if v_nullable is distinct from 'YES' then
    raise exception 'MG-SUPPORT-003C VERIFY FAIL: resolved_at must be nullable';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'tenant_support_cases'
      and indexname = 'tenant_support_cases_status_created_idx'
  ) then
    raise exception 'MG-SUPPORT-003C VERIFY FAIL: status created_at index missing';
  end if;

  select relrowsecurity into v_ok
  from pg_class
  where oid = 'public.tenant_support_cases'::regclass;
  if v_ok is not true then
    raise exception 'MG-SUPPORT-003C VERIFY FAIL: RLS not enabled';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'tenant_support_cases'
      and grantee in ('anon', 'authenticated', 'public')
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'SELECT', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
  ) then
    raise exception 'MG-SUPPORT-003C VERIFY FAIL: anon/authenticated/public have table privileges';
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'tenant_support_cases'
      and roles && array['anon', 'authenticated']::name[]
  ) then
    raise exception 'MG-SUPPORT-003C VERIFY FAIL: client-facing RLS policy present';
  end if;

  if not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'tenant_support_cases'
      and grantee = 'service_role'
      and privilege_type in ('SELECT', 'INSERT', 'UPDATE')
  ) then
    raise exception 'MG-SUPPORT-003C VERIFY FAIL: service_role access missing';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'tenant_support_cases'
      and column_name in (
        'priority',
        'severity',
        'assigned_to',
        'assignment',
        'internal_notes',
        'notes',
        'sla',
        'sla_due_at'
      )
  ) then
    raise exception 'MG-SUPPORT-003C VERIFY FAIL: unexpected assignment/priority/notes/SLA column';
  end if;

  raise notice 'MG-SUPPORT-003C VERIFY PASS: resolved_at, index, RLS, grants';
end
$$;
