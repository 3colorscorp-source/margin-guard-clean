-- =============================================================================
-- Margin Guard | CH-010B — Payment Intent foundation VERIFY
-- =============================================================================
-- Run after SUPABASE_CH010B_PAYMENT_INTENTS.sql.
-- Does not insert lasting business rows. No markdown. Pure SQL.
-- =============================================================================

do $$
declare
  v_cols int;
  v_idx int;
  v_policies int;
  v_rows bigint;
  v_bad_amount bigint;
  v_bad_status bigint;
  v_bad_title bigint;
  v_dep_projects boolean;
  v_dep_quotes boolean;
  v_dep_schedules boolean;
  v_dep_items boolean;
  v_dep_cos boolean;
  v_has_trigger boolean;
  v_rls boolean;
begin
  if to_regclass('public.tenant_project_payment_intents') is null then
    raise exception 'CH-010B VERIFY FAIL: table tenant_project_payment_intents missing';
  end if;

  select count(*) into v_cols
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'tenant_project_payment_intents';
  raise notice 'CH-010B VERIFY columns=%', v_cols;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'tenant_project_payment_intents'
      and column_name = 'amount'
      and data_type = 'numeric'
      and numeric_precision = 14
      and numeric_scale = 2
      and is_nullable = 'NO'
  ) then
    raise exception 'CH-010B VERIFY FAIL: amount numeric(14,2) NOT NULL missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenant_project_payment_intents'::regclass
      and conname = 'tenant_project_payment_intents_status_timestamps_chk'
  ) then
    raise exception 'CH-010B VERIFY FAIL: status_timestamps_chk missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenant_project_payment_intents'::regclass
      and conname = 'tenant_project_payment_intents_tenant_id_id_key'
  ) then
    raise exception 'CH-010B VERIFY FAIL: tenant_id_id unique missing';
  end if;

  select count(*) into v_idx
  from pg_indexes
  where schemaname = 'public'
    and tablename = 'tenant_project_payment_intents';
  raise notice 'CH-010B VERIFY indexes=%', v_idx;

  select relrowsecurity into v_rls
  from pg_class
  where oid = 'public.tenant_project_payment_intents'::regclass;
  if not coalesce(v_rls, false) then
    raise exception 'CH-010B VERIFY FAIL: RLS not enabled';
  end if;
  raise notice 'CH-010B VERIFY rls_enabled=true';

  select count(*) into v_policies
  from pg_policies
  where schemaname = 'public'
    and tablename = 'tenant_project_payment_intents';
  raise notice 'CH-010B VERIFY policies=%', v_policies;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'tenant_project_payment_intents'
      and policyname = 'service role full access tenant_project_payment_intents'
  ) then
    raise exception 'CH-010B VERIFY FAIL: service_role RLS policy missing';
  end if;

  select exists (
    select 1 from pg_trigger
    where tgrelid = 'public.tenant_project_payment_intents'::regclass
      and not tgisinternal
      and tgname = 'trg_tenant_project_payment_intents_assert_refs'
  ) into v_has_trigger;
  if not v_has_trigger then
    raise exception 'CH-010B VERIFY FAIL: assert_refs trigger missing';
  end if;
  raise notice 'CH-010B VERIFY trigger=trg_tenant_project_payment_intents_assert_refs';

  select count(*) into v_rows from public.tenant_project_payment_intents;
  raise notice 'CH-010B VERIFY row_count=%', v_rows;

  select count(*) into v_bad_amount
  from public.tenant_project_payment_intents
  where amount <= 0;
  select count(*) into v_bad_status
  from public.tenant_project_payment_intents
  where status not in ('draft', 'ready', 'cancelled', 'voided');
  select count(*) into v_bad_title
  from public.tenant_project_payment_intents
  where btrim(title) = '';
  raise notice 'CH-010B VERIFY invalid_amount_rows=% invalid_status_rows=% blank_title_rows=%',
    v_bad_amount, v_bad_status, v_bad_title;
  if v_bad_amount > 0 or v_bad_status > 0 or v_bad_title > 0 then
    raise exception 'CH-010B VERIFY FAIL: invalid rows present';
  end if;

  v_dep_projects := to_regclass('public.tenant_projects') is not null;
  v_dep_quotes := to_regclass('public.quotes') is not null;
  v_dep_schedules := to_regclass('public.project_contract_payment_schedules') is not null;
  v_dep_items := to_regclass('public.project_contract_payment_schedule_items') is not null;
  v_dep_cos := to_regclass('public.tenant_project_change_orders') is not null;
  raise notice 'CH-010B VERIFY deps projects=% quotes=% schedules=% items=% change_orders=%',
    v_dep_projects, v_dep_quotes, v_dep_schedules, v_dep_items, v_dep_cos;

  if not v_dep_projects or not v_dep_quotes then
    raise exception 'CH-010B VERIFY FAIL: required dependency tables missing';
  end if;

  raise notice 'CH-010B VERIFY PASS: foundation integrity checks complete';
