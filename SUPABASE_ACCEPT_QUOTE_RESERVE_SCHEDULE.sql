-- =============================================================================
-- Margin Guard | accept quote + reserve crew schedule (atomic)
-- =============================================================================
-- STATUS: MANUAL SUPABASE APPLY REQUIRED — do not run from CI, Netlify deploy,
-- or this PR. Do not apply to production until an explicit apply is authorized.
--
-- PURPOSE:
--   One service-role RPC that, in a single transaction:
--     1. advisory-locks the tenant
--     2. rejects overlapping active tenant_projects (same statuses as the calendar)
--     3. marks the quote accepted
--     4. inserts a signed tenant_projects row when none exists for that quote
--   Two near-simultaneous public accepts cannot both insert overlapping signed
--   projects. Dates are never rewritten.
--
-- Occupancy approximation inside SQL (race guard):
--   daterange(signed_at::date, due_date, inclusive) for statuses
--   signed | deposit_paid | assigned | in_progress.
--   The Netlify accept path ALSO runs the canonical JS calendar engine before
--   calling this RPC. SQL is the atomic last line of defense.
--
-- NOT IN THIS MIGRATION:
--   * changes to calendar ACTIVE_STATUSES
--   * holiday calendars
--   * remote data backfill
--   * browser EXECUTE grants
-- =============================================================================

create or replace function public.mg_accept_quote_reserving_schedule(
  p_tenant_id uuid,
  p_quote_id uuid,
  p_occupy_start date,
  p_occupy_end date,
  p_accepted_at timestamptz,
  p_project jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_quote public.quotes%rowtype;
  v_existing uuid;
  v_conflict uuid;
  v_new_id uuid;
  v_now timestamptz := coalesce(p_accepted_at, timezone('utc', now()));
  v_already boolean := false;
  v_contact uuid;
  v_signed_at timestamptz;
  v_due date;
  v_name text;
  v_client text;
  v_email text;
  v_days numeric;
  v_price numeric;
begin
  if p_tenant_id is null
     or p_quote_id is null
     or p_occupy_start is null
     or p_occupy_end is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  if p_occupy_end < p_occupy_start then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  perform pg_advisory_xact_lock(hashtext(p_tenant_id::text));

  select * into v_quote
  from public.quotes
  where id = p_quote_id
    and tenant_id = p_tenant_id
  limit 1;

  if v_quote.id is null then
    return jsonb_build_object('ok', false, 'code', 'quote_not_found');
  end if;

  v_already := lower(coalesce(v_quote.status, '')) in ('accepted', 'approved')
    or v_quote.accepted_at is not null;

  select p.id into v_existing
  from public.tenant_projects p
  where p.tenant_id = p_tenant_id
    and p.quote_id = p_quote_id
  limit 1;

  if v_existing is not null and v_already then
    return jsonb_build_object(
      'ok', true,
      'code', 'already_accepted',
      'already_accepted', true,
      'action', 'reuse',
      'project_id', v_existing
    );
  end if;

  select p.id into v_conflict
  from public.tenant_projects p
  where p.tenant_id = p_tenant_id
    and p.status in ('signed', 'deposit_paid', 'assigned', 'in_progress')
    and (v_existing is null or p.id <> v_existing)
    and p.quote_id is distinct from p_quote_id
    and daterange(
          coalesce((p.signed_at at time zone 'utc')::date, p.due_date),
          coalesce(p.due_date, (p.signed_at at time zone 'utc')::date),
          '[]'
        ) && daterange(p_occupy_start, p_occupy_end, '[]')
  limit 1;

  if v_conflict is not null then
    return jsonb_build_object(
      'ok', false,
      'code', 'schedule_conflict',
      'project_id', v_conflict
    );
  end if;

  if not v_already then
    update public.quotes
    set status = 'accepted',
        accepted_at = coalesce(accepted_at, v_now),
        updated_at = v_now
    where id = p_quote_id
      and tenant_id = p_tenant_id;
  end if;

  if v_existing is not null then
    return jsonb_build_object(
      'ok', true,
      'code', 'already_reserved',
      'already_accepted', v_already,
      'action', 'reuse',
      'project_id', v_existing
    );
  end if;

  v_contact := null;
  begin
    if coalesce(p_project->>'contact_id', '') <> '' then
      v_contact := (p_project->>'contact_id')::uuid;
    end if;
  exception
    when others then
      v_contact := null;
  end;
  v_signed_at := coalesce(
    nullif(p_project->>'signed_at', '')::timestamptz,
    (p_occupy_start::text || 'T12:00:00.000Z')::timestamptz,
    v_now
  );
  v_due := coalesce(nullif(p_project->>'due_date', '')::date, p_occupy_end);
  v_name := coalesce(nullif(p_project->>'project_name', ''), 'Project');
  v_client := coalesce(p_project->>'client_name', '');
  v_email := coalesce(p_project->>'client_email', '');
  v_days := coalesce(nullif(p_project->>'estimated_days', '')::numeric, 0);
  v_price := coalesce(nullif(p_project->>'sale_price', '')::numeric, 0);

  insert into public.tenant_projects (
    tenant_id,
    quote_id,
    contact_id,
    project_name,
    client_name,
    client_email,
    status,
    signed_at,
    deposit_paid,
    estimated_days,
    due_date,
    sale_price,
    recommended_price,
    minimum_price,
    notes,
    quoted_labor_plan,
    created_at,
    updated_at
  ) values (
    p_tenant_id,
    p_quote_id,
    v_contact,
    v_name,
    v_client,
    v_email,
    'signed',
    v_signed_at,
    false,
    v_days,
    v_due,
    v_price,
    coalesce(nullif(p_project->>'recommended_price', '')::numeric, v_price),
    coalesce(nullif(p_project->>'minimum_price', '')::numeric, v_price),
    '',
    '[]'::jsonb,
    v_now,
    v_now
  )
  returning id into v_new_id;

  return jsonb_build_object(
    'ok', true,
    'code', 'created',
    'already_accepted', v_already,
    'action', 'create',
    'project_id', v_new_id
  );
exception
  when unique_violation then
    select p.id into v_existing
    from public.tenant_projects p
    where p.tenant_id = p_tenant_id
      and p.quote_id = p_quote_id
    limit 1;
    if v_existing is not null then
      return jsonb_build_object(
        'ok', true,
        'code', 'already_reserved',
        'already_accepted', true,
        'action', 'race_reuse',
        'project_id', v_existing
      );
    end if;
    raise;
end;
$$;

comment on function public.mg_accept_quote_reserving_schedule(
  uuid, uuid, date, date, timestamptz, jsonb
) is
  'Atomic quote accept + signed project insert with tenant schedule lock. Service-role only. Do not apply until authorized.';

revoke all on function public.mg_accept_quote_reserving_schedule(
  uuid, uuid, date, date, timestamptz, jsonb
) from public;

revoke execute on function public.mg_accept_quote_reserving_schedule(
  uuid, uuid, date, date, timestamptz, jsonb
) from public;

revoke execute on function public.mg_accept_quote_reserving_schedule(
  uuid, uuid, date, date, timestamptz, jsonb
) from anon;

revoke execute on function public.mg_accept_quote_reserving_schedule(
  uuid, uuid, date, date, timestamptz, jsonb
) from authenticated;

grant execute on function public.mg_accept_quote_reserving_schedule(
  uuid, uuid, date, date, timestamptz, jsonb
) to service_role;
