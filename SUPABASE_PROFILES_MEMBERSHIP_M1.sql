-- =============================================================================
-- Margin Guard | Multi-Seller Roadmap — M1: Profiles membership hardening
-- =============================================================================
-- STATUS: DRAFT — DO NOT RUN
-- Apply only after explicit owner approval. Run in Supabase SQL editor in order
-- after reviewing preflight results below. Does NOT change bootstrap-tenant or
-- owner login behavior (code changes are Step 3D+).
--
-- PREREQUISITE: public.tenants and public.profiles exist
--   (SUPABASE_MARGIN_GUARD_MULTITENANT.sql).
--
-- PURPOSE:
--   - Evolve profiles into tenant-scoped membership rows
--   - Add auth_user_id, display_name, invite metadata
--   - Constrain role and status enums
--   - Add indexes for tenant + role lookups
--
-- ROLLBACK (manual): drop added columns/constraints/indexes if no code depends
--   on them yet. Do not drop profiles table.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- PREFLIGHT (read-only diagnostics — run first, inspect output, then continue)
-- -----------------------------------------------------------------------------
-- SELECT role, status, count(*) FROM public.profiles GROUP BY 1, 2 ORDER BY 1, 2;
-- SELECT DISTINCT role FROM public.profiles WHERE role IS NOT NULL ORDER BY 1;
-- SELECT DISTINCT status FROM public.profiles WHERE status IS NOT NULL ORDER BY 1;
-- SELECT id, tenant_id, email, role, status FROM public.profiles ORDER BY created_at;
-- SELECT t.id, t.owner_email, p.email, p.role
--   FROM public.tenants t
--   LEFT JOIN public.profiles p ON p.tenant_id = t.id AND lower(p.email) = lower(t.owner_email);

-- -----------------------------------------------------------------------------
-- Columns (idempotent adds)
-- -----------------------------------------------------------------------------
alter table public.profiles
  add column if not exists auth_user_id uuid null,
  add column if not exists display_name text not null default '',
  add column if not exists invited_by_membership_id uuid null,
  add column if not exists invited_at timestamptz null,
  add column if not exists accepted_at timestamptz null;

comment on column public.profiles.auth_user_id is
  'auth.users.id for this membership. Nullable until backfill; unique per tenant when set.';

comment on column public.profiles.display_name is
  'Human label for device management and Sales Admin (e.g. Seller 1). NOT NULL DEFAULT ''''. UI should fallback to email when display_name is empty.';

comment on column public.profiles.invited_by_membership_id is
  'Owner membership that invited this user. FK added below.';

-- One-time display_name seed from legacy full_name (optional, idempotent):
-- UPDATE public.profiles
-- SET display_name = coalesce(nullif(trim(full_name), ''), nullif(trim(email), ''), '')
-- WHERE display_name = '' OR display_name IS NULL;

-- -----------------------------------------------------------------------------
-- Role / status constraints (normalize unknown values before enabling CHECK)
-- -----------------------------------------------------------------------------
-- If preflight shows unexpected role/status values, fix rows first, e.g.:
-- UPDATE public.profiles SET role = 'owner' WHERE role IS NULL OR trim(role) = '';
-- UPDATE public.profiles SET status = 'active' WHERE status IS NULL OR trim(status) = '';

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('owner', 'admin', 'seller', 'supervisor'));

alter table public.profiles drop constraint if exists profiles_status_check;
alter table public.profiles add constraint profiles_status_check
  check (status in ('invited', 'active', 'suspended', 'removed'));

-- -----------------------------------------------------------------------------
-- Foreign keys
-- -----------------------------------------------------------------------------
do $fk$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_invited_by_membership_id_fkey'
  ) then
    alter table public.profiles
      add constraint profiles_invited_by_membership_id_fkey
      foreign key (invited_by_membership_id) references public.profiles (id)
      on delete set null;
  end if;
end
$fk$;

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------
create unique index if not exists profiles_tenant_auth_user_uidx
  on public.profiles (tenant_id, auth_user_id)
  where auth_user_id is not null;

create index if not exists profiles_tenant_role_status_idx
  on public.profiles (tenant_id, role, status);

create index if not exists profiles_auth_user_id_idx
  on public.profiles (auth_user_id)
  where auth_user_id is not null;

-- -----------------------------------------------------------------------------
-- Optional backfill (run manually after auth_user_id column exists; NOT automatic)
-- -----------------------------------------------------------------------------
-- Match each profile.email to auth.users via application script or admin API.
-- Set accepted_at = created_at for existing active owner rows.
-- Example (requires auth.users linkage outside SQL editor):
--   UPDATE public.profiles SET accepted_at = created_at
--   WHERE status = 'active' AND accepted_at IS NULL;

-- =============================================================================
-- END M1 — DRAFT — DO NOT RUN without owner approval
-- =============================================================================
