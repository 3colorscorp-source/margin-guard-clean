-- =============================================================================
-- Margin Guard | CH-013A.0 — Platform Fabric Foundation (additive)
-- =============================================================================
-- STATUS: MANUAL SUPABASE APPLY REQUIRED — do not run from CI or auto-deploy.
--
-- PURPOSE:
--   Internal domain-event outbox, activity projection storage, and notification
--   projection storage for future Delivery / CRM / Mobile / AI consumers.
--
-- NOT IN THIS MIGRATION:
--   * email / SMS / push adapters
--   * workers / external queues
--   * UI
--   * event emission from signing/freeze (wire-up is later)
--   * Invoice Hub / ledger / Stripe / payments
--
-- DEPENDENCIES:
--   REQUIRED: public.tenants
--   OPTIONAL FK targets: tenant_projects, quotes (nullable columns, no FK required)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) Transactional outbox (append-only domain events)
-- ---------------------------------------------------------------------------
create table if not exists public.platform_domain_event_outbox (
  event_id uuid primary key default gen_random_uuid(),
  event_version integer not null default 1
    check (event_version >= 1),

  tenant_id uuid not null
    references public.tenants (id) on delete cascade,

  project_id uuid null,
  quote_id uuid null,

  aggregate text not null
    check (char_length(trim(aggregate)) > 0),
  aggregate_id uuid null,

  type text not null
    check (char_length(trim(type)) > 0),

  occurred_at timestamptz not null default timezone('utc', now()),
  correlation_id text not null
    check (correlation_id ~ '^MG-EVT-[0-9A-Z]{8}$'),
  causation_id text null
    check (
      causation_id is null
      or causation_id ~ '^MG-EVT-[0-9A-Z]{8}$'
    ),

  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload) = 'object'),

  -- Deduplicate appends for the same logical emission.
  idempotency_key text not null
    check (char_length(trim(idempotency_key)) > 0),

  created_at timestamptz not null default timezone('utc', now()),

  constraint platform_domain_event_outbox_tenant_event_key
    unique (tenant_id, event_id),

  constraint platform_domain_event_outbox_tenant_idempotency_key
    unique (tenant_id, idempotency_key)
);

comment on table public.platform_domain_event_outbox is
  'CH-013A.0 append-only transactional outbox for domain events. No worker yet. Never store raw tokens, signed URLs, signatures, or secrets in payload.';

comment on column public.platform_domain_event_outbox.correlation_id is
  'Stable searchable correlation id: MG-EVT-XXXXXXXX';

comment on column public.platform_domain_event_outbox.idempotency_key is
  'Caller-supplied unique key per tenant for idempotent append.';

create index if not exists platform_domain_event_outbox_tenant_occurred_idx
  on public.platform_domain_event_outbox (tenant_id, occurred_at desc);

create index if not exists platform_domain_event_outbox_tenant_type_idx
  on public.platform_domain_event_outbox (tenant_id, type);

create index if not exists platform_domain_event_outbox_tenant_correlation_idx
  on public.platform_domain_event_outbox (tenant_id, correlation_id);

create index if not exists platform_domain_event_outbox_tenant_project_idx
  on public.platform_domain_event_outbox (tenant_id, project_id);

-- Append-only: block UPDATE and DELETE
create or replace function public.platform_domain_event_outbox_reject_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'platform_domain_event_outbox is append-only (CH-013A.0)';
end;
$$;

drop trigger if exists platform_domain_event_outbox_no_update
  on public.platform_domain_event_outbox;
create trigger platform_domain_event_outbox_no_update
  before update on public.platform_domain_event_outbox
  for each row
  execute function public.platform_domain_event_outbox_reject_mutation();

drop trigger if exists platform_domain_event_outbox_no_delete
  on public.platform_domain_event_outbox;
create trigger platform_domain_event_outbox_no_delete
  before delete on public.platform_domain_event_outbox
  for each row
  execute function public.platform_domain_event_outbox_reject_mutation();

alter table public.platform_domain_event_outbox enable row level security;

drop policy if exists "service role full access platform_domain_event_outbox"
  on public.platform_domain_event_outbox;
create policy "service role full access platform_domain_event_outbox"
  on public.platform_domain_event_outbox
  for all
  to service_role
  using (true)
  with check (true);

revoke all on table public.platform_domain_event_outbox from public;
revoke all on table public.platform_domain_event_outbox from anon;
revoke all on table public.platform_domain_event_outbox from authenticated;
grant all on table public.platform_domain_event_outbox to service_role;

