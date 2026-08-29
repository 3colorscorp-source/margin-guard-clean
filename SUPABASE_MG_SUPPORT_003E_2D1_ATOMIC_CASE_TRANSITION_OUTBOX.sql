-- =============================================================================
-- Margin Guard | MG-SUPPORT-003E.2D1 — atomic case transition + outbox enqueue
-- =============================================================================
-- STATUS: MANUAL SUPABASE APPLY REQUIRED — do not run from CI or auto-deploy.
-- D1 is LOCAL ONLY until a later confirmed apply. Do not apply with this phase.
--
-- PURPOSE:
--   One service-role RPC that commits a real Support Admin lifecycle transition
--   and, when mapped, one pending notification-outbox row in the SAME transaction.
--   No email. No Zapier. No recipient lookup. No historical backfill.
--   Kill switch SUPPORT_CASE_EMAIL_DELIVERY_ENABLED does not suppress enqueue.
--   RELEASE RULE: inspect every pending outbox row created while delivery is OFF
--   before setting SUPPORT_CASE_EMAIL_DELIVERY_ENABLED=true.
--
-- NOT IN THIS MIGRATION:
--   * delivery / claim / HMAC / Zapier / scheduled sweepers
--   * changes to E2.A tables, status CHECKs, or existing rows
--   * browser EXECUTE grants
--
-- DEPENDENCIES:
--   REQUIRED: public.tenant_support_cases (MG-SUPPORT-003E.2A)
--   REQUIRED: public.tenant_support_notification_outbox (MG-SUPPORT-003E.2A)
-- =============================================================================

