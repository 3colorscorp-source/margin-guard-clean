-- =============================================================================
-- Margin Guard | CH-004A4 — Tenant Contract Legal Notices Foundation
-- =============================================================================
-- STATUS: MANUAL SUPABASE APPLY REQUIRED
--
-- Apply manually in Supabase SQL Editor only after owner review.
-- Do not run from CI. Do not apply automatically.
--
-- ADDITIVE SCOPE:
--   * public.tenant_contract_legal_notices
--   * public.replace_tenant_contract_legal_notices(...)
--
-- NOT IN THIS MIGRATION:
--   * Contract Builder UI wiring
--   * contract generation, PDFs, signatures, or customer send
--   * payment schedules, project setups, invoices, quotes
--   * fake production rows
--
-- ROLLBACK (manual, only if required before production data exists):
--   drop function if exists public.replace_tenant_contract_legal_notices(
--     uuid, jsonb, boolean, timestamptz
--   );
--   drop table if exists public.tenant_contract_legal_notices cascade;
-- =============================================================================

create table if not exists public.tenant_contract_legal_notices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,

  contract_notice text not null default ''
    check (char_length(contract_notice) <= 4000),
  payment_notice text not null default ''
    check (char_length(payment_notice) <= 4000),
  change_order_notice text not null default ''
    check (char_length(change_order_notice) <= 4000),
  cancellation_notice text not null default ''
    check (char_length(cancellation_notice) <= 4000),
  warranty_notice text not null default ''
    check (char_length(warranty_notice) <= 4000),
  limitation_of_liability text not null default ''
    check (char_length(limitation_of_liability) <= 4000),
  permit_notice text not null default ''
    check (char_length(permit_notice) <= 4000),
  site_conditions_notice text not null default ''
    check (char_length(site_conditions_notice) <= 4000),
  cleanup_notice text not null default ''
    check (char_length(cleanup_notice) <= 4000),
  material_notice text not null default ''
    check (char_length(material_notice) <= 4000),
  dispute_notice text not null default ''
    check (char_length(dispute_notice) <= 4000),
  force_majeure_notice text not null default ''
    check (char_length(force_majeure_notice) <= 4000),
  governing_law_notice text not null default ''
    check (char_length(governing_law_notice) <= 4000),
  additional_terms text not null default ''
    check (char_length(additional_terms) <= 4000),

  confirmed_at timestamptz null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint tenant_contract_legal_notices_tenant_id_key
    unique (tenant_id)
);

comment on table public.tenant_contract_legal_notices is
  'Tenant-scoped contract legal notice configuration. One active row per tenant. Does not generate or execute contracts.';

comment on column public.tenant_contract_legal_notices.tenant_id is
  'Resolved from authenticated server session only; never accepted from browser input.';

comment on column public.tenant_contract_legal_notices.confirmed_at is
  'Set by the Owner/Admin endpoint only when notices are explicitly confirmed.';

create index if not exists tenant_contract_legal_notices_tenant_id_idx
  on public.tenant_contract_legal_notices (tenant_id);

drop trigger if exists trg_tenant_contract_legal_notices_updated_at
  on public.tenant_contract_legal_notices;
create trigger trg_tenant_contract_legal_notices_updated_at
before update on public.tenant_contract_legal_notices
for each row execute function public.set_updated_at();

alter table public.tenant_contract_legal_notices enable row level security;

drop policy if exists "service role full access tenant_contract_legal_notices"
  on public.tenant_contract_legal_notices;
create policy "service role full access tenant_contract_legal_notices"
on public.tenant_contract_legal_notices
for all
to service_role
using (true)
with check (true);

-- -----------------------------------------------------------------------------
-- Atomic legal-notice replacement RPC (single PostgreSQL transaction)
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
  v_existing public.tenant_contract_legal_notices%rowtype;
  v_now timestamptz := now();
  v_confirmed_at timestamptz;
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
  v_fields jsonb := '{}'::jsonb;
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

  perform pg_advisory_xact_lock(hashtext(p_tenant_id::text || ':tenant_contract_legal_notices'));

  if not exists (
    select 1
    from public.tenants t
    where t.id = p_tenant_id
  ) then
    raise exception 'MG_ERR:notices_unavailable:Tenant legal notices unavailable';
  end if;

  select *
  into v_existing
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
    select 1
    from jsonb_object_keys(p_notices) as k
    where not (k = any (v_allowed_keys))
  ) then
    raise exception 'MG_ERR:unknown_fields:Unknown notice fields rejected';
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

    v_fields := v_fields || jsonb_build_object(v_key, v_value);
  end loop;

  if p_confirm_notices then
    if not exists (
      select 1
      from unnest(v_allowed_keys) as notice_key
      where nullif(v_fields ->> notice_key, '') is not null
    ) then
      raise exception 'MG_ERR:notices_required:At least one legal notice is required before confirmation';
    end if;
    v_confirmed_at := v_now;
  else
    v_confirmed_at := null;
  end if;

  if v_existing.id is null then
    insert into public.tenant_contract_legal_notices (
      tenant_id,
      contract_notice,
      payment_notice,
      change_order_notice,
      cancellation_notice,
      warranty_notice,
      limitation_of_liability,
      permit_notice,
      site_conditions_notice,
      cleanup_notice,
      material_notice,
      dispute_notice,
      force_majeure_notice,
      governing_law_notice,
      additional_terms,
      confirmed_at,
      created_at,
      updated_at
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
      'confirmed_at', v_existing.confirmed_at,
      'created_at', v_existing.created_at,
      'updated_at', v_existing.updated_at
    ),
    'readiness', jsonb_build_object(
      'status', case
        when v_existing.confirmed_at is not null then 'configured'
        else 'draft'
      end,
      'confirmed_at', v_existing.confirmed_at
    )
  );
end;
$$;

comment on function public.replace_tenant_contract_legal_notices(
  uuid, jsonb, boolean, timestamptz
) is
  'Atomic Owner/Admin tenant legal-notice replacement. Service-role only. Optimistic concurrency inside one transaction.';

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

-- No anon or authenticated policies. Browser access is via Netlify handlers.
-- Owner/Admin read/write is enforced by the Netlify function (session + membership).
-- This migration inserts no rows.
