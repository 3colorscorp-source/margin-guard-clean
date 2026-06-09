-- =============================================================================
-- Margin Guard | Multi-Seller Roadmap — M3: device_sessions
-- =============================================================================
-- STATUS: DRAFT — DO NOT RUN
-- Apply only after M2 and explicit owner approval.
--
-- PREREQUISITE: SUPABASE_TENANT_DEVICES_M2.sql
--
-- SESSION MODEL (see DEVICE_BOUND_PORTAL_GUARD_SPEC.md):
--   - Cookie name: mg_device_session
--   - Signed token; server stores session_token_hash
--   - One active session per device; revoke previous on new pair
--   - TTL: 30 days rolling via heartbeat
--   - Owner revoke: set status=revoked, revoked_at=now()
--
-- ROLLBACK: DROP TABLE public.device_sessions CASCADE;
-- =============================================================================

create table if not exists public.device_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  device_id uuid not null references public.tenant_devices (id) on delete cascade,
  membership_id uuid not null references public.profiles (id) on delete cascade,
  portal_type text not null
    check (portal_type in ('seller', 'supervisor')),
  session_token_hash text not null,
  status text not null default 'active'
    check (status in ('active', 'revoked', 'expired')),
  expires_at timestamptz not null,
  revoked_at timestamptz null,
  last_seen_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.device_sessions is
  'Revocable device tablet sessions. DRAFT — unused until pair-device API (Step 3D+).';

comment on column public.device_sessions.session_token_hash is
  'SHA-256 or HMAC digest of mg_device_session cookie token. Never store raw token.';

comment on column public.device_sessions.expires_at is
  'Extended by heartbeat (30-day rolling). Mark expired via job or on validation.';

-- At most one active session per device (owner-approved decision #8).
create unique index if not exists device_sessions_one_active_per_device_uidx
  on public.device_sessions (device_id)
  where status = 'active';

create unique index if not exists device_sessions_token_hash_uidx
  on public.device_sessions (session_token_hash);

create index if not exists device_sessions_device_status_idx
  on public.device_sessions (device_id, status);

create index if not exists device_sessions_tenant_device_idx
  on public.device_sessions (tenant_id, device_id);

create index if not exists device_sessions_active_expires_idx
  on public.device_sessions (expires_at)
  where status = 'active';

-- -----------------------------------------------------------------------------
-- Same-tenant consistency (device + membership must match session.tenant_id)
-- -----------------------------------------------------------------------------
create or replace function public.assert_device_session_same_tenant()
returns trigger
language plpgsql
as $$
declare
  device_tenant uuid;
  membership_tenant uuid;
begin
  select d.tenant_id into device_tenant
  from public.tenant_devices d where d.id = new.device_id;

  select p.tenant_id into membership_tenant
  from public.profiles p where p.id = new.membership_id;

  if device_tenant is null or membership_tenant is null then
    raise exception 'device_sessions device_id or membership_id invalid';
  end if;

  if new.tenant_id is distinct from device_tenant
     or new.tenant_id is distinct from membership_tenant then
    raise exception 'device_sessions.tenant_id must match device and membership tenant';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_device_sessions_same_tenant on public.device_sessions;
create trigger trg_device_sessions_same_tenant
before insert or update of tenant_id, device_id, membership_id
on public.device_sessions
for each row execute function public.assert_device_session_same_tenant();

drop trigger if exists trg_device_sessions_updated_at on public.device_sessions;
create trigger trg_device_sessions_updated_at
before update on public.device_sessions
for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------
alter table public.device_sessions enable row level security;

drop policy if exists "service role full access device_sessions" on public.device_sessions;
create policy "service role full access device_sessions"
on public.device_sessions for all to service_role using (true) with check (true);

-- =============================================================================
-- END M3 — DRAFT — DO NOT RUN without owner approval
-- =============================================================================
