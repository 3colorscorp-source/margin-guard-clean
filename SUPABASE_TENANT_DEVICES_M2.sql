-- =============================================================================
-- Margin Guard | Multi-Seller Roadmap — M2: tenant_devices
-- =============================================================================
-- STATUS: DRAFT — DO NOT RUN
-- Apply only after M1 and explicit owner approval. Does NOT create device rows.
--
-- PREREQUISITE: SUPABASE_PROFILES_MEMBERSHIP_M1.sql (profiles hardened)
--
-- PURPOSE:
--   Company-owned tablets bound to one tenant, one portal type, one membership.
--
-- OWNER RULES (enforced in app unless noted):
--   - tenant_id immutable after insert
--   - cross-tenant reassignment forbidden (revoke + new device in other tenant)
--   - max 3 active seller devices per membership: APP-ENFORCED (see comment)
--   - reassign within tenant: revoke sessions + require re-pair (app, Step 3D+)
--
-- ROLLBACK: DROP TABLE public.tenant_devices CASCADE; drop trigger/function.
-- =============================================================================

create table if not exists public.tenant_devices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  portal_type text not null
    check (portal_type in ('seller', 'supervisor')),
  assigned_membership_id uuid not null references public.profiles (id) on delete restrict,
  display_name text not null default '',
  status text not null default 'pending_pair'
    check (status in ('pending_pair', 'active', 'suspended', 'revoked')),
  pairing_code_hash text null,
  pairing_expires_at timestamptz null,
  device_fingerprint text null,
  last_seen_at timestamptz null,
  created_by_membership_id uuid null references public.profiles (id) on delete set null,
  revoked_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.tenant_devices is
  'Company-owned seller/supervisor tablets. DRAFT schema — not populated until pairing UI.';

comment on column public.tenant_devices.tenant_id is
  'Immutable after insert. Device never moves to another tenant.';

comment on column public.tenant_devices.portal_type is
  'seller = Sales/Vendedor device portal; supervisor = Supervisor device portal.';

comment on column public.tenant_devices.pairing_code_hash is
  'Hash of 8-char pairing code (A-Z, 0-9 uppercase). Cleared when status becomes active.';

comment on column public.tenant_devices.device_fingerprint is
  'Optional browser/storage fingerprint set at successful pair.';

-- Max 3 active seller devices per membership: enforced in Netlify pair-device API.
-- A partial unique index is NOT used here because supervisors may share patterns
-- and reassignment flows need flexibility. App counts:
--   SELECT count(*) FROM tenant_devices
--   WHERE assigned_membership_id = $1 AND portal_type = 'seller' AND status = 'active';

create index if not exists tenant_devices_tenant_status_idx
  on public.tenant_devices (tenant_id, status);

create index if not exists tenant_devices_assigned_membership_idx
  on public.tenant_devices (assigned_membership_id);

create index if not exists tenant_devices_tenant_portal_status_idx
  on public.tenant_devices (tenant_id, portal_type, status);

-- -----------------------------------------------------------------------------
-- updated_at trigger (reuse set_updated_at if present)
-- -----------------------------------------------------------------------------
drop trigger if exists trg_tenant_devices_updated_at on public.tenant_devices;
create trigger trg_tenant_devices_updated_at
before update on public.tenant_devices
for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Same-tenant assignment enforcement
-- -----------------------------------------------------------------------------
create or replace function public.assert_tenant_device_membership_same_tenant()
returns trigger
language plpgsql
as $$
declare
  membership_tenant uuid;
begin
  select p.tenant_id into membership_tenant
  from public.profiles p
  where p.id = new.assigned_membership_id;

  if membership_tenant is null then
    raise exception 'assigned_membership_id % not found', new.assigned_membership_id;
  end if;

  if membership_tenant is distinct from new.tenant_id then
    raise exception 'tenant_devices.tenant_id must match profiles.tenant_id for assignment';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_tenant_devices_same_tenant on public.tenant_devices;
create trigger trg_tenant_devices_same_tenant
before insert or update of tenant_id, assigned_membership_id
on public.tenant_devices
for each row execute function public.assert_tenant_device_membership_same_tenant();

-- Optional: prevent UPDATE of tenant_id after insert
create or replace function public.prevent_tenant_devices_tenant_id_change()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and new.tenant_id is distinct from old.tenant_id then
    raise exception 'tenant_devices.tenant_id is immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_tenant_devices_immutable_tenant on public.tenant_devices;
create trigger trg_tenant_devices_immutable_tenant
before update of tenant_id on public.tenant_devices
for each row execute function public.prevent_tenant_devices_tenant_id_change();

-- -----------------------------------------------------------------------------
-- Row Level Security (service_role pattern — matches repo conventions)
-- -----------------------------------------------------------------------------
alter table public.tenant_devices enable row level security;

drop policy if exists "service role full access tenant_devices" on public.tenant_devices;
create policy "service role full access tenant_devices"
on public.tenant_devices for all to service_role using (true) with check (true);

-- =============================================================================
-- END M2 — DRAFT — DO NOT RUN without owner approval
-- =============================================================================
