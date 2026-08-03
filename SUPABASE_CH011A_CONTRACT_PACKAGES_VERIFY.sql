-- =============================================================================
-- Margin Guard | CH-011A — Contract Package VERIFY (manual)
-- =============================================================================
-- Run after SUPABASE_CH011A_CONTRACT_PACKAGES.sql
-- Does not create durable rows (uses rollback).
-- =============================================================================

do $$
declare
  v_tenant uuid;
  v_project uuid;
  v_quote uuid;
  v_pkg uuid;
  v_pkg2 uuid;
  v_next integer;
  v_hit boolean := false;
begin
  select id into v_tenant from public.tenants order by id limit 1;
  if v_tenant is null then
    raise exception 'CH-011A VERIFY FAIL: no tenants row';
  end if;

  select id, quote_id into v_project, v_quote
  from public.tenant_projects
  where tenant_id = v_tenant
    and quote_id is not null
  order by id
  limit 1;

  if v_project is null or v_quote is null then
    raise notice 'CH-011A VERIFY SKIP: no tenant_projects with quote_id for structural insert tests';
  else
    begin
      insert into public.tenant_contract_packages (
        tenant_id, project_id, quote_id, version, status,
        snapshot_json, content_hash, source_readiness
      ) values (
        v_tenant, v_project, v_quote, 900001, 'ready',
        '{"schema":"ch-011a-v1"}'::jsonb,
        repeat('a', 64),
        '{"ok":true}'::jsonb
      )
      returning id into v_pkg;

      -- immutable content blocked
      begin
        update public.tenant_contract_packages
        set snapshot_json = '{"mutated":true}'::jsonb
        where id = v_pkg;
        raise exception 'CH-011A VERIFY FAIL: immutable snapshot allowed update';
      exception
        when check_violation then
          raise notice 'CH-011A VERIFY PASS: immutable snapshot blocked';
          v_hit := true;
        when others then
          if sqlerrm like '%contract_package_immutable%' then
            raise notice 'CH-011A VERIFY PASS: immutable snapshot blocked';
            v_hit := true;
          else
            raise;
          end if;
      end;
      if not v_hit then
        raise exception 'CH-011A VERIFY FAIL: immutable guard did not fire';
      end if;

      -- status transition allowed
      update public.tenant_contract_packages
      set status = 'superseded'
      where id = v_pkg;
      raise notice 'CH-011A VERIFY PASS: status transition allowed';

      -- next version helper
      v_next := public.tenant_contract_packages_next_version(v_tenant, v_project);
      if v_next < 1 then
        raise exception 'CH-011A VERIFY FAIL: next_version invalid';
      end if;
      raise notice 'CH-011A VERIFY PASS: next_version=%', v_next;

      -- unique version
      begin
        insert into public.tenant_contract_packages (
          tenant_id, project_id, quote_id, version, status,
          snapshot_json, content_hash, source_readiness
        ) values (
          v_tenant, v_project, v_quote, 900001, 'ready',
          '{"schema":"ch-011a-v1"}'::jsonb,
          repeat('b', 64),
          '{"ok":true}'::jsonb
        );
        raise exception 'CH-011A VERIFY FAIL: duplicate version accepted';
      exception
        when unique_violation then
          raise notice 'CH-011A VERIFY PASS: duplicate version rejected';
      end;

      -- bad hash rejected
      begin
        insert into public.tenant_contract_packages (
          tenant_id, project_id, quote_id, version, status,
          snapshot_json, content_hash, source_readiness
        ) values (
          v_tenant, v_project, v_quote, 900002, 'ready',
          '{"schema":"ch-011a-v1"}'::jsonb,
          'not-a-hash',
          '{"ok":true}'::jsonb
        );
        raise exception 'CH-011A VERIFY FAIL: bad content_hash accepted';
      exception
        when check_violation then
          raise notice 'CH-011A VERIFY PASS: bad content_hash rejected';
      end;

      -- bad status rejected
      begin
        insert into public.tenant_contract_packages (
          tenant_id, project_id, quote_id, version, status,
          snapshot_json, content_hash, source_readiness
        ) values (
          v_tenant, v_project, v_quote, 900003, 'sent',
          '{"schema":"ch-011a-v1"}'::jsonb,
          repeat('c', 64),
          '{"ok":true}'::jsonb
        );
        raise exception 'CH-011A VERIFY FAIL: signing status accepted';
      exception
        when check_violation then
          raise notice 'CH-011A VERIFY PASS: signing workflow status rejected';
      end;

      delete from public.tenant_contract_packages where id = v_pkg;
    end;
  end if;

  -- table + RLS present
  if to_regclass('public.tenant_contract_packages') is null then
    raise exception 'CH-011A VERIFY FAIL: table missing';
  end if;

  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'tenant_contract_packages'
      and c.relrowsecurity
  ) then
    raise exception 'CH-011A VERIFY FAIL: RLS not enabled';
  end if;

  raise notice 'CH-011A VERIFY PASS: table + RLS present';
  raise notice 'CH-011A VERIFY COMPLETE';
end;
$$;
