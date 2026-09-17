-- =============================================================================
-- Margin Guard | CH-083 — Project contract warranty/freeze transaction lock
-- =============================================================================
-- STATUS: MANUAL SUPABASE APPLY REQUIRED — do not run from CI or auto-deploy.
--
-- PURPOSE:
--   Close the TOCTOU race between project-contract-setup Warranty writes and
--   Contract Package Freeze. Both operations take the same advisory xact lock
--   on (tenant_id, project_id) before reading packages/setup and writing.
--
--   Lock key matches tenant_contract_packages_next_version:
--     hashtext(tenant_id::text || ':' || project_id::text)
--
-- ADDITIVE / IDEMPOTENT:
--   create or replace functions only. No table drops. No RLS policy rewrites.
--   No backfill. Snapshot immutability trigger is unchanged.
--
-- DEPENDENCIES:
--   public.project_contract_setups
--   public.tenant_contract_packages
--   public.tenant_projects
--   public.quotes
-- =============================================================================

create or replace function public.project_contract_xact_lock(
  p_tenant_id uuid,
  p_project_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_tenant_id is null or p_project_id is null then
    raise exception 'MG_ERR:invalid_id:tenant_id and project_id are required';
  end if;

  perform pg_advisory_xact_lock(
    hashtext(p_tenant_id::text || ':' || p_project_id::text)
  );
end;
$$;

comment on function public.project_contract_xact_lock(uuid, uuid) is
  'CH-083 transaction lock for Warranty mutation and Contract Package Freeze. Same key as tenant_contract_packages_next_version.';

revoke all on function public.project_contract_xact_lock(uuid, uuid) from public;
revoke all on function public.project_contract_xact_lock(uuid, uuid) from anon;
revoke all on function public.project_contract_xact_lock(uuid, uuid) from authenticated;
grant execute on function public.project_contract_xact_lock(uuid, uuid) to service_role;

-- Keep next_version on the same lock helper so version allocation cannot
-- race a warranty write or freeze insert.
create or replace function public.tenant_contract_packages_next_version(
  p_tenant_id uuid,
  p_project_id uuid
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_next integer;
begin
  if p_tenant_id is null or p_project_id is null then
    raise exception 'contract_package_next_version_invalid_args'
      using errcode = '22023';
  end if;

  perform public.project_contract_xact_lock(p_tenant_id, p_project_id);

  select coalesce(max(p.version), 0) + 1
    into v_next
  from public.tenant_contract_packages p
  where p.tenant_id = p_tenant_id
    and p.project_id = p_project_id;

  return v_next;
end;
$$;

revoke all on function public.tenant_contract_packages_next_version(uuid, uuid) from public;
revoke all on function public.tenant_contract_packages_next_version(uuid, uuid) from anon;
revoke all on function public.tenant_contract_packages_next_version(uuid, uuid) from authenticated;
grant execute on function public.tenant_contract_packages_next_version(uuid, uuid) to service_role;

create or replace function public.save_project_contract_warranty(
  p_tenant_id uuid,
  p_project_id uuid,
  p_quote_id uuid,
  p_updates jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_lock public.tenant_contract_packages%rowtype;
  v_row public.project_contract_setups%rowtype;
  v_key text;
  v_allowed text[] := array[
    'warranty_duration_value',
    'warranty_duration_unit',
    'warranty_summary',
    'warranty_exclusions',
    'warranty_confirmed_at'
  ];
begin
  if p_tenant_id is null or p_project_id is null or p_quote_id is null then
    raise exception 'MG_ERR:invalid_id:project_id and quote_id are required';
  end if;

  if p_updates is null or jsonb_typeof(p_updates) <> 'object' then
    raise exception 'MG_ERR:no_changes:No setup fields supplied';
  end if;

  for v_key in select jsonb_object_keys(p_updates)
  loop
    if not (v_key = any (v_allowed)) then
      raise exception 'MG_ERR:unknown_fields:Unknown fields rejected';
    end if;
  end loop;

  if not exists (
    select 1
    from jsonb_object_keys(p_updates) k(key)
    where k.key = any (v_allowed)
  ) then
    raise exception 'MG_ERR:no_changes:No setup fields supplied';
  end if;

  perform public.project_contract_xact_lock(p_tenant_id, p_project_id);

  if not exists (
    select 1
    from public.tenant_projects tp
    where tp.id = p_project_id
      and tp.tenant_id = p_tenant_id
      and tp.quote_id = p_quote_id
  ) then
    raise exception 'MG_ERR:setup_unavailable:Project contract setup unavailable';
  end if;

  select p.*
    into v_lock
  from public.tenant_contract_packages p
  where p.tenant_id = p_tenant_id
    and p.project_id = p_project_id
    and lower(coalesce(p.status, '')) in ('ready', 'executed', 'superseded', 'frozen')
  order by p.version desc
  limit 1;

  if v_lock.id is not null then
    raise exception 'MG_ERR:warranty_locked_by_package:Warranty terms cannot be changed after the contract package is frozen.'
      using detail = jsonb_build_object(
        'package_id', v_lock.id,
        'package_status', v_lock.status
      )::text;
  end if;

  insert into public.project_contract_setups (
    tenant_id,
    project_id,
    quote_id,
    warranty_duration_value,
    warranty_duration_unit,
    warranty_summary,
    warranty_exclusions,
    warranty_confirmed_at
  )
  values (
    p_tenant_id,
    p_project_id,
    p_quote_id,
    case
      when p_updates ? 'warranty_duration_value'
        then nullif(p_updates->>'warranty_duration_value', '')::integer
      else null
    end,
    case
      when p_updates ? 'warranty_duration_unit'
        then coalesce(nullif(p_updates->>'warranty_duration_unit', ''), 'months')
      else 'months'
    end,
    case
      when p_updates ? 'warranty_summary' then coalesce(p_updates->>'warranty_summary', '')
      else ''
    end,
    case
      when p_updates ? 'warranty_exclusions' then coalesce(p_updates->>'warranty_exclusions', '')
      else ''
    end,
    case
      when p_updates ? 'warranty_confirmed_at'
        then nullif(p_updates->>'warranty_confirmed_at', '')::timestamptz
      else null
    end
  )
  on conflict on constraint project_contract_setups_tenant_project_quote_key
  do update set
    warranty_duration_value = case
      when p_updates ? 'warranty_duration_value'
        then nullif(p_updates->>'warranty_duration_value', '')::integer
      else public.project_contract_setups.warranty_duration_value
    end,
    warranty_duration_unit = case
      when p_updates ? 'warranty_duration_unit'
        then coalesce(nullif(p_updates->>'warranty_duration_unit', ''), public.project_contract_setups.warranty_duration_unit)
      else public.project_contract_setups.warranty_duration_unit
    end,
    warranty_summary = case
      when p_updates ? 'warranty_summary'
        then coalesce(p_updates->>'warranty_summary', '')
      else public.project_contract_setups.warranty_summary
    end,
    warranty_exclusions = case
      when p_updates ? 'warranty_exclusions'
        then coalesce(p_updates->>'warranty_exclusions', '')
      else public.project_contract_setups.warranty_exclusions
    end,
    warranty_confirmed_at = case
      when p_updates ? 'warranty_confirmed_at'
        then nullif(p_updates->>'warranty_confirmed_at', '')::timestamptz
      else public.project_contract_setups.warranty_confirmed_at
    end
  returning * into v_row;

  if v_row.id is null then
    raise exception 'MG_ERR:save_failed:Project contract setup save failed';
  end if;

  return to_jsonb(v_row);
end;
$$;

comment on function public.save_project_contract_warranty(uuid, uuid, uuid, jsonb) is
  'CH-083 atomic Warranty mutation: lock, reject frozen packages, upsert warranty columns.';

revoke all on function public.save_project_contract_warranty(uuid, uuid, uuid, jsonb) from public;
revoke all on function public.save_project_contract_warranty(uuid, uuid, uuid, jsonb) from anon;
revoke all on function public.save_project_contract_warranty(uuid, uuid, uuid, jsonb) from authenticated;
grant execute on function public.save_project_contract_warranty(uuid, uuid, uuid, jsonb) to service_role;

create or replace function public.freeze_tenant_contract_package(
  p_tenant_id uuid,
  p_project_id uuid,
  p_quote_id uuid,
  p_snapshot_json jsonb,
  p_content_hash text,
  p_source_readiness jsonb,
  p_created_by uuid default null,
  p_expected_setup_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_setup public.project_contract_setups%rowtype;
  v_ready public.tenant_contract_packages%rowtype;
  v_inserted public.tenant_contract_packages%rowtype;
  v_snap jsonb;
  v_snap_duration numeric;
  v_hash text;
  v_next integer;
  v_idempotent boolean := false;
begin
  if p_tenant_id is null or p_project_id is null or p_quote_id is null then
    raise exception 'MG_ERR:invalid_id:project_id and quote_id are required';
  end if;

  if p_snapshot_json is null or jsonb_typeof(p_snapshot_json) <> 'object' then
    raise exception 'MG_ERR:insert_failed:Could not create contract package';
  end if;

  if p_source_readiness is null or jsonb_typeof(p_source_readiness) <> 'object' then
    raise exception 'MG_ERR:insert_failed:Could not create contract package';
  end if;

  v_hash := lower(btrim(coalesce(p_content_hash, '')));
  if v_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'MG_ERR:insert_failed:Could not create contract package';
  end if;

  perform public.project_contract_xact_lock(p_tenant_id, p_project_id);

  if not exists (
    select 1
    from public.tenant_projects tp
    where tp.id = p_project_id
      and tp.tenant_id = p_tenant_id
      and tp.quote_id = p_quote_id
  ) then
    raise exception 'MG_ERR:not_found:Project or quote not found';
  end if;

  select s.*
    into v_setup
  from public.project_contract_setups s
  where s.tenant_id = p_tenant_id
    and s.project_id = p_project_id
    and s.quote_id = p_quote_id
  limit 1;

  if v_setup.id is null then
    raise exception 'MG_ERR:setup_version_conflict:Contract setup changed. Reload before freezing.';
  end if;

  if p_expected_setup_updated_at is not null
     and v_setup.updated_at is distinct from p_expected_setup_updated_at then
    raise exception 'MG_ERR:setup_version_conflict:Contract setup changed. Reload before freezing.';
  end if;

  v_snap := coalesce(p_snapshot_json -> 'warranty', '{}'::jsonb);
  v_snap_duration := nullif(v_snap->>'duration_value', '')::numeric;

  if v_snap_duration is distinct from v_setup.warranty_duration_value
     or lower(coalesce(v_snap->>'duration_unit', ''))
          is distinct from lower(coalesce(v_setup.warranty_duration_unit, ''))
     or coalesce(v_snap->>'summary', '')
          is distinct from coalesce(v_setup.warranty_summary, '')
     or coalesce(v_snap->>'exclusions', '')
          is distinct from coalesce(v_setup.warranty_exclusions, '')
  then
    raise exception 'MG_ERR:setup_version_conflict:Contract setup changed. Reload before freezing.';
  end if;

  select p.*
    into v_ready
  from public.tenant_contract_packages p
  where p.tenant_id = p_tenant_id
    and p.project_id = p_project_id
    and p.status = 'ready'
  order by p.version desc
  limit 1;

  if v_ready.id is not null and lower(coalesce(v_ready.content_hash, '')) = v_hash then
    v_idempotent := true;
    return jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'package', to_jsonb(v_ready)
    );
  end if;

  select coalesce(max(p.version), 0) + 1
    into v_next
  from public.tenant_contract_packages p
  where p.tenant_id = p_tenant_id
    and p.project_id = p_project_id;

  insert into public.tenant_contract_packages (
    tenant_id,
    project_id,
    quote_id,
    version,
    status,
    snapshot_json,
    content_hash,
    source_readiness,
    supersedes_package_id,
    created_by
  )
  values (
    p_tenant_id,
    p_project_id,
    p_quote_id,
    v_next,
    'ready',
    p_snapshot_json,
    v_hash,
    p_source_readiness,
    v_ready.id,
    p_created_by
  )
  returning * into v_inserted;

  if v_inserted.id is null then
    raise exception 'MG_ERR:insert_failed:Could not create contract package';
  end if;

  if v_ready.id is not null then
    update public.tenant_contract_packages
    set status = 'superseded'
    where tenant_id = p_tenant_id
      and id = v_ready.id
      and status = 'ready';
  end if;

  return jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'package', to_jsonb(v_inserted)
  );
end;
$$;

comment on function public.freeze_tenant_contract_package(uuid, uuid, uuid, jsonb, text, jsonb, uuid, timestamptz) is
  'CH-083 atomic Freeze insert: same project lock, live setup warranty must match snapshot, Policy A idempotent.';

revoke all on function public.freeze_tenant_contract_package(uuid, uuid, uuid, jsonb, text, jsonb, uuid, timestamptz) from public;
revoke all on function public.freeze_tenant_contract_package(uuid, uuid, uuid, jsonb, text, jsonb, uuid, timestamptz) from anon;
revoke all on function public.freeze_tenant_contract_package(uuid, uuid, uuid, jsonb, text, jsonb, uuid, timestamptz) from authenticated;
grant execute on function public.freeze_tenant_contract_package(uuid, uuid, uuid, jsonb, text, jsonb, uuid, timestamptz) to service_role;
