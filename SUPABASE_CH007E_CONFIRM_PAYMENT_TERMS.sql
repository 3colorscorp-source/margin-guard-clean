-- =============================================================================
-- Margin Guard | CH-007E — Confirm Payment Terms without replacing stages
-- =============================================================================
-- STATUS: PREPARED FOR REVIEW — DO NOT APPLY until explicit owner authorization.
-- Do not run from CI. Do not apply automatically.
--
-- LIVE BASE: CH-007D-INFRA-001 (confirmed by production pg_get_functiondef).
-- Signature (unchanged):
--   replace_project_contract_payment_schedule(
--     uuid, uuid, uuid, numeric, text, boolean, jsonb, timestamptz
--   )
--
-- p_confirm_schedule = true:
--   validate tenant + project + quote; honor expected_updated_at except
--   idempotent re-confirm; create or stamp header; status=confirmed;
--   set confirmed_at; ignore posted items even if NULL or []; never items_required;
--   never schedule_total_mismatch; never DELETE/INSERT items.
-- p_confirm_schedule = false:
--   CH-007D draft/replace path unchanged, including item_role and invalid_items.
--
-- NOT IN THIS MIGRATION:
--   UI, Invoice Hub, ledger, frozen snapshots, Article 8, RLS, new tables.
-- =============================================================================

begin;

do $preflight$
declare
  v_count integer;
  v_args text;
  v_def text;
  v_security boolean;
  v_owner text;
  v_config text;
  v_has_item_role boolean;
begin
  select count(*)
  into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'replace_project_contract_payment_schedule';

  if v_count is distinct from 1 then
    raise exception
      'CH-007E preflight failed: expected exactly one replace_project_contract_payment_schedule, found %',
      v_count;
  end if;

  select
    oidvectortypes(p.proargtypes),
    pg_get_functiondef(p.oid),
    p.prosecdef,
    pg_get_userbyid(p.proowner),
    array_to_string(coalesce(p.proconfig, array[]::text[]), ' ')
  into v_args, v_def, v_security, v_owner, v_config
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'replace_project_contract_payment_schedule';

  if v_args is distinct from
     'uuid, uuid, uuid, numeric, text, boolean, jsonb, timestamp with time zone'
  then
    raise exception
      'CH-007E preflight failed: unexpected signature (%)',
      v_args;
  end if;

  if v_security is not true then
    raise exception 'CH-007E preflight failed: SECURITY DEFINER required';
  end if;

  if v_owner is distinct from 'postgres' then
    raise exception 'CH-007E preflight failed: owner must be postgres, found %', v_owner;
  end if;

  if v_config not like '%search_path%pg_catalog%public%' then
    raise exception 'CH-007E preflight failed: search_path must be pg_catalog, public';
  end if;

  if position('CH-007D-INFRA-001' in v_def) = 0 then
    raise exception
      'CH-007E preflight failed: live function is not CH-007D-INFRA-001';
  end if;

  if position('MG_ERR:items_required' in v_def) = 0 then
    raise exception
      'CH-007E preflight failed: items_required missing from live function';
  end if;

  if position('MG_ERR:schedule_total_mismatch' in v_def) = 0 then
    raise exception
      'CH-007E preflight failed: schedule_total_mismatch missing from live function';
  end if;

  if position(
       'delete from public.project_contract_payment_schedule_items' in v_def
     ) = 0 then
    raise exception
      'CH-007E preflight failed: DELETE of project_contract_payment_schedule_items missing';
  end if;

  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'project_contract_payment_schedule_items'
      and column_name = 'item_role'
  )
  into v_has_item_role;

  if v_has_item_role is not true then
    raise exception
      'CH-007E preflight failed: project_contract_payment_schedule_items.item_role is missing';
  end if;
end;
$preflight$;

