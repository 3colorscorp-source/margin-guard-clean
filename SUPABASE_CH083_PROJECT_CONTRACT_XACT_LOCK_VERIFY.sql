-- =============================================================================
-- Margin Guard | CH-083 — Project contract lock VERIFY (manual)
-- =============================================================================
-- Run after SUPABASE_CH083_PROJECT_CONTRACT_XACT_LOCK.sql
-- Structural only. Does not freeze live contracts or write durable warranty.
-- =============================================================================

do $$
declare
  v_lock_src text;
  v_save_src text;
  v_freeze_src text;
  v_next_src text;
  v_lock_expr text := 'hashtext(p_tenant_id::text || '':'' || p_project_id::text)';
begin
  if to_regprocedure('public.project_contract_xact_lock(uuid, uuid)') is null then
    raise exception 'CH-083 VERIFY FAIL: missing project_contract_xact_lock';
  end if;
  if to_regprocedure('public.save_project_contract_warranty(uuid, uuid, uuid, jsonb)') is null then
    raise exception 'CH-083 VERIFY FAIL: missing save_project_contract_warranty';
  end if;
  if to_regprocedure('public.freeze_tenant_contract_package(uuid, uuid, uuid, jsonb, text, jsonb, uuid, timestamptz)') is null then
    raise exception 'CH-083 VERIFY FAIL: missing freeze_tenant_contract_package';
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
  if position($$in ('ready', 'executed', 'superseded', 'frozen')$$ in v_save_src) = 0 then
    raise exception 'CH-083 VERIFY FAIL: warranty lock statuses drifted';
  end if;
  raise notice 'CH-083 VERIFY PASS: lock helper, warranty RPC, freeze RPC, next_version share xact lock';
end;
$$;
