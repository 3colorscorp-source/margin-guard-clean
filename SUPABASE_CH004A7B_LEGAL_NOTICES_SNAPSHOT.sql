-- =============================================================================
-- Margin Guard | CH-004A7B — Legal Notices Enable Flags + Confirmed Snapshot
-- =============================================================================
-- STATUS: MANUAL SUPABASE APPLY REQUIRED
--
-- Additive, idempotent migration.
-- Does not overwrite existing notice text.
-- Does not auto-insert default templates.
-- Does not silently confirm empty tenants.
--
-- ZERO-DOWNTIME ROLLOUT:
--   * Keeps the production 4-argument RPC as a compatibility overload.
--   * Adds the new 5-argument RPC (enabled map + snapshot publish).
--   * Apply SQL first while old Netlify still calls the 4-argument signature.
--   * Deploy new Netlify next (calls 5-argument signature).
--   * Remove the 4-argument compatibility RPC only in a later cleanup phase.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Enabled columns (default true)
-- -----------------------------------------------------------------------------

alter table public.tenant_contract_legal_notices
  add column if not exists contract_notice_enabled boolean not null default true,
  add column if not exists payment_notice_enabled boolean not null default true,
  add column if not exists change_order_notice_enabled boolean not null default true,
  add column if not exists cancellation_notice_enabled boolean not null default true,
  add column if not exists warranty_notice_enabled boolean not null default true,
  add column if not exists limitation_of_liability_enabled boolean not null default true,
  add column if not exists permit_notice_enabled boolean not null default true,
  add column if not exists site_conditions_notice_enabled boolean not null default true,
  add column if not exists cleanup_notice_enabled boolean not null default true,
  add column if not exists material_notice_enabled boolean not null default true,
  add column if not exists dispute_notice_enabled boolean not null default true,
  add column if not exists force_majeure_notice_enabled boolean not null default true,
  add column if not exists governing_law_notice_enabled boolean not null default true,
  add column if not exists additional_terms_enabled boolean not null default true;

-- -----------------------------------------------------------------------------
-- 2) Confirmed snapshot columns
-- -----------------------------------------------------------------------------

alter table public.tenant_contract_legal_notices
  add column if not exists confirmed_notices jsonb null,
  add column if not exists confirmed_enabled jsonb null;

comment on column public.tenant_contract_legal_notices.confirmed_notices is
  'Immutable (until next Confirm) snapshot of the 14 notice text values published to contracts. Server-owned only.';

comment on column public.tenant_contract_legal_notices.confirmed_enabled is
  'Immutable (until next Confirm) snapshot of the 14 enabled flags published to contracts. Server-owned only.';

-- -----------------------------------------------------------------------------
-- 3) Backfill snapshots for previously confirmed tenants only
-- -----------------------------------------------------------------------------

update public.tenant_contract_legal_notices n
set
  confirmed_notices = jsonb_build_object(
    'contract_notice', coalesce(n.contract_notice, ''),
    'payment_notice', coalesce(n.payment_notice, ''),
    'change_order_notice', coalesce(n.change_order_notice, ''),
    'cancellation_notice', coalesce(n.cancellation_notice, ''),
    'warranty_notice', coalesce(n.warranty_notice, ''),
    'limitation_of_liability', coalesce(n.limitation_of_liability, ''),
    'permit_notice', coalesce(n.permit_notice, ''),
    'site_conditions_notice', coalesce(n.site_conditions_notice, ''),
    'cleanup_notice', coalesce(n.cleanup_notice, ''),
    'material_notice', coalesce(n.material_notice, ''),
    'dispute_notice', coalesce(n.dispute_notice, ''),
    'force_majeure_notice', coalesce(n.force_majeure_notice, ''),
    'governing_law_notice', coalesce(n.governing_law_notice, ''),
    'additional_terms', coalesce(n.additional_terms, '')
  ),
  confirmed_enabled = jsonb_build_object(
    'contract_notice', true,
    'payment_notice', true,
    'change_order_notice', true,
    'cancellation_notice', true,
    'warranty_notice', true,
    'limitation_of_liability', true,
    'permit_notice', true,
    'site_conditions_notice', true,
    'cleanup_notice', true,
    'material_notice', true,
    'dispute_notice', true,
    'force_majeure_notice', true,
    'governing_law_notice', true,
    'additional_terms', true
  )