end $$;

-- Zero-amount rejection smoke (subtransaction; no lasting row).
do $$
declare
  v_tenant uuid;
  v_project uuid;
begin
  select id into v_tenant from public.tenants limit 1;
  if v_tenant is null then
    raise notice 'CH-010B VERIFY SKIP amount check: no tenants';
    return;
  end if;

  select id into v_project
  from public.tenant_projects
  where tenant_id = v_tenant
  limit 1;
  if v_project is null then
    raise notice 'CH-010B VERIFY SKIP amount check: no projects for tenant';
    return;
  end if;

  begin
    insert into public.tenant_project_payment_intents (
      tenant_id, project_id, payment_type, title, amount, status
    ) values (
      v_tenant, v_project, 'custom', 'CH-010B VERIFY ZERO', 0, 'draft'
    );
    delete from public.tenant_project_payment_intents
    where tenant_id = v_tenant
      and title = 'CH-010B VERIFY ZERO';
    raise exception 'CH-010B VERIFY FAIL: zero amount was accepted';
  exception
    when check_violation then
      raise notice 'CH-010B VERIFY PASS: zero amount rejected';
  end;

  begin
    insert into public.tenant_project_payment_intents (
      tenant_id, project_id, payment_type, title, amount, status
    ) values (
      v_tenant, v_project, 'custom', '   ', 1.00, 'draft'
    );
    delete from public.tenant_project_payment_intents
    where tenant_id = v_tenant
      and title = '   ';
    raise exception 'CH-010B VERIFY FAIL: blank title was accepted';
  exception
    when check_violation then
      raise notice 'CH-010B VERIFY PASS: blank title rejected';
  end;
end $$;

-- Cross-tenant project mismatch must fail via trigger (when a second tenant exists).
do $$
declare
  v_tenant_a uuid;
  v_tenant_b uuid;
  v_project_b uuid;
begin
  select id into v_tenant_a from public.tenants order by id limit 1;
  select id into v_tenant_b
  from public.tenants
  where id is distinct from v_tenant_a
  order by id
  limit 1;
  if v_tenant_a is null or v_tenant_b is null then
    raise notice 'CH-010B VERIFY SKIP cross-tenant check: need >=2 tenants';
    return;
  end if;

  select id into v_project_b
  from public.tenant_projects
  where tenant_id = v_tenant_b
  limit 1;
  if v_project_b is null then
    raise notice 'CH-010B VERIFY SKIP cross-tenant check: no project on second tenant';
    return;
  end if;

  begin
    insert into public.tenant_project_payment_intents (
      tenant_id, project_id, payment_type, title, amount, status
    ) values (
      v_tenant_a, v_project_b, 'custom', 'CH-010B VERIFY XTENANT', 1.00, 'draft'
    );
    delete from public.tenant_project_payment_intents
    where title = 'CH-010B VERIFY XTENANT';
    raise exception 'CH-010B VERIFY FAIL: cross-tenant project accepted';
  exception
    when check_violation then
      raise notice 'CH-010B VERIFY PASS: cross-tenant project rejected';
    when foreign_key_violation then
      raise notice 'CH-010B VERIFY PASS: cross-tenant project rejected (fk)';
    when others then
      if SQLERRM like '%payment_intent_project_tenant_mismatch%'
         or SQLERRM like '%payment_intent_project%' then
        raise notice 'CH-010B VERIFY PASS: cross-tenant project rejected';
      else
        raise;
      end if;
  end;
end $$;