create or replace function public.replace_project_contract_payment_schedule(
  p_tenant_id uuid,
  p_project_id uuid,
  p_quote_id uuid,
  p_contract_total numeric,
  p_currency text,
  p_confirm_schedule boolean,
  p_items jsonb,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
SET search_path TO pg_catalog, public
as $$
declare
  v_project record;
  v_quote record;
  v_auth_total numeric(14,2);
  v_currency text;
  v_total_source text;
  v_schedule public.project_contract_payment_schedules%rowtype;
  v_item jsonb;
  v_idx integer := 0;
  v_seq integer;
  v_label text;
  v_payment_type text;
  v_amount numeric(14,2);
  v_due_rule text;
  v_milestone text;
  v_fixed_due_date date;
  v_item_role text;
  v_percentage numeric(7,4);
  v_seen_sequences int[] := array[]::int[];
  v_scheduled_total numeric(14,2) := 0;
  v_status text;
  v_confirmed_at timestamptz;
  v_now timestamptz := now();
  v_items_out jsonb := '[]'::jsonb;
  v_item_count integer := 0;
  v_readiness_status text;
  v_row_count integer := 0;
  v_item_row jsonb;
  v_allowed_item_keys text[] := array[
    'sequence_number',
    'label',
    'payment_type',
    'amount',
    'due_rule',
    'milestone_description',
    'fixed_due_date',
    'item_role'
  ];
begin
  if p_tenant_id is null or p_project_id is null or p_quote_id is null then
    raise exception 'MG_ERR:invalid_id:project_id and quote_id are required';
  end if;

  if p_confirm_schedule is null then
    raise exception 'MG_ERR:invalid_confirmation:confirm_schedule must be a boolean';
  end if;

  perform pg_advisory_xact_lock(
    hashtext(
      p_tenant_id::text || ':' || p_project_id::text || ':' || p_quote_id::text
    )
  );

  if not exists (
    select 1
    from public.tenants t
    where t.id = p_tenant_id
  ) then
    raise exception 'MG_ERR:schedule_unavailable:Project payment schedule unavailable';
  end if;

  select tp.id, tp.quote_id, tp.sale_price
  into v_project
  from public.tenant_projects tp
  where tp.id = p_project_id
    and tp.tenant_id = p_tenant_id
  limit 1;

  if v_project.id is null then
    raise exception 'MG_ERR:schedule_unavailable:Project payment schedule unavailable';
  end if;

  if v_project.quote_id is null
     or v_project.quote_id is distinct from p_quote_id then
    raise exception 'MG_ERR:project_quote_mismatch:Quote does not belong to this project';
  end if;

  select q.id, q.total, q.currency, q.status
  into v_quote
  from public.quotes q
  where q.id = p_quote_id
    and q.tenant_id = p_tenant_id
  limit 1;

  if v_quote.id is null then
    raise exception 'MG_ERR:schedule_unavailable:Project payment schedule unavailable';
  end if;

  if v_project.sale_price is not null and v_project.sale_price > 0 then
    v_auth_total := round(v_project.sale_price::numeric, 2);
    v_total_source := 'tenant_projects.sale_price';
  elsif lower(coalesce(v_quote.status, '')) in ('accepted', 'approved')
        and v_quote.total is not null
        and v_quote.total > 0 then
    v_auth_total := round(v_quote.total::numeric, 2);
    v_total_source := 'approved_quote.total';
  else
    raise exception 'MG_ERR:contract_total_unavailable:Authoritative contract total is unavailable';
  end if;

  if p_contract_total is null
     or round(p_contract_total::numeric, 2) is distinct from v_auth_total then
    raise exception 'MG_ERR:contract_total_changed:Authoritative contract total changed. Reload before saving.';
  end if;

  v_currency := left(nullif(btrim(coalesce(v_quote.currency, '')), ''), 12);
  if v_currency is null or v_currency = '' then
    v_currency := 'USD';
  end if;
  if left(nullif(btrim(coalesce(p_currency, '')), ''), 12) is distinct from v_currency then
    raise exception 'MG_ERR:currency_mismatch:Currency does not match the authoritative quote currency';
  end if;

  select *
  into v_schedule
  from public.project_contract_payment_schedules s
  where s.tenant_id = p_tenant_id
    and s.project_id = p_project_id
    and s.quote_id = p_quote_id
  limit 1;

  -- CH-007E-CONFIRM-BEGIN
  -- Payment Terms confirm stamps the header only. Ignore posted payload items.
  -- Never raise item-count or sum-equality gates on this path.
  -- Never delete, insert, or replace payment schedule items.
  if p_confirm_schedule then
    if v_schedule.id is null then
      if p_expected_updated_at is not null then
        raise exception 'MG_ERR:schedule_version_conflict:This payment schedule changed in another session. Reload before saving.';
      end if;
      insert into public.project_contract_payment_schedules (
        tenant_id,
        project_id,
        quote_id,
        currency,
        contract_total,
        status,
        confirmed_at,
        created_at,
        updated_at
      )
      values (
        p_tenant_id,
        p_project_id,
        p_quote_id,
        v_currency,
        v_auth_total,
        'confirmed',
        v_now,
        v_now,
        v_now
      )
      returning * into v_schedule;
    elsif v_schedule.status = 'confirmed'
      and v_schedule.confirmed_at is not null then
      null;
    else
      if p_expected_updated_at is null
         or p_expected_updated_at is distinct from v_schedule.updated_at then
        raise exception 'MG_ERR:schedule_version_conflict:This payment schedule changed in another session. Reload before saving.';
      end if;
      update public.project_contract_payment_schedules s
      set
        currency = v_currency,
        contract_total = v_auth_total,
        status = 'confirmed',
        confirmed_at = v_now,
        updated_at = v_now
      where s.id = v_schedule.id
        and s.tenant_id = p_tenant_id
      returning * into v_schedule;

      get diagnostics v_row_count = row_count;
      if v_row_count <> 1 then
        raise exception 'MG_ERR:save_failed:Payment schedule save failed';
      end if;
    end if;

    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', i.id,
          'sequence_number', i.sequence_number,
          'label', i.label,
          'payment_type', i.payment_type,
          'amount', i.amount,
          'percentage', i.percentage,
          'due_rule', i.due_rule,
          'milestone_description', i.milestone_description,
          'fixed_due_date', i.fixed_due_date,
          'item_role', i.item_role
        )
        order by i.sequence_number
      ),
      '[]'::jsonb
    )
    into v_items_out
    from public.project_contract_payment_schedule_items i
    where i.tenant_id = p_tenant_id
      and i.schedule_id = v_schedule.id;

    select coalesce(sum(i.amount), 0), count(*)::integer
    into v_scheduled_total, v_item_count
    from public.project_contract_payment_schedule_items i
    where i.tenant_id = p_tenant_id
      and i.schedule_id = v_schedule.id;

    return jsonb_build_object(
      'schedule', jsonb_build_object(
        'id', v_schedule.id,
        'tenant_id', v_schedule.tenant_id,
        'project_id', v_schedule.project_id,
        'quote_id', v_schedule.quote_id,
        'currency', v_schedule.currency,
        'contract_total', v_schedule.contract_total,
        'status', v_schedule.status,
        'confirmed_at', v_schedule.confirmed_at,
        'created_at', v_schedule.created_at,
        'updated_at', v_schedule.updated_at
      ),
      'items', v_items_out,
      'readiness', jsonb_build_object(
        'status', 'configured',
        'contract_total', v_auth_total,
        'scheduled_total', v_scheduled_total,
        'remaining_difference', (v_auth_total - v_scheduled_total),
        'item_count', v_item_count,
        'confirmed_at', v_schedule.confirmed_at
      ),
      'source', jsonb_build_object(
        'contract_total_source', v_total_source,
        'currency', v_currency
      )
    );
  end if;
  -- CH-007E-CONFIRM-END

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'MG_ERR:invalid_items:items must be a JSON array';
  end if;

  if v_schedule.id is null then
    if p_expected_updated_at is not null then
      raise exception 'MG_ERR:schedule_version_conflict:This payment schedule changed in another session. Reload before saving.';
    end if;
  else
    if p_expected_updated_at is null
       or p_expected_updated_at is distinct from v_schedule.updated_at then
      raise exception 'MG_ERR:schedule_version_conflict:This payment schedule changed in another session. Reload before saving.';
    end if;
  end if;

  for v_item in
    select value
    from jsonb_array_elements(p_items) as t(value)
  loop
    v_idx := v_idx + 1;
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'MG_ERR:invalid_item:items[%] must be an object', v_idx - 1;
    end if;

    if exists (
      select 1
      from jsonb_object_keys(v_item) as k
      where not (k = any (v_allowed_item_keys))
    ) then
      raise exception 'MG_ERR:unknown_item_fields:Unknown item fields rejected';
    end if;

    begin
      v_seq := (v_item ->> 'sequence_number')::integer;
    exception
      when others then
        raise exception 'MG_ERR:invalid_sequence:sequence_number must be an integer >= 1';
    end;
    if v_seq is null or v_seq < 1 then
      raise exception 'MG_ERR:invalid_sequence:sequence_number must be an integer >= 1';
    end if;
    if v_seq = any (v_seen_sequences) then
      raise exception 'MG_ERR:duplicate_sequence:Duplicate sequence_number';
    end if;
    v_seen_sequences := array_append(v_seen_sequences, v_seq);

    v_label := coalesce(btrim(v_item ->> 'label'), '');
    if char_length(v_label) > 160 then
      raise exception 'MG_ERR:invalid_label:label exceeds 160 characters';
    end if;

    v_payment_type := lower(btrim(coalesce(v_item ->> 'payment_type', '')));
    if v_payment_type not in (
      'deposit', 'start', 'progress', 'material', 'completion', 'final', 'custom'
    ) then
      raise exception 'MG_ERR:invalid_enum:Invalid payment_type';
    end if;

    begin
      v_amount := round((v_item ->> 'amount')::numeric, 2);
    exception
      when others then
        raise exception 'MG_ERR:invalid_amount:amount must be a non-negative amount with up to 2 decimals';
    end;
    if v_amount is null or v_amount < 0 then
      raise exception 'MG_ERR:invalid_amount:amount must be a non-negative amount with up to 2 decimals';
    end if;

    v_due_rule := lower(btrim(coalesce(v_item ->> 'due_rule', '')));
    if v_due_rule not in (
      'on_signature', 'before_start', 'on_start', 'milestone',
      'on_completion', 'fixed_date', 'custom'
    ) then
      raise exception 'MG_ERR:invalid_enum:Invalid due_rule';
    end if;

    v_milestone := coalesce(btrim(v_item ->> 'milestone_description'), '');
    if char_length(v_milestone) > 1000 then
      raise exception 'MG_ERR:invalid_milestone:milestone_description exceeds 1000 characters';
    end if;

    if v_item ? 'fixed_due_date'
       and nullif(btrim(v_item ->> 'fixed_due_date'), '') is not null then
      begin
        v_fixed_due_date := (btrim(v_item ->> 'fixed_due_date'))::date;
      exception
        when others then
          raise exception 'MG_ERR:invalid_fixed_due_date:fixed_due_date must be YYYY-MM-DD';
      end;
    else
      v_fixed_due_date := null;
    end if;

    if v_due_rule = 'fixed_date' and v_fixed_due_date is null then
      raise exception 'MG_ERR:fixed_date_required:fixed_due_date is required for fixed_date due_rule';
    end if;
    if v_due_rule <> 'fixed_date' and v_fixed_due_date is not null then
      raise exception 'MG_ERR:fixed_date_not_allowed:fixed_due_date must be null unless due_rule is fixed_date';
    end if;

    -- CH-007D-INFRA-001: missing/blank item_role defaults to future_obligation
    if not (v_item ? 'item_role')
       or nullif(btrim(coalesce(v_item ->> 'item_role', '')), '') is null then
      v_item_role := 'future_obligation';
    else
      v_item_role := lower(btrim(v_item ->> 'item_role'));
      if v_item_role not in ('future_obligation', 'applied_payment') then
        raise exception 'MG_ERR:invalid_enum:Invalid item_role';
      end if;
    end if;

    v_scheduled_total := v_scheduled_total + v_amount;
  end loop;

  v_item_count := coalesce(jsonb_array_length(p_items), 0);

  if p_confirm_schedule and v_item_count < 1 then
    raise exception 'MG_ERR:items_required:At least one payment stage is required to confirm a schedule';
  end if;

  if p_confirm_schedule and v_scheduled_total is distinct from v_auth_total then
    raise exception 'MG_ERR:schedule_total_mismatch:Payment schedule total must equal the contract total before confirmation';
  end if;

  if p_confirm_schedule and v_scheduled_total = v_auth_total and v_item_count > 0 then
    v_status := 'confirmed';
    v_confirmed_at := v_now;
  else
    v_status := 'draft';
    v_confirmed_at := null;
  end if;

  if v_schedule.id is null then
    insert into public.project_contract_payment_schedules (
      tenant_id,
      project_id,
      quote_id,
      currency,
      contract_total,
      status,
      confirmed_at,
      created_at,
      updated_at
    )
    values (
      p_tenant_id,
      p_project_id,
      p_quote_id,
      v_currency,
      v_auth_total,
      v_status,
      v_confirmed_at,
      v_now,
      v_now
    )
    returning * into v_schedule;
  else
    update public.project_contract_payment_schedules s
    set
      currency = v_currency,
      contract_total = v_auth_total,
      status = v_status,
      confirmed_at = v_confirmed_at,
      updated_at = v_now
    where s.id = v_schedule.id
      and s.tenant_id = p_tenant_id
    returning * into v_schedule;

    get diagnostics v_row_count = row_count;
    if v_row_count <> 1 then
      raise exception 'MG_ERR:save_failed:Payment schedule save failed';
    end if;
  end if;

  delete from public.project_contract_payment_schedule_items i
  where i.tenant_id = p_tenant_id
    and i.schedule_id = v_schedule.id;

  for v_item in
    select t.value
    from jsonb_array_elements(p_items) as t(value)
    order by (t.value ->> 'sequence_number')::integer
  loop
    v_seq := (v_item ->> 'sequence_number')::integer;
    v_label := coalesce(btrim(v_item ->> 'label'), '');
    v_payment_type := lower(btrim(coalesce(v_item ->> 'payment_type', '')));
    v_amount := round((v_item ->> 'amount')::numeric, 2);
    v_due_rule := lower(btrim(coalesce(v_item ->> 'due_rule', '')));
    v_milestone := coalesce(btrim(v_item ->> 'milestone_description'), '');
    if v_item ? 'fixed_due_date'
       and nullif(btrim(v_item ->> 'fixed_due_date'), '') is not null then
      v_fixed_due_date := (btrim(v_item ->> 'fixed_due_date'))::date;
    else
      v_fixed_due_date := null;
    end if;

    if not (v_item ? 'item_role')
       or nullif(btrim(coalesce(v_item ->> 'item_role', '')), '') is null then
      v_item_role := 'future_obligation';
    else
      v_item_role := lower(btrim(v_item ->> 'item_role'));
    end if;

    if v_auth_total > 0 then
      v_percentage := round((v_amount * 100) / v_auth_total, 4);
    else
      v_percentage := null;
    end if;

    insert into public.project_contract_payment_schedule_items (
      tenant_id,
      schedule_id,
      sequence_number,
      label,
      payment_type,
      amount,
      percentage,
      due_rule,
      milestone_description,
      fixed_due_date,
      item_role,
      created_at,
      updated_at
    )
    values (
      p_tenant_id,
      v_schedule.id,
      v_seq,
      v_label,
      v_payment_type,
      v_amount,
      v_percentage,
      v_due_rule,
      v_milestone,
      v_fixed_due_date,
      v_item_role,
      v_now,
      v_now
    )
    returning jsonb_build_object(
      'id', id,
      'sequence_number', sequence_number,
      'label', label,
      'payment_type', payment_type,
      'amount', amount,
      'percentage', percentage,
      'due_rule', due_rule,
      'milestone_description', milestone_description,
      'fixed_due_date', fixed_due_date,
      'item_role', item_role
    ) into v_item_row;

    v_items_out := v_items_out || jsonb_build_array(v_item_row);
  end loop;

  select coalesce(sum(i.amount), 0), count(*)::integer
  into v_scheduled_total, v_item_count
  from public.project_contract_payment_schedule_items i
  where i.tenant_id = p_tenant_id
    and i.schedule_id = v_schedule.id;

  if v_status = 'confirmed'
     and (
       v_item_count < 1
       or v_scheduled_total is distinct from v_auth_total
       or v_confirmed_at is null
     ) then
    raise exception 'MG_ERR:schedule_total_mismatch:Payment schedule total must equal the contract total before confirmation';
  end if;

  if v_status = 'confirmed' then
    v_readiness_status := 'configured';
  else
    v_readiness_status := 'draft';
  end if;

  return jsonb_build_object(
    'schedule', jsonb_build_object(
      'id', v_schedule.id,
      'tenant_id', v_schedule.tenant_id,
      'project_id', v_schedule.project_id,
      'quote_id', v_schedule.quote_id,
      'currency', v_schedule.currency,
      'contract_total', v_schedule.contract_total,
      'status', v_schedule.status,
      'confirmed_at', v_schedule.confirmed_at,
      'created_at', v_schedule.created_at,
      'updated_at', v_schedule.updated_at
    ),
    'items', v_items_out,
    'readiness', jsonb_build_object(
      'status', v_readiness_status,
      'contract_total', v_auth_total,
      'scheduled_total', v_scheduled_total,
      'remaining_difference', (v_auth_total - v_scheduled_total),
      'item_count', v_item_count,
      'confirmed_at', v_schedule.confirmed_at
    ),
    'source', jsonb_build_object(
      'contract_total_source', v_total_source,
      'currency', v_currency
    )
  );
