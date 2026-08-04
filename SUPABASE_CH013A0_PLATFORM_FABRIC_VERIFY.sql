-- =============================================================================
-- Margin Guard | CH-013A.0 — Platform Fabric VERIFY (transactional + structural)
-- =============================================================================
-- Run after SUPABASE_CH013A0_PLATFORM_FABRIC.sql
-- Uses BEGIN/ROLLBACK so append-only tables are not left with verify rows.
-- =============================================================================

begin;

do $$
declare
  v_tenant uuid;
  v_event uuid;
  v_corr text := 'MG-EVT-ABCDEF12';
  v_notif uuid;
begin
  if to_regclass('public.platform_domain_event_outbox') is null then
    raise exception 'VERIFY FAIL: platform_domain_event_outbox missing';
  end if;
  if to_regclass('public.platform_activity_events') is null then
    raise exception 'VERIFY FAIL: platform_activity_events missing';
  end if;
  if to_regclass('public.platform_notifications') is null then
    raise exception 'VERIFY FAIL: platform_notifications missing';
  end if;

  select id into v_tenant from public.tenants order by id limit 1;
  if v_tenant is null then
    raise exception 'VERIFY FAIL: no tenants row';
  end if;

  insert into public.platform_domain_event_outbox (
    tenant_id, project_id, quote_id, aggregate, aggregate_id,
    type, occurred_at, correlation_id, causation_id, payload,
    idempotency_key, event_version
  ) values (
    v_tenant, null, null, 'package', null,
    'contract.package.frozen', timezone('utc', now()), v_corr, null,
    '{"schema":"ch-013a0-v1"}'::jsonb,
    'verify:ch013a0:outbox:1', 1
  )
  returning event_id into v_event;

  -- idempotent conflict expected on duplicate key
  begin
    insert into public.platform_domain_event_outbox (
      tenant_id, aggregate, type, correlation_id, payload, idempotency_key
    ) values (
      v_tenant, 'package', 'contract.package.frozen', v_corr,
      '{}'::jsonb, 'verify:ch013a0:outbox:1'
    );
    raise exception 'VERIFY FAIL: outbox idempotency unique missing';
  exception
    when unique_violation then
      null;
  end;

  -- append-only update must fail
  begin
    update public.platform_domain_event_outbox
      set type = 'x'
    where event_id = v_event;
    raise exception 'VERIFY FAIL: outbox UPDATE should be blocked';
  exception
    when others then
      if SQLERRM not like '%append-only%' then
        raise;
      end if;
  end;

  -- append-only delete must fail
  begin
    delete from public.platform_domain_event_outbox
    where event_id = v_event;
    raise exception 'VERIFY FAIL: outbox DELETE should be blocked';
  exception
    when others then
      if SQLERRM not like '%append-only%' then
        raise;
      end if;
  end;

  -- correlation format check
  begin
    insert into public.platform_domain_event_outbox (
      tenant_id, aggregate, type, correlation_id, payload, idempotency_key
    ) values (
      v_tenant, 'package', 'contract.package.frozen', 'BAD-CORR',
      '{}'::jsonb, 'verify:ch013a0:outbox:bad-corr'
    );
    raise exception 'VERIFY FAIL: correlation_id format check missing';
  exception
    when check_violation then
      null;
  end;

  insert into public.platform_activity_events (
    tenant_id, source_event_id, event_type, occurred_at, correlation_id,
    title, summary, payload
  ) values (
    v_tenant, v_event, 'contract.package.frozen', timezone('utc', now()), v_corr,
    '', '', '{}'::jsonb
  );

  -- activity immutable: UPDATE must fail
  begin
    update public.platform_activity_events
      set title = 'mutated'
    where source_event_id = v_event;
    raise exception 'VERIFY FAIL: activity UPDATE should be blocked';
  exception
    when others then
      if SQLERRM not like '%immutable%' then
        raise;
      end if;
  end;

  -- activity immutable: DELETE must fail
  begin
    delete from public.platform_activity_events
    where source_event_id = v_event;
    raise exception 'VERIFY FAIL: activity DELETE should be blocked';
  exception
    when others then
      if SQLERRM not like '%immutable%' then
        raise;
      end if;
  end;

  insert into public.platform_notifications (
    tenant_id, source_event_id, event_type, priority, title, body,
    correlation_id, occurred_at, payload
  ) values (
    v_tenant, v_event, 'contract.package.frozen', 'normal', '', '',
    v_corr, timezone('utc', now()), '{}'::jsonb
  )
  returning id into v_notif;

  update public.platform_notifications
    set read_at = timezone('utc', now())
  where id = v_notif;

  update public.platform_notifications
    set dismissed_at = timezone('utc', now())
  where id = v_notif;

  -- bad priority must fail
  begin
    insert into public.platform_notifications (
      tenant_id, priority, title, body
    ) values (
      v_tenant, 'urgent', '', ''
    );
    raise exception 'VERIFY FAIL: priority check missing';
  exception
    when check_violation then
      null;
  end;

  if (
    select event_version from public.platform_domain_event_outbox where event_id = v_event
  ) is distinct from 1 then
    raise exception 'VERIFY FAIL: event_version must be 1';
  end if;

  raise notice 'VERIFY PASS: CH-013A.0 platform fabric tables + append-only + projections';
end $$;

rollback;

-- Structural presence check (no mutation)
select
  c.relname as table_name,
  true as present
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relname in (
    'platform_domain_event_outbox',
    'platform_activity_events',
    'platform_notifications'
  )
order by 1;