where n.confirmed_at is not null
  and n.confirmed_notices is null;

-- Draft tenants: leave confirmed_* null (no silent snapshot).

-- -----------------------------------------------------------------------------
-- 4) New 5-argument RPC — draft preserves snapshot; confirm publishes atomically
-- ZERO-DOWNTIME: do NOT drop the production 4-argument signature in this phase.
-- Keep (uuid, jsonb, boolean, timestamptz) as a compatibility overload/wrapper
-- so existing Netlify traffic continues to resolve while this migration is live
-- and before the new function is deployed.
-- -----------------------------------------------------------------------------

drop function if exists public.replace_tenant_contract_legal_notices(
  uuid, jsonb, jsonb, boolean, timestamptz
);

create or replace function public.replace_tenant_contract_legal_notices(
  p_tenant_id uuid,
  p_notices jsonb,
  p_enabled jsonb,
  p_confirm_notices boolean,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_existing public.tenant_contract_legal_notices%rowtype;
  v_now timestamptz := now();
  v_row_count integer := 0;
  v_allowed_keys text[] := array[
    'contract_notice',
    'payment_notice',
    'change_order_notice',
    'cancellation_notice',
    'warranty_notice',
    'limitation_of_liability',
    'permit_notice',
    'site_conditions_notice',
    'cleanup_notice',
    'material_notice',
    'dispute_notice',
    'force_majeure_notice',
    'governing_law_notice',
    'additional_terms'
  ];
  v_key text;
  v_value text;
  v_enabled boolean;
  v_fields jsonb := '{}'::jsonb;
  v_enabled_fields jsonb := '{}'::jsonb;
  v_has_enabled_populated boolean := false;
  v_confirmed_notices jsonb;
  v_confirmed_enabled jsonb;
  v_confirmed_at timestamptz;
begin
  if p_tenant_id is null then
    raise exception 'MG_ERR:invalid_id:tenant_id is required';
  end if;

  if p_confirm_notices is null then
    raise exception 'MG_ERR:invalid_confirmation:confirm_notices must be a boolean';
  end if;

  if p_notices is null or jsonb_typeof(p_notices) <> 'object' then
    raise exception 'MG_ERR:invalid_notices:notices must be a JSON object';
  end if;

  if p_enabled is null or jsonb_typeof(p_enabled) <> 'object' then
    raise exception 'MG_ERR:invalid_enabled:enabled must be a JSON object';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_tenant_id::text || ':tenant_contract_legal_notices'));

  if not exists (select 1 from public.tenants t where t.id = p_tenant_id) then
    raise exception 'MG_ERR:notices_unavailable:Tenant legal notices unavailable';
  end if;

  select * into v_existing
  from public.tenant_contract_legal_notices n
  where n.tenant_id = p_tenant_id
  limit 1;

  if v_existing.id is null then
    if p_expected_updated_at is not null then
      raise exception 'MG_ERR:notices_version_conflict:These legal notices changed in another session. Reload before saving.';
    end if;
  else
    if p_expected_updated_at is null
       or p_expected_updated_at is distinct from v_existing.updated_at then
      raise exception 'MG_ERR:notices_version_conflict:These legal notices changed in another session. Reload before saving.';
    end if;
  end if;

  if exists (
    select 1 from jsonb_object_keys(p_notices) as k
    where not (k = any (v_allowed_keys))
  ) then
    raise exception 'MG_ERR:unknown_fields:Unknown notice fields rejected';
  end if;

  if exists (
    select 1 from jsonb_object_keys(p_enabled) as k
    where not (k = any (v_allowed_keys))
  ) then
    raise exception 'MG_ERR:unknown_fields:Unknown enabled fields rejected';
  end if;

  foreach v_key in array v_allowed_keys
  loop
    if p_notices ? v_key then
      if jsonb_typeof(p_notices -> v_key) not in ('string', 'null') then
        raise exception 'MG_ERR:invalid_notice:Notice fields must be strings';
      end if;
      v_value := btrim(coalesce(p_notices ->> v_key, ''));
    else
      v_value := '';
    end if;

    if char_length(v_value) > 4000 then
      raise exception 'MG_ERR:notice_too_long:% exceeds 4000 characters', v_key;
    end if;

    if p_enabled ? v_key then
      if jsonb_typeof(p_enabled -> v_key) <> 'boolean' then
        raise exception 'MG_ERR:invalid_enabled:Enabled flags must be booleans';
      end if;
      v_enabled := (p_enabled ->> v_key)::boolean;
    else
      v_enabled := true;
    end if;

    v_fields := v_fields || jsonb_build_object(v_key, v_value);
    v_enabled_fields := v_enabled_fields || jsonb_build_object(v_key, v_enabled);

    if v_enabled and nullif(v_value, '') is not null then
      v_has_enabled_populated := true;
    end if;

    if p_confirm_notices and v_enabled and nullif(v_value, '') is null then
      raise exception 'MG_ERR:enabled_notice_empty:Enabled notices require text before confirmation';
    end if;
  end loop;

  if p_confirm_notices and not v_has_enabled_populated then
    raise exception 'MG_ERR:notices_required:At least one enabled legal notice is required before confirmation';
  end if;

  if p_confirm_notices then
    v_confirmed_notices := v_fields;
    v_confirmed_enabled := v_enabled_fields;
    v_confirmed_at := v_now;
  else
    -- Draft: preserve existing snapshot and confirmed_at
    v_confirmed_notices := v_existing.confirmed_notices;
    v_confirmed_enabled := v_existing.confirmed_enabled;
    v_confirmed_at := v_existing.confirmed_at;
  end if;

  if v_existing.id is null then
    insert into public.tenant_contract_legal_notices (
      tenant_id,
      contract_notice, payment_notice, change_order_notice, cancellation_notice,
      warranty_notice, limitation_of_liability, permit_notice, site_conditions_notice,
      cleanup_notice, material_notice, dispute_notice, force_majeure_notice,
      governing_law_notice, additional_terms,
      contract_notice_enabled, payment_notice_enabled, change_order_notice_enabled,
      cancellation_notice_enabled, warranty_notice_enabled, limitation_of_liability_enabled,
      permit_notice_enabled, site_conditions_notice_enabled, cleanup_notice_enabled,
      material_notice_enabled, dispute_notice_enabled, force_majeure_notice_enabled,
      governing_law_notice_enabled, additional_terms_enabled,
      confirmed_notices, confirmed_enabled, confirmed_at,
      created_at, updated_at
    )
    values (
      p_tenant_id,
      v_fields ->> 'contract_notice',
      v_fields ->> 'payment_notice',
      v_fields ->> 'change_order_notice',
      v_fields ->> 'cancellation_notice',
      v_fields ->> 'warranty_notice',
      v_fields ->> 'limitation_of_liability',
      v_fields ->> 'permit_notice',
      v_fields ->> 'site_conditions_notice',
      v_fields ->> 'cleanup_notice',
      v_fields ->> 'material_notice',
      v_fields ->> 'dispute_notice',
      v_fields ->> 'force_majeure_notice',
      v_fields ->> 'governing_law_notice',
      v_fields ->> 'additional_terms',
      (v_enabled_fields ->> 'contract_notice')::boolean,
      (v_enabled_fields ->> 'payment_notice')::boolean,
      (v_enabled_fields ->> 'change_order_notice')::boolean,
      (v_enabled_fields ->> 'cancellation_notice')::boolean,
      (v_enabled_fields ->> 'warranty_notice')::boolean,
      (v_enabled_fields ->> 'limitation_of_liability')::boolean,
      (v_enabled_fields ->> 'permit_notice')::boolean,
      (v_enabled_fields ->> 'site_conditions_notice')::boolean,
      (v_enabled_fields ->> 'cleanup_notice')::boolean,
      (v_enabled_fields ->> 'material_notice')::boolean,
      (v_enabled_fields ->> 'dispute_notice')::boolean,
      (v_enabled_fields ->> 'force_majeure_notice')::boolean,
      (v_enabled_fields ->> 'governing_law_notice')::boolean,
      (v_enabled_fields ->> 'additional_terms')::boolean,
      v_confirmed_notices,
      v_confirmed_enabled,
      v_confirmed_at,
      v_now,
      v_now
    )
    returning * into v_existing;
  else
    update public.tenant_contract_legal_notices n
    set
      contract_notice = v_fields ->> 'contract_notice',
      payment_notice = v_fields ->> 'payment_notice',
      change_order_notice = v_fields ->> 'change_order_notice',
      cancellation_notice = v_fields ->> 'cancellation_notice',
      warranty_notice = v_fields ->> 'warranty_notice',
      limitation_of_liability = v_fields ->> 'limitation_of_liability',
      permit_notice = v_fields ->> 'permit_notice',
      site_conditions_notice = v_fields ->> 'site_conditions_notice',
      cleanup_notice = v_fields ->> 'cleanup_notice',
      material_notice = v_fields ->> 'material_notice',
      dispute_notice = v_fields ->> 'dispute_notice',
      force_majeure_notice = v_fields ->> 'force_majeure_notice',
      governing_law_notice = v_fields ->> 'governing_law_notice',
      additional_terms = v_fields ->> 'additional_terms',
      contract_notice_enabled = (v_enabled_fields ->> 'contract_notice')::boolean,
      payment_notice_enabled = (v_enabled_fields ->> 'payment_notice')::boolean,
      change_order_notice_enabled = (v_enabled_fields ->> 'change_order_notice')::boolean,
      cancellation_notice_enabled = (v_enabled_fields ->> 'cancellation_notice')::boolean,
      warranty_notice_enabled = (v_enabled_fields ->> 'warranty_notice')::boolean,
      limitation_of_liability_enabled = (v_enabled_fields ->> 'limitation_of_liability')::boolean,
      permit_notice_enabled = (v_enabled_fields ->> 'permit_notice')::boolean,
      site_conditions_notice_enabled = (v_enabled_fields ->> 'site_conditions_notice')::boolean,
      cleanup_notice_enabled = (v_enabled_fields ->> 'cleanup_notice')::boolean,
      material_notice_enabled = (v_enabled_fields ->> 'material_notice')::boolean,
      dispute_notice_enabled = (v_enabled_fields ->> 'dispute_notice')::boolean,
      force_majeure_notice_enabled = (v_enabled_fields ->> 'force_majeure_notice')::boolean,
      governing_law_notice_enabled = (v_enabled_fields ->> 'governing_law_notice')::boolean,
      additional_terms_enabled = (v_enabled_fields ->> 'additional_terms')::boolean,
      confirmed_notices = v_confirmed_notices,
      confirmed_enabled = v_confirmed_enabled,
      confirmed_at = v_confirmed_at,
      updated_at = v_now
    where n.id = v_existing.id
      and n.tenant_id = p_tenant_id
    returning * into v_existing;

    get diagnostics v_row_count = row_count;
    if v_row_count <> 1 then
      raise exception 'MG_ERR:save_failed:Legal notices save failed';
    end if;
  end if;

  -- Return working row + snapshots. Readiness is evaluated by the Netlify handler.
  return jsonb_build_object(
    'notices', jsonb_build_object(
      'id', v_existing.id,
      'tenant_id', v_existing.tenant_id,
      'contract_notice', v_existing.contract_notice,
      'payment_notice', v_existing.payment_notice,
      'change_order_notice', v_existing.change_order_notice,
      'cancellation_notice', v_existing.cancellation_notice,
      'warranty_notice', v_existing.warranty_notice,
      'limitation_of_liability', v_existing.limitation_of_liability,
      'permit_notice', v_existing.permit_notice,
      'site_conditions_notice', v_existing.site_conditions_notice,
      'cleanup_notice', v_existing.cleanup_notice,
      'material_notice', v_existing.material_notice,
      'dispute_notice', v_existing.dispute_notice,
      'force_majeure_notice', v_existing.force_majeure_notice,
      'governing_law_notice', v_existing.governing_law_notice,
      'additional_terms', v_existing.additional_terms,
      'contract_notice_enabled', v_existing.contract_notice_enabled,
      'payment_notice_enabled', v_existing.payment_notice_enabled,
      'change_order_notice_enabled', v_existing.change_order_notice_enabled,
      'cancellation_notice_enabled', v_existing.cancellation_notice_enabled,
      'warranty_notice_enabled', v_existing.warranty_notice_enabled,
      'limitation_of_liability_enabled', v_existing.limitation_of_liability_enabled,
      'permit_notice_enabled', v_existing.permit_notice_enabled,
      'site_conditions_notice_enabled', v_existing.site_conditions_notice_enabled,
      'cleanup_notice_enabled', v_existing.cleanup_notice_enabled,
      'material_notice_enabled', v_existing.material_notice_enabled,
      'dispute_notice_enabled', v_existing.dispute_notice_enabled,
      'force_majeure_notice_enabled', v_existing.force_majeure_notice_enabled,
      'governing_law_notice_enabled', v_existing.governing_law_notice_enabled,
      'additional_terms_enabled', v_existing.additional_terms_enabled,
      'confirmed_at', v_existing.confirmed_at,
      'created_at', v_existing.created_at,
      'updated_at', v_existing.updated_at
    ),
    'confirmed_notices', v_existing.confirmed_notices,
    'confirmed_enabled', v_existing.confirmed_enabled
  );
