-- =============================================================================
-- Margin Guard | MG-SUPPORT-003D.C1 VERIFY (read-only)
-- =============================================================================
-- STATUS: MANUAL. Do not run from CI. Does not insert, update, or delete rows.
-- Run after SUPABASE_MG_SUPPORT_003C_ACTIONS.sql.
-- =============================================================================

do $$
declare
  v_ok boolean := false;
  v_svc_priv integer := 0;
begin
  if to_regclass('public.tenant_support_actions') is null then
    raise exception 'MG-SUPPORT-003D.C1 VERIFY FAIL: table public.tenant_support_actions missing';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'tenant_support_actions'
      and column_name = 'id' and data_type = 'uuid'
  ) then
    raise exception 'MG-SUPPORT-003D.C1 VERIFY FAIL: id uuid missing';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'tenant_support_actions'
      and column_name in (
        'tenant_id','created_by_user_id','action_type','related_entity_type',
        'related_entity_id','idempotency_key','status','result_code',
        'created_at','claimed_at','completed_at'
      )
    group by table_name
    having count(*) = 11
  ) then
    raise exception 'MG-SUPPORT-003D.C1 VERIFY FAIL: required columns missing';
  end if;

  if exists (
    select 1
    from (
      values
        ('id', 'uuid', 'NO'),
        ('tenant_id', 'uuid', 'NO'),
        ('created_by_user_id', 'uuid', 'YES'),
        ('action_type', 'text', 'NO'),
        ('related_entity_type', 'text', 'NO'),
        ('related_entity_id', 'uuid', 'NO'),
        ('idempotency_key', 'text', 'NO'),
        ('status', 'text', 'NO'),
        ('result_code', 'text', 'YES'),
        ('created_at', 'timestamp with time zone', 'NO'),
        ('claimed_at', 'timestamp with time zone', 'YES'),
        ('completed_at', 'timestamp with time zone', 'YES')
    ) as expected(column_name, data_type, is_nullable)
    left join information_schema.columns c
      on c.table_schema = 'public'
     and c.table_name = 'tenant_support_actions'
     and c.column_name = expected.column_name
    where c.column_name is null
       or c.data_type is distinct from expected.data_type
       or c.is_nullable is distinct from expected.is_nullable
  ) then
    raise exception 'MG-SUPPORT-003D.C1 VERIFY FAIL: column type or nullability mismatch';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'tenant_support_actions'
      and column_name in (
        'customer_email','email','customer_name','amount','balance_due',
        'subject','email_body','public_token','public_url','confirmation_token'
      )
  ) then
    raise exception 'MG-SUPPORT-003D.C1 VERIFY FAIL: forbidden PII/money/token column present';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenant_support_actions'::regclass
      and contype = 'u'
      and conname = 'tenant_support_actions_idempotency_key'
  ) then
    raise exception 'MG-SUPPORT-003D.C1 VERIFY FAIL: unique idempotency_key missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenant_support_actions'::regclass
      and contype = 'f'
      and pg_get_constraintdef(oid) ilike '%tenants%'
      and pg_get_constraintdef(oid) ilike '%on delete cascade%'
  ) then
    raise exception 'MG-SUPPORT-003D.C1 VERIFY FAIL: tenants FK ON DELETE CASCADE missing';
  end if;

  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenant_support_actions'::regclass
      and contype = 'f'
      and pg_get_constraintdef(oid) not ilike '%references public.tenants%'
      and pg_get_constraintdef(oid) not ilike '%references tenants%'
  ) then
    raise exception 'MG-SUPPORT-003D.C1 VERIFY FAIL: unexpected foreign key';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenant_support_actions'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%claimed%'
      and pg_get_constraintdef(oid) ilike '%bridge_accepted%'
      and pg_get_constraintdef(oid) ilike '%submission_unknown%'
  ) then
    raise exception 'MG-SUPPORT-003D.C1 VERIFY FAIL: status CHECK missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenant_support_actions'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%invoice_resend%'
  ) then
    raise exception 'MG-SUPPORT-003D.C1 VERIFY FAIL: action_type CHECK missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenant_support_actions'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%related_entity_type%'
      and pg_get_constraintdef(oid) ilike '%invoice%'
  ) then
    raise exception 'MG-SUPPORT-003D.C1 VERIFY FAIL: related_entity_type CHECK missing';
  end if;

  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'tenant_support_actions'
      and indexname = 'tenant_support_actions_inflight_invoice_uidx'
  ) then
    raise exception 'MG-SUPPORT-003D.C1 VERIFY FAIL: partial inflight invoice unique index missing';
  end if;

  if not exists (
    select 1
    from pg_index idx
    join pg_class t on t.oid = idx.indrelid
    join pg_namespace n on n.oid = t.relnamespace
    join pg_class i on i.oid = idx.indexrelid
    where n.nspname = 'public'
      and t.relname = 'tenant_support_actions'
      and i.relname = 'tenant_support_actions_inflight_invoice_uidx'
      and idx.indisunique
      and idx.indpred is not null
      and pg_get_expr(idx.indpred, idx.indrelid) ilike '%claimed%'
      and pg_get_expr(idx.indpred, idx.indrelid) ilike '%submission_unknown%'
  ) then
    raise exception 'MG-SUPPORT-003D.C1 VERIFY FAIL: inflight unique index predicate missing';
  end if;

  select relrowsecurity into v_ok
  from pg_class
  where oid = 'public.tenant_support_actions'::regclass;
  if v_ok is not true then
    raise exception 'MG-SUPPORT-003D.C1 VERIFY FAIL: RLS not enabled';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'tenant_support_actions'
      and grantee in ('anon', 'authenticated', 'public')
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'SELECT', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
  ) then
    raise exception 'MG-SUPPORT-003D.C1 VERIFY FAIL: anon/authenticated/public have table privileges';
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'tenant_support_actions'
      and roles && array['anon', 'authenticated']::name[]
  ) then
    raise exception 'MG-SUPPORT-003D.C1 VERIFY FAIL: client-facing RLS policy present';
  end if;

  select count(distinct privilege_type) into v_svc_priv
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name = 'tenant_support_actions'
    and grantee = 'service_role'
    and privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE');
  if v_svc_priv is distinct from 4 then
    raise exception 'MG-SUPPORT-003D.C1 VERIFY FAIL: service_role SELECT/INSERT/UPDATE/DELETE missing';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'tenant_support_actions'
      and policyname = 'service role full access tenant_support_actions'
      and cmd = 'ALL'
      and roles && array['service_role']::name[]
      and lower(btrim(coalesce(qual, ''))) in ('true', '(true)')
      and lower(btrim(coalesce(with_check, ''))) in ('true', '(true)')
  ) then
    raise exception 'MG-SUPPORT-003D.C1 VERIFY FAIL: service_role RLS policy missing or not permissive ALL';
  end if;

  raise notice 'MG-SUPPORT-003D.C1 VERIFY PASS: table, types, nullability, constraints, RLS, grants, inflight unique';
end
$$;