end;
$$;

comment on function public.replace_project_contract_payment_schedule(
  uuid, uuid, uuid, numeric, text, boolean, jsonb, timestamptz
) is
  'CH-007E: confirm_schedule stamps Payment Terms without replacing items or requiring item sum. Draft path remains CH-007D replace-items. Service-role only.';

alter function public.replace_project_contract_payment_schedule(
  uuid, uuid, uuid, numeric, text, boolean, jsonb, timestamptz
) owner to postgres;

revoke all on function public.replace_project_contract_payment_schedule(
  uuid, uuid, uuid, numeric, text, boolean, jsonb, timestamptz
) from public;

revoke all on function public.replace_project_contract_payment_schedule(
  uuid, uuid, uuid, numeric, text, boolean, jsonb, timestamptz
) from anon;

revoke all on function public.replace_project_contract_payment_schedule(
  uuid, uuid, uuid, numeric, text, boolean, jsonb, timestamptz
) from authenticated;

grant execute on function public.replace_project_contract_payment_schedule(
  uuid, uuid, uuid, numeric, text, boolean, jsonb, timestamptz
) to service_role;

do $postflight$
declare
  v_count integer;
  v_args text;
  v_def text;
  v_slice text;
  v_security boolean;
  v_owner text;
  v_config text;
  v_grantees text[];
  v_confirm_pos integer;
  v_delete_pos integer;
  v_end_pos integer;