create or replace function public.mg_support_transition_case(
  p_case_id uuid,
  p_expected_status text,
  p_expected_status_version integer,
  p_action text,
  p_customer_resolution text default null,
  p_has_customer_resolution boolean default false,
  p_tenant_action_message text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_to_status text;
  v_event_type text;
  v_from_ok boolean := false;
  v_now timestamptz := timezone('utc', now());
  v_msg text;
  v_updated public.tenant_support_cases%rowtype;
  v_event_id uuid;
  v_current public.tenant_support_cases%rowtype;
begin
  if p_case_id is null
     or p_expected_status is null
     or p_expected_status_version is null
     or p_expected_status_version < 1
     or p_action is null then
    return jsonb_build_object(
      'result_code', 'invalid_request',
      'case_id', p_case_id,
      'status', null,
      'status_version', null,
      'event_queued', false,
      'event_id', null
    );
  end if;

  if p_action = 'mark_in_review' then
    v_to_status := 'in_review';
    v_event_type := 'case_in_review';
    v_from_ok := p_expected_status in ('open', 'waiting_on_customer', 'resolved');
  elsif p_action = 'request_customer_action' then
    v_to_status := 'waiting_on_customer';
    v_event_type := 'case_waiting_on_customer';
    v_from_ok := p_expected_status in ('open', 'in_review');
  elsif p_action = 'resolve' then
    v_to_status := 'resolved';
    v_event_type := 'case_resolved';
    v_from_ok := p_expected_status in ('open', 'in_review', 'waiting_on_customer');
  elsif p_action = 'reopen' then
    v_to_status := 'open';
    v_event_type := 'case_reopened';
    v_from_ok := p_expected_status = 'resolved';
  elsif p_action = 'return_to_open' then
    v_to_status := 'open';
    v_event_type := null;
    v_from_ok := p_expected_status = 'in_review';
  else
    return jsonb_build_object(
      'result_code', 'invalid_request',
      'case_id', p_case_id,
      'status', null,
      'status_version', null,
      'event_queued', false,
      'event_id', null
    );
  end if;

  if p_expected_status = v_to_status then
    select * into v_current
    from public.tenant_support_cases
    where id = p_case_id;
    return jsonb_build_object(
      'result_code', 'already_target_state',
      'case_id', p_case_id,
      'status', coalesce(v_current.status, p_expected_status),
      'status_version', coalesce(v_current.status_version, p_expected_status_version),
      'resolved_at', v_current.resolved_at,
      'updated_at', v_current.updated_at,
      'customer_resolution', v_current.customer_resolution,
      'tenant_action_message', v_current.tenant_action_message,
      'event_queued', false,
      'event_id', null
    );
  end if;

  if not v_from_ok then
    return jsonb_build_object(
      'result_code', 'invalid_transition',
      'case_id', p_case_id,
      'status', p_expected_status,
      'status_version', p_expected_status_version,
      'event_queued', false,
      'event_id', null
    );
  end if;

  if p_action = 'request_customer_action' then
    v_msg := btrim(coalesce(p_tenant_action_message, ''));
    if v_msg = '' or char_length(v_msg) > 400 then
      return jsonb_build_object(
        'result_code', 'invalid_request',
        'case_id', p_case_id,
        'status', p_expected_status,
        'status_version', p_expected_status_version,
        'event_queued', false,
        'event_id', null
      );
    end if;
  end if;

  if p_action = 'resolve' and p_has_customer_resolution is true then
    if p_customer_resolution is null
       or btrim(p_customer_resolution) = ''
       or char_length(p_customer_resolution) > 400 then
      return jsonb_build_object(
        'result_code', 'invalid_request',
        'case_id', p_case_id,
        'status', p_expected_status,
        'status_version', p_expected_status_version,
        'event_queued', false,
        'event_id', null
      );
    end if;
  end if;

  update public.tenant_support_cases as c
     set status = v_to_status,
         status_version = c.status_version + 1,
         updated_at = v_now,
         tenant_action_message = case
           when p_action = 'request_customer_action' then v_msg
           else null
         end,
         resolved_at = case
           when p_action = 'resolve' then v_now
           else null
         end,
         customer_resolution = case
           when p_action = 'resolve' and p_has_customer_resolution is true
             then p_customer_resolution
           else c.customer_resolution
         end
   where c.id = p_case_id
     and c.status = p_expected_status
     and c.status_version = p_expected_status_version
  returning * into v_updated;

  if not found then
    select * into v_current
    from public.tenant_support_cases
    where id = p_case_id;
    if not found then
      return jsonb_build_object(
        'result_code', 'stale_state',
        'case_id', p_case_id,
        'status', null,
        'status_version', null,
        'event_queued', false,
        'event_id', null
      );
    end if;
    return jsonb_build_object(
      'result_code', 'stale_state',
      'case_id', v_current.id,
      'status', v_current.status,
      'status_version', v_current.status_version,
      'resolved_at', v_current.resolved_at,
      'updated_at', v_current.updated_at,
      'customer_resolution', v_current.customer_resolution,
      'tenant_action_message', v_current.tenant_action_message,
      'event_queued', false,
      'event_id', null
    );
  end if;

  if v_event_type is not null then
    insert into public.tenant_support_notification_outbox (
      tenant_id,
      case_id,
      event_type,
      from_status,
      to_status,
      case_status_version,
      payload_version,
      delivery_status,
      attempt_count
    )
    values (
      v_updated.tenant_id,
      v_updated.id,
      v_event_type,
      p_expected_status,
      v_updated.status,
      v_updated.status_version,
      1,
      'pending',
      0
    )
    on conflict (case_id, case_status_version, event_type)
    do nothing
    returning id into v_event_id;

    if v_event_id is null then
      select o.id
        into v_event_id
        from public.tenant_support_notification_outbox o
       where o.case_id = v_updated.id
         and o.case_status_version = v_updated.status_version
         and o.event_type = v_event_type;
    end if;
  end if;

  return jsonb_build_object(
    'result_code', 'transitioned',
    'case_id', v_updated.id,
    'status', v_updated.status,
    'status_version', v_updated.status_version,
    'resolved_at', v_updated.resolved_at,
    'updated_at', v_updated.updated_at,
    'customer_resolution', v_updated.customer_resolution,
    'tenant_action_message', v_updated.tenant_action_message,
    'event_queued', (v_event_type is not null),
    'event_id', v_event_id
  );
end;
$$;

comment on function public.mg_support_transition_case(
  uuid, text, integer, text, text, boolean, text
) is
  'MG-SUPPORT-003E.2D1 atomic Admin case transition + pending outbox enqueue. Service-role only. No email.';

revoke all on function public.mg_support_transition_case(
  uuid, text, integer, text, text, boolean, text
) from public;

revoke execute on function public.mg_support_transition_case(
  uuid, text, integer, text, text, boolean, text
) from public;

revoke execute on function public.mg_support_transition_case(
  uuid, text, integer, text, text, boolean, text
) from anon;

revoke execute on function public.mg_support_transition_case(
  uuid, text, integer, text, text, boolean, text
) from authenticated;

grant execute on function public.mg_support_transition_case(
  uuid, text, integer, text, text, boolean, text
) to service_role;
