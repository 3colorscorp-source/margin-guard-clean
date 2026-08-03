-- CH-011B VERIFY — Contract Envelope foundation
-- Run AFTER production use. MANUAL SUPABASE APPLY.

do $$
declare
  v_tenant uuid;
  v_project uuid;
  v_quote uuid;
  v_pkg uuid;
  v_env uuid;
  v_env2 uuid;
  v_hit boolean := false;
begin
  if to_regclass('public.tenant_contract_envelopes') is null then
    raise exception
      'CH-011B VERIFY FAIL: relation public.tenant_contract_envelopes does not exist. Run SUPABASE_CH011B_CONTRACT_ENVELOPES.sql first.';
  end if;

  select id into v_tenant from public.tenants order by id limit 1;
  if v_tenant is null then
    raise exception 'CH-011B VERIFY FAIL: no tenants row';
  end if;

  select id, quote_id into v_project, v_quote
  from public.tenant_projects
  where tenant_id = v_tenant
    and quote_id is not null
  order by id
  limit 1;

  if v_project is null or v_quote is null then
    raise notice 'CH-011B VERIFY SKIP: no tenant_projects with quote_id for insert tests';
  else
    insert into public.tenant_contract_packages (
      tenant_id, project_id, quote_id, version, status,
      snapshot_json, content_hash, source_readiness
    ) values (
      v_tenant, v_project, v_quote, 910001, 'ready',
      '{"schema":"ch-011b-verify"}'::jsonb,
      repeat('c', 64),
      '{"ok":true}'::jsonb
    )
    returning id into v_pkg;

    insert into public.tenant_contract_envelopes (
      tenant_id, package_id, project_id, quote_id, status, metadata
    ) values (
      v_tenant, v_pkg, v_project, v_quote, 'draft', '{}'::jsonb
    )
    returning id into v_env;
    raise notice 'CH-011B VERIFY PASS: draft envelope insert';

    begin
      insert into public.tenant_contract_envelopes (
        tenant_id, package_id, project_id, quote_id, status
      ) values (
        v_tenant, v_pkg, v_project, v_quote, 'sent'
      )
      returning id into v_env2;
      raise exception 'CH-011B VERIFY FAIL: duplicate active envelope allowed';
    exception
      when unique_violation then
        raise notice 'CH-011B VERIFY PASS: one active envelope enforced';
        v_hit := true;
    end;
    if not v_hit then
      raise exception 'CH-011B VERIFY FAIL: active uniqueness did not fire';
    end if;

    update public.tenant_contract_envelopes
    set status = 'expired'
    where id = v_env;
    raise notice 'CH-011B VERIFY PASS: status to expired allowed';

    insert into public.tenant_contract_envelopes (
      tenant_id, package_id, project_id, quote_id, status
    ) values (
      v_tenant, v_pkg, v_project, v_quote, 'draft'
    )
    returning id into v_env2;
    raise notice 'CH-011B VERIFY PASS: replacement after expired allowed';

    begin
      insert into public.tenant_contract_envelopes (
        tenant_id, package_id, project_id, quote_id, status
      ) values (
        v_tenant, v_pkg, v_project, v_quote, 'bogus'
      );
      raise exception 'CH-011B VERIFY FAIL: invalid status allowed';
    exception
      when check_violation then
        raise notice 'CH-011B VERIFY PASS: invalid status blocked';
    end;

    delete from public.tenant_contract_envelopes where id in (v_env, v_env2);
    delete from public.tenant_contract_packages where id = v_pkg;
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'tenant_contract_envelopes'
      and policyname = 'service role full access tenant_contract_envelopes'
  ) then
    raise exception 'CH-011B VERIFY FAIL: RLS policy missing';
  end if;
  raise notice 'CH-011B VERIFY PASS: RLS policy present';

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'tenant_contract_envelopes_one_active_per_package_uidx'
  ) then
    raise exception 'CH-011B VERIFY FAIL: one-active unique index missing';
  end if;
  raise notice 'CH-011B VERIFY PASS: one-active unique index present';

  raise notice 'CH-011B VERIFY COMPLETE';
end;
$$;
