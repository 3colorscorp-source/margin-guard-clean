-- =============================================================================
-- Margin Guard | MG-SUPPORT-003E.2A — case lifecycle + snapshot + outbox
-- =============================================================================
-- STATUS: MANUAL SUPABASE APPLY REQUIRED — do not run from CI or auto-deploy.
--
-- PURPOSE:
--   Additive database foundation for In Review / Waiting on You, tenant-visible
--   resolution and action text, versioned transitions, and a future Support
--   notification outbox. No application behavior. No email. No Zapier.
--   No live case status mutation.
--
-- NOT IN THIS MIGRATION:
--   * Support Admin / My Cases / chat product changes
--   * tenant_action_required column (derived in application later)
--   * internal_note
--   * recipient email / email body storage
--   * notification sends
--
-- DEPENDENCIES:
--   REQUIRED: public.tenants
--   REQUIRED: public.tenant_support_cases (MG-SUPPORT-003B / 003C)
-- =============================================================================

do $$
declare
  v_unexpected integer := 0;
begin
  if to_regclass('public.tenant_support_cases') is null then
    raise exception 'MG-SUPPORT-003E.2A blocked: public.tenant_support_cases missing';
  end if;

  select count(*)
    into v_unexpected
    from public.tenant_support_cases
   where status is distinct from 'open'
     and status is distinct from 'resolved';

  if v_unexpected > 0 then
    raise exception
      'MG-SUPPORT-003E.2A blocked: % case(s) have a status other than open/resolved',
      v_unexpected;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 1) Snapshot columns (existing rows keep NULL / status_version = 1)
-- ---------------------------------------------------------------------------
alter table public.tenant_support_cases
  add column if not exists customer_resolution text null;

alter table public.tenant_support_cases
  add column if not exists tenant_action_message text null;

alter table public.tenant_support_cases
  add column if not exists status_version integer not null default 1;

comment on column public.tenant_support_cases.customer_resolution is
  'MG-SUPPORT-003E.2A tenant-visible resolution text. Platform-admin authored later. Null until a useful update. Max 400.';

comment on column public.tenant_support_cases.tenant_action_message is
  'MG-SUPPORT-003E.2A tenant-visible waiting action text. Required when status is waiting_on_customer. Max 400.';

comment on column public.tenant_support_cases.status_version is
  'MG-SUPPORT-003E.2A monotonic transition version. Default 1. Used as notification idempotency input.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenant_support_cases'::regclass
      and conname = 'tenant_support_cases_customer_resolution_len_check'
  ) then
    alter table public.tenant_support_cases
      add constraint tenant_support_cases_customer_resolution_len_check
      check (char_length(customer_resolution) <= 400);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenant_support_cases'::regclass
      and conname = 'tenant_support_cases_tenant_action_message_len_check'
  ) then
    alter table public.tenant_support_cases
      add constraint tenant_support_cases_tenant_action_message_len_check
      check (char_length(tenant_action_message) <= 400);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenant_support_cases'::regclass
      and conname = 'tenant_support_cases_status_version_positive_check'
  ) then
    alter table public.tenant_support_cases
      add constraint tenant_support_cases_status_version_positive_check
      check (status_version >= 1);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2) Replace status CHECK: open | in_review | waiting_on_customer | resolved
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select conname
    from pg_constraint
    where conrelid = 'public.tenant_support_cases'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ~* '\mstatus\M'
      and pg_get_constraintdef(oid) ~* '\mopen\M'
      and pg_get_constraintdef(oid) ~* '\mresolved\M'
      and pg_get_constraintdef(oid) !~* 'in_review'
      and pg_get_constraintdef(oid) !~* 'waiting_on_customer'
  loop
    execute format(
      'alter table public.tenant_support_cases drop constraint %I',
      r.conname
    );
  end loop;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenant_support_cases'::regclass
      and conname = 'tenant_support_cases_status_check'
  ) then
    alter table public.tenant_support_cases
      add constraint tenant_support_cases_status_check
      check (status in ('open', 'in_review', 'waiting_on_customer', 'resolved'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenant_support_cases'::regclass
      and conname = 'tenant_support_cases_waiting_action_message_check'
  ) then
    alter table public.tenant_support_cases
      add constraint tenant_support_cases_waiting_action_message_check
      check (
        status <> 'waiting_on_customer'
        or (
          tenant_action_message is not null
          and char_length(trim(tenant_action_message)) >= 1
        )
      );
  end if;
end
$$;

-- Existing (tenant_id, status, created_at desc) index is preserved. No duplicate.

-- ---------------------------------------------------------------------------
-- 3) Notification outbox (empty; no events in E2.A)
-- ---------------------------------------------------------------------------
create table if not exists public.tenant_support_notification_outbox (
  id uuid primary key default gen_random_uuid(),

  tenant_id uuid not null
    references public.tenants (id) on delete restrict,

  case_id uuid not null
    references public.tenant_support_cases (id) on delete restrict,

  event_type text not null
    check (event_type in (
      'case_in_review',
      'case_waiting_on_customer',
      'case_resolved',
      'case_reopened'
    )),

  from_status text not null
    check (from_status in ('open', 'in_review', 'waiting_on_customer', 'resolved')),

  to_status text not null
    check (to_status in ('open', 'in_review', 'waiting_on_customer', 'resolved')),

  case_status_version integer not null
    check (case_status_version >= 1),

  payload_version integer not null default 1
    check (payload_version >= 1),

  delivery_status text not null default 'pending'
    check (delivery_status in (
      'pending',
      'claimed',
      'bridge_accepted',
      'submission_unknown',
      'failed'
    )),

  attempt_count integer not null default 0
    check (attempt_count >= 0),

  result_code text null
    check (result_code is null or char_length(result_code) <= 80),

  created_at timestamptz not null default timezone('utc', now()),
  claimed_at timestamptz null,
  processed_at timestamptz null,

  constraint tenant_support_notification_outbox_case_version_event_key
    unique (case_id, case_status_version, event_type)
);

comment on table public.tenant_support_notification_outbox is
  'MG-SUPPORT-003E.2A Support notification outbox. Server writes later. No recipient email, no email body, no money, no internal notes.';

comment on column public.tenant_support_notification_outbox.event_type is
  'Closed notification event. Templates are generated later from event_type + case_ref.';

comment on column public.tenant_support_notification_outbox.delivery_status is
  'pending / claimed / bridge_accepted / submission_unknown / failed. Never auto-retry unknown.';

create index if not exists tenant_support_notification_outbox_tenant_created_idx
  on public.tenant_support_notification_outbox (tenant_id, created_at desc);

create index if not exists tenant_support_notification_outbox_delivery_created_idx
  on public.tenant_support_notification_outbox (delivery_status, created_at);

alter table public.tenant_support_notification_outbox enable row level security;

drop policy if exists "service role full access tenant_support_notification_outbox"
  on public.tenant_support_notification_outbox;
create policy "service role full access tenant_support_notification_outbox"
  on public.tenant_support_notification_outbox
  for all
  to service_role
  using (true)
  with check (true);

revoke all on table public.tenant_support_notification_outbox from public;
revoke all on table public.tenant_support_notification_outbox from anon;
revoke all on table public.tenant_support_notification_outbox from authenticated;
grant all on table public.tenant_support_notification_outbox to service_role;
