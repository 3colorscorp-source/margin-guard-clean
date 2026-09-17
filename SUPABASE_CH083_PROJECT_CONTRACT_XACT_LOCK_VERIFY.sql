-- =============================================================================
-- Margin Guard | CH-083 — Project contract lock VERIFY (manual)
-- =============================================================================
-- Run after SUPABASE_CH083_PROJECT_CONTRACT_XACT_LOCK.sql
-- Structural only. Does not freeze live contracts or write durable warranty.
--
-- Success returns a Results row: ch083_verify_result = PASS
-- Any failed check raises and must not return PASS.
-- =============================================================================

do $$
declare
  v_lock_src text;
  v_save_src text;
  v_freeze_src text;
  v_next_src text;
  v_lock_expr text := 'hashtext(p_tenant_id::text || '':'' || p_project_id::text)';
  v_specs constant text[] := array[
    'public.project_contract_xact_lock(uuid, uuid)',
    'public.tenant_contract_packages_next_version(uuid, uuid)',
    'public.save_project_contract_warranty(uuid, uuid, uuid, jsonb)',
    'public.freeze_tenant_contract_package(uuid, uuid, uuid, jsonb, text, jsonb, uuid, timestamptz)'
  ];
  v_names constant text[] := array[
    'project_contract_xact_lock',
    'tenant_contract_packages_next_version',
    'save_project_contract_warranty',
    'freeze_tenant_contract_package'
  ];
  v_ident text;
  v_oid oid;
  v_definer boolean;
  v_cfg text;
  v_expected_oids oid[] := '{}';
  v_overload_ident text;
begin
  foreach v_ident in array v_specs
  loop
    v_oid := to_regprocedure(v_ident);
    if v_oid is null then
      raise exception 'CH-083 VERIFY FAIL: missing %', v_ident;
    end if;

    select p.prosecdef,
           coalesce(array_to_string(p.proconfig, ','), '')
      into v_definer, v_cfg
      from pg_proc p
     where p.oid = v_oid;

    if v_definer is distinct from true then
      raise exception 'CH-083 VERIFY FAIL: prosecdef is not true on %', v_ident;
    end if;

    if v_cfg !~* 'search_path='
       or v_cfg !~* 'pg_catalog'
       or v_cfg ~* '\$user' then
      raise exception 'CH-083 VERIFY FAIL: search_path is not safe on %: %', v_ident, v_cfg;
    end if;

    if exists (
      select 1
        from pg_proc p
        cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       where p.oid = v_oid
         and a.grantee = 0
         and a.privilege_type = 'EXECUTE'
    ) then
      raise exception 'CH-083 VERIFY FAIL: PUBLIC has EXECUTE on %', v_ident;
    end if;

    if has_function_privilege('anon', v_oid, 'EXECUTE') then
      raise exception 'CH-083 VERIFY FAIL: anon has EXECUTE on %', v_ident;
    end if;

    if has_function_privilege('authenticated', v_oid, 'EXECUTE') then
      raise exception 'CH-083 VERIFY FAIL: authenticated has EXECUTE on %', v_ident;
    end if;

    if not has_function_privilege('service_role', v_oid, 'EXECUTE') then
      raise exception 'CH-083 VERIFY FAIL: service_role missing EXECUTE on %', v_ident;
    end if;

    v_expected_oids := array_append(v_expected_oids, v_oid);
  end loop;

  select string_agg(
           p.oid::regprocedure::text,
           ', '
           order by p.proname, pg_get_function_identity_arguments(p.oid)
         )
    into v_overload_ident
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = any (v_names)
     and p.oid <> all (v_expected_oids)
     and exists (
       select 1
         from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where a.privilege_type = 'EXECUTE'
     );

  if v_overload_ident is not null then
    raise exception 'CH-083 VERIFY FAIL: unexpected executable overload: %', v_overload_ident;
  end if;

  select pg_get_functiondef('public.project_contract_xact_lock(uuid, uuid)'::regprocedure)
    into v_lock_src;
  select pg_get_functiondef('public.save_project_contract_warranty(uuid, uuid, uuid, jsonb)'::regprocedure)
    into v_save_src;
  select pg_get_functiondef('public.freeze_tenant_contract_package(uuid, uuid, uuid, jsonb, text, jsonb, uuid, timestamptz)'::regprocedure)
    into v_freeze_src;
  select pg_get_functiondef('public.tenant_contract_packages_next_version(uuid, uuid)'::regprocedure)
    into v_next_src;

  if position('pg_advisory_xact_lock' in v_lock_src) = 0 then
    raise exception 'CH-083 VERIFY FAIL: lock helper missing pg_advisory_xact_lock';
  end if;
  if position(v_lock_expr in v_lock_src) = 0 then
    raise exception 'CH-083 VERIFY FAIL: lock key expression drifted';
  end if;
  if position('project_contract_xact_lock' in v_save_src) = 0 then
    raise exception 'CH-083 VERIFY FAIL: warranty RPC missing project_contract_xact_lock';
  end if;
  if position('project_contract_xact_lock' in v_freeze_src) = 0 then
    raise exception 'CH-083 VERIFY FAIL: freeze RPC missing project_contract_xact_lock';
  end if;
  if position('project_contract_xact_lock' in v_next_src) = 0 then
    raise exception 'CH-083 VERIFY FAIL: next_version missing project_contract_xact_lock';
  end if;
  if position('warranty_locked_by_package' in v_save_src) = 0 then
    raise exception 'CH-083 VERIFY FAIL: warranty RPC missing lock code';
  end if;
  if position(
    'in (''ready'', ''executed'', ''superseded'', ''frozen'')'
    in v_save_src
  ) = 0 then
    raise exception 'CH-083 VERIFY FAIL: warranty lock statuses drifted';
  end if;

  raise notice 'CH-083 VERIFY PASS: lock helper, warranty RPC, freeze RPC, next_version share xact lock';
end;
$$;

select 'PASS'::text as ch083_verify_result;