end;
$$;

comment on function public.replace_tenant_contract_legal_notices(
  uuid, jsonb, jsonb, boolean, timestamptz
) is
  'CH-004A7B atomic legal notices replace. Draft preserves confirmed snapshot. Confirm publishes working draft to snapshot.';

revoke all on function public.replace_tenant_contract_legal_notices(
  uuid, jsonb, jsonb, boolean, timestamptz
) from public;

revoke execute on function public.replace_tenant_contract_legal_notices(
  uuid, jsonb, jsonb, boolean, timestamptz
) from anon;

revoke execute on function public.replace_tenant_contract_legal_notices(
  uuid, jsonb, jsonb, boolean, timestamptz
) from authenticated;

grant execute on function public.replace_tenant_contract_legal_notices(
  uuid, jsonb, jsonb, boolean, timestamptz
) to service_role;

-- -----------------------------------------------------------------------------
-- 5) Production 4-argument compatibility overload (KEEP for A7B rollout)
-- Wraps the 5-argument implementation with enabled flags defaulted to true.
-- Intentionally does NOT clear confirmed snapshots on draft (safer than A4).
-- Remove only in a later separately reviewed cleanup migration after new code PASS.
-- -----------------------------------------------------------------------------

create or replace function public.replace_tenant_contract_legal_notices(
  p_tenant_id uuid,
  p_notices jsonb,
  p_confirm_notices boolean,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_enabled jsonb := jsonb_build_object(
    'contract_notice', true,
    'payment_notice', true,
    'change_order_notice', true,
    'cancellation_notice', true,
    'warranty_notice', true,
    'limitation_of_liability', true,
    'permit_notice', true,
    'site_conditions_notice', true,
    'cleanup_notice', true,
    'material_notice', true,
    'dispute_notice', true,
    'force_majeure_notice', true,
    'governing_law_notice', true,
    'additional_terms', true
  );
  v_result jsonb;
  v_notices jsonb;
  v_confirmed_at timestamptz;
begin
  -- Delegate to the 5-argument implementation (explicit signature).
  v_result := public.replace_tenant_contract_legal_notices(
    p_tenant_id,
    p_notices,
    v_enabled,
    p_confirm_notices,
    p_expected_updated_at
  );

  -- Preserve A4/A6 response shape: include readiness derived from confirmed_at
  -- so production Netlify code that prefers payload.readiness keeps working.
  v_notices := v_result -> 'notices';
  v_confirmed_at := nullif(v_notices ->> 'confirmed_at', '')::timestamptz;

  return v_result || jsonb_build_object(
    'readiness', jsonb_build_object(
      'status', case
        when v_confirmed_at is not null then 'configured'
        else 'draft'
      end,
      'confirmed_at', v_confirmed_at
    )
  );
end;
$$;

comment on function public.replace_tenant_contract_legal_notices(
  uuid, jsonb, boolean, timestamptz
) is
  'CH-004A7B temporary compatibility overload for pre-A7B Netlify callers. Defaults all enabled flags to true and delegates to the 5-argument RPC. Do not remove until post-deploy cleanup.';

revoke all on function public.replace_tenant_contract_legal_notices(
  uuid, jsonb, boolean, timestamptz
) from public;

revoke execute on function public.replace_tenant_contract_legal_notices(
  uuid, jsonb, boolean, timestamptz
) from anon;

revoke execute on function public.replace_tenant_contract_legal_notices(
  uuid, jsonb, boolean, timestamptz
) from authenticated;

grant execute on function public.replace_tenant_contract_legal_notices(
  uuid, jsonb, boolean, timestamptz
) to service_role;