begin
  select count(*)
  into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'replace_project_contract_payment_schedule';

  if v_count is distinct from 1 then
    raise exception
      'CH-007E postflight failed: expected exactly one function, found %',
      v_count;
  end if;

  select
    oidvectortypes(p.proargtypes),
    pg_get_functiondef(p.oid),
    p.prosecdef,
    pg_get_userbyid(p.proowner),
    array_to_string(coalesce(p.proconfig, array[]::text[]), ' ')
  into v_args, v_def, v_security, v_owner, v_config
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'replace_project_contract_payment_schedule';

  if v_args is distinct from
     'uuid, uuid, uuid, numeric, text, boolean, jsonb, timestamp with time zone'
  then
    raise exception
      'CH-007E postflight failed: unexpected signature (%)',
      v_args;
  end if;

  if position('CH-007E' in v_def) = 0
     or position('CH-007E-CONFIRM-BEGIN' in v_def) = 0
     or position('CH-007E-CONFIRM-END' in v_def) = 0 then
    raise exception 'CH-007E postflight failed: CH-007E markers missing';
  end if;

  v_confirm_pos := position('CH-007E-CONFIRM-BEGIN' in v_def);
  v_delete_pos := position(
    'delete from public.project_contract_payment_schedule_items' in v_def
  );
  if v_confirm_pos = 0 then
    raise exception 'CH-007E postflight failed: CH-007E-CONFIRM-BEGIN missing';
  end if;
  if v_delete_pos = 0 or v_confirm_pos >= v_delete_pos then
    raise exception
      'CH-007E postflight failed: confirm branch must appear before DELETE of items';
  end if;

  v_end_pos := position('CH-007E-CONFIRM-END' in v_def);
  if v_end_pos = 0 or v_end_pos <= v_confirm_pos then
    raise exception 'CH-007E postflight failed: CH-007E-CONFIRM-END missing or out of order';
  end if;
  v_slice := substring(
    v_def
    from v_confirm_pos
    for (v_end_pos + char_length('CH-007E-CONFIRM-END') - v_confirm_pos)
  );
  if v_slice is null or v_slice = '' then
    raise exception 'CH-007E postflight failed: confirm slice empty';
  end if;
  if position('p_items' in v_slice) > 0 then
    raise exception 'CH-007E postflight failed: confirm branch references p_items';
  end if;
  if position('jsonb_array_elements' in v_slice) > 0 then
    raise exception 'CH-007E postflight failed: confirm branch iterates items';
  end if;
  if position('MG_ERR:invalid_items' in v_slice) > 0 then
    raise exception 'CH-007E postflight failed: confirm branch still validates items';
  end if;
  if position('MG_ERR:invalid_items' in v_def) = 0
     or position('MG_ERR:invalid_items' in v_def) < v_end_pos then
    raise exception
      'CH-007E postflight failed: invalid_items must remain only on the draft path';
  end if;
  if position('items_required' in v_slice) > 0 then
    raise exception
      'CH-007E postflight failed: confirm branch still contains items_required';
  end if;
  if position('schedule_total_mismatch' in v_slice) > 0 then
    raise exception
      'CH-007E postflight failed: confirm branch still contains schedule_total_mismatch';
  end if;
  if position(
       'delete from public.project_contract_payment_schedule_items' in v_slice
     ) > 0
     or position(
       'insert into public.project_contract_payment_schedule_items' in v_slice
     ) > 0 then
    raise exception
      'CH-007E postflight failed: confirm branch mutates payment schedule items';
  end if;

  if v_security is not true then
    raise exception 'CH-007E postflight failed: SECURITY DEFINER required';
  end if;

  if v_owner is distinct from 'postgres' then
    raise exception 'CH-007E postflight failed: owner must be postgres, found %', v_owner;
  end if;

  if v_config not like '%search_path%pg_catalog%public%' then
    raise exception 'CH-007E postflight failed: search_path must be pg_catalog, public';
  end if;

  select coalesce(array_agg(distinct rp.grantee::text order by rp.grantee::text), array[]::text[])
  into v_grantees
  from information_schema.routine_privileges rp
  where rp.specific_schema = 'public'
    and rp.routine_name = 'replace_project_contract_payment_schedule'
    and rp.privilege_type = 'EXECUTE';

  if not ('service_role' = any (v_grantees)) then
    raise exception 'CH-007E postflight failed: service_role EXECUTE missing';
  end if;
  if 'PUBLIC' = any (v_grantees)
     or 'anon' = any (v_grantees)
     or 'authenticated' = any (v_grantees) then
    raise exception
      'CH-007E postflight failed: PUBLIC/anon/authenticated still have EXECUTE (%)',
      v_grantees;
  end if;
  if exists (
    select 1
    from unnest(v_grantees) as g(grantee)
    where g.grantee not in ('service_role', 'postgres')
  ) then
    raise exception
      'CH-007E postflight failed: unexpected EXECUTE grantees (%)',
      v_grantees;
  end if;
end;
$postflight$;

commit;