-- ---------------------------------------------------------------------------
-- 2) Activity projection (append-only human timeline storage; no UI yet)
-- ---------------------------------------------------------------------------
create table if not exists public.platform_activity_events (
  id uuid primary key default gen_random_uuid(),

  tenant_id uuid not null
    references public.tenants (id) on delete cascade,

  project_id uuid null,
  quote_id uuid null,

  source_event_id uuid null,
  event_type text not null
    check (char_length(trim(event_type)) > 0),

  occurred_at timestamptz not null default timezone('utc', now()),
  correlation_id text null
    check (
      correlation_id is null
      or correlation_id ~ '^MG-EVT-[0-9A-Z]{8}$'
    ),

  title text not null default '',
  summary text not null default '',
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload) = 'object'),

  created_at timestamptz not null default timezone('utc', now()),

  constraint platform_activity_events_tenant_id_key
    unique (tenant_id, id),

  -- One activity row per source domain event when source_event_id is set.
  constraint platform_activity_events_tenant_source_event_key
    unique (tenant_id, source_event_id)
);

comment on table public.platform_activity_events is
  'CH-013A.0 activity timeline projection storage. Immutable after INSERT (no UPDATE/DELETE). No UI in this module.';

create index if not exists platform_activity_events_tenant_occurred_idx
  on public.platform_activity_events (tenant_id, occurred_at desc);

create index if not exists platform_activity_events_tenant_project_idx
  on public.platform_activity_events (tenant_id, project_id, occurred_at desc);

create index if not exists platform_activity_events_tenant_correlation_idx
  on public.platform_activity_events (tenant_id, correlation_id);

-- Immutable: block UPDATE and DELETE (INSERT only via service_role)
create or replace function public.platform_activity_events_reject_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'platform_activity_events is immutable (CH-013A.0)';
end;
$$;

drop trigger if exists platform_activity_events_no_update
  on public.platform_activity_events;
create trigger platform_activity_events_no_update
  before update on public.platform_activity_events
  for each row
  execute function public.platform_activity_events_reject_mutation();

drop trigger if exists platform_activity_events_no_delete
  on public.platform_activity_events;
create trigger platform_activity_events_no_delete
  before delete on public.platform_activity_events
  for each row
  execute function public.platform_activity_events_reject_mutation();

-- Retire prior delete-only helper name if present from earlier drafts.
drop function if exists public.platform_activity_events_reject_delete();

alter table public.platform_activity_events enable row level security;

drop policy if exists "service role full access platform_activity_events"
  on public.platform_activity_events;
create policy "service role full access platform_activity_events"
  on public.platform_activity_events
  for all
  to service_role
  using (true)
  with check (true);

revoke all on table public.platform_activity_events from public;
revoke all on table public.platform_activity_events from anon;
revoke all on table public.platform_activity_events from authenticated;
grant all on table public.platform_activity_events to service_role;

-- ---------------------------------------------------------------------------
-- 3) Notification projection (storage only; read/dismiss allowed)
-- ---------------------------------------------------------------------------
create table if not exists public.platform_notifications (
  id uuid primary key default gen_random_uuid(),

  tenant_id uuid not null
    references public.tenants (id) on delete cascade,

  project_id uuid null,
  quote_id uuid null,

  source_event_id uuid null,
  event_type text null,

  priority text not null default 'normal'
    check (priority in ('critical', 'high', 'normal', 'low', 'silent')),

  title text not null default '',
  body text not null default '',

  read_at timestamptz null,
  dismissed_at timestamptz null,

  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload) = 'object'),

  correlation_id text null
    check (
      correlation_id is null
      or correlation_id ~ '^MG-EVT-[0-9A-Z]{8}$'
    ),

  occurred_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),

  constraint platform_notifications_tenant_id_key
    unique (tenant_id, id)
);

comment on table public.platform_notifications is
  'CH-013A.0 Owner notification projection storage only. No UI. Supports read/unread and dismiss.';

create index if not exists platform_notifications_tenant_occurred_idx
  on public.platform_notifications (tenant_id, occurred_at desc);

create index if not exists platform_notifications_tenant_unread_idx
  on public.platform_notifications (tenant_id, created_at desc)
  where read_at is null and dismissed_at is null;

create index if not exists platform_notifications_tenant_project_idx
  on public.platform_notifications (tenant_id, project_id, occurred_at desc);

create index if not exists platform_notifications_tenant_correlation_idx
  on public.platform_notifications (tenant_id, correlation_id);

alter table public.platform_notifications enable row level security;

drop policy if exists "service role full access platform_notifications"
  on public.platform_notifications;
create policy "service role full access platform_notifications"
  on public.platform_notifications
  for all
  to service_role
  using (true)
  with check (true);

revoke all on table public.platform_notifications from public;
revoke all on table public.platform_notifications from anon;
revoke all on table public.platform_notifications from authenticated;
grant all on table public.platform_notifications to service_role;
