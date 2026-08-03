-- =============================================================================
-- Margin Guard | CH-011A — Contract Package Foundation (additive)
-- =============================================================================
-- STATUS: MANUAL SUPABASE APPLY REQUIRED — do not run from CI or auto-deploy.
--
-- PURPOSE:
--   Immutable frozen Contract Package snapshots for future signing.
--   Not envelopes. Not signatures. Not invoices. Not ledger. Not Stripe.
--
-- DEPENDENCIES (MANUAL PRECHECK BEFORE APPLY):
--   REQUIRED: public.tenants, public.tenant_projects, public.quotes
--
-- NOT IN THIS MIGRATION:
--   * signing envelopes / signers / tokens
--   * PDF / certificate tables
--   * alters to Contract Builder, invoices, ledger, payment intents
-- =============================================================================

create table if not exists public.tenant_contract_packages (
  id uuid primary key default gen_random_uuid(),

  tenant_id uuid not null
    references public.tenants (id) on delete cascade,
  project_id uuid not null
    references public.tenant_projects (id) on delete cascade,
  quote_id uuid not null
    references public.quotes (id) on delete restrict,

  version integer not null
    check (version >= 1),

  -- Package lifecycle only. Signing workflow states live elsewhere.
  status text not null default 'ready'
    check (status in ('ready', 'superseded', 'executed', 'void')),

  snapshot_json jsonb not null
    check (jsonb_typeof(snapshot_json) = 'object'),
  content_hash text not null
    check (content_hash ~ '^[a-f0-9]{64}$'),
  source_readiness jsonb not null
    check (jsonb_typeof(source_readiness) = 'object'),

  supersedes_package_id uuid null,

  -- Opaque actor id (membership). No FK: membership conventions vary.
  created_by uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint tenant_contract_packages_tenant_id_id_key
    unique (tenant_id, id),

  constraint tenant_contract_packages_tenant_project_version_key
    unique (tenant_id, project_id, version),

  constraint tenant_contract_packages_supersedes_fk
    foreign key (tenant_id, supersedes_package_id)
    references public.tenant_contract_packages (tenant_id, id)
    on delete set null
);

comment on table public.tenant_contract_packages is
  'CH-011A immutable Contract Package freeze. Snapshot of confirmed CB + Business Settings. Not a signing envelope.';

comment on column public.tenant_contract_packages.tenant_id is
  'Resolved from authenticated server session only; never accepted from browser input.';

comment on column public.tenant_contract_packages.snapshot_json is
  'Frozen authoritative contract content. Immutable after insert.';

comment on column public.tenant_contract_packages.content_hash is
  'SHA-256 hex of canonical snapshot_json. Immutable after insert.';

comment on column public.tenant_contract_packages.source_readiness is
  'Readiness map captured at freeze time. Immutable after insert.';

-- ---------------------------------------------------------------------------
-- Same-tenant / same-project referential integrity
-- ---------------------------------------------------------------------------
create or replace function public.tenant_contract_packages_assert_refs()
returns trigger
language plpgsql
as $$
declare
  v_project_tenant uuid;
  v_project_quote uuid;
  v_quote_tenant uuid;
  v_super_tenant uuid;
  v_super_project uuid;
begin
  select p.tenant_id, p.quote_id
    into v_project_tenant, v_project_quote
  from public.tenant_projects p
  where p.id = new.project_id;

  if v_project_tenant is null then
    raise exception 'contract_package_project_missing'
      using errcode = '23503';
  end if;
  if v_project_tenant is distinct from new.tenant_id then
    raise exception 'contract_package_project_tenant_mismatch'
      using errcode = '23514';
  end if;

  select q.tenant_id into v_quote_tenant
  from public.quotes q
  where q.id = new.quote_id;

  if v_quote_tenant is null then
    raise exception 'contract_package_quote_missing'
      using errcode = '23503';
  end if;
  if v_quote_tenant is distinct from new.tenant_id then
    raise exception 'contract_package_quote_tenant_mismatch'
      using errcode = '23514';
  end if;
  if v_project_quote is not null and v_project_quote is distinct from new.quote_id then
    raise exception 'contract_package_quote_project_mismatch'
      using errcode = '23514';
  end if;

  if new.supersedes_package_id is not null then
    select p.tenant_id, p.project_id
      into v_super_tenant, v_super_project
    from public.tenant_contract_packages p
    where p.id = new.supersedes_package_id;

    if v_super_tenant is null then
      raise exception 'contract_package_supersedes_missing'
        using errcode = '23503';
    end if;
    if v_super_tenant is distinct from new.tenant_id
       or v_super_project is distinct from new.project_id then
      raise exception 'contract_package_supersedes_scope_mismatch'
        using errcode = '23514';
    end if;
    if new.supersedes_package_id = new.id then
      raise exception 'contract_package_supersedes_self'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_tenant_contract_packages_assert_refs
  on public.tenant_contract_packages;
create trigger trg_tenant_contract_packages_assert_refs
  before insert or update of
    tenant_id, project_id, quote_id, supersedes_package_id
  on public.tenant_contract_packages
  for each row
  execute function public.tenant_contract_packages_assert_refs();

revoke all on function public.tenant_contract_packages_assert_refs() from public;
revoke all on function public.tenant_contract_packages_assert_refs() from anon;
revoke all on function public.tenant_contract_packages_assert_refs() from authenticated;
grant execute on function public.tenant_contract_packages_assert_refs() to service_role;

-- ---------------------------------------------------------------------------
-- Immutability: frozen content columns cannot change
-- Status transitions (ready → superseded|executed|void) remain allowed.
-- ---------------------------------------------------------------------------
create or replace function public.tenant_contract_packages_protect_immutable()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    if new.tenant_id is distinct from old.tenant_id
       or new.project_id is distinct from old.project_id
       or new.quote_id is distinct from old.quote_id
       or new.version is distinct from old.version
       or new.snapshot_json is distinct from old.snapshot_json
       or new.content_hash is distinct from old.content_hash
       or new.source_readiness is distinct from old.source_readiness
       or new.created_by is distinct from old.created_by
       or new.created_at is distinct from old.created_at then
      raise exception 'contract_package_immutable'
        using errcode = '23514';
    end if;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_tenant_contract_packages_protect_immutable
  on public.tenant_contract_packages;
create trigger trg_tenant_contract_packages_protect_immutable
  before update on public.tenant_contract_packages
  for each row
  execute function public.tenant_contract_packages_protect_immutable();

revoke all on function public.tenant_contract_packages_protect_immutable() from public;
revoke all on function public.tenant_contract_packages_protect_immutable() from anon;
revoke all on function public.tenant_contract_packages_protect_immutable() from authenticated;
grant execute on function public.tenant_contract_packages_protect_immutable() to service_role;

-- ---------------------------------------------------------------------------
-- Atomic next-version helper (advisory lock reduces duplicate version races)
-- ---------------------------------------------------------------------------
create or replace function public.tenant_contract_packages_next_version(
  p_tenant_id uuid,
  p_project_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next integer;
begin
  if p_tenant_id is null or p_project_id is null then
    raise exception 'contract_package_next_version_invalid_args'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtext(p_tenant_id::text || ':' || p_project_id::text)
  );

  select coalesce(max(p.version), 0) + 1
    into v_next
  from public.tenant_contract_packages p
  where p.tenant_id = p_tenant_id
    and p.project_id = p_project_id;

  return v_next;
end;
$$;

revoke all on function public.tenant_contract_packages_next_version(uuid, uuid) from public;
revoke all on function public.tenant_contract_packages_next_version(uuid, uuid) from anon;
revoke all on function public.tenant_contract_packages_next_version(uuid, uuid) from authenticated;
grant execute on function public.tenant_contract_packages_next_version(uuid, uuid) to service_role;

create index if not exists tenant_contract_packages_tenant_project_idx
  on public.tenant_contract_packages (tenant_id, project_id);

create index if not exists tenant_contract_packages_tenant_project_status_idx
  on public.tenant_contract_packages (tenant_id, project_id, status);

create index if not exists tenant_contract_packages_tenant_project_version_desc_idx
  on public.tenant_contract_packages (tenant_id, project_id, version desc);

create index if not exists tenant_contract_packages_tenant_quote_idx
  on public.tenant_contract_packages (tenant_id, quote_id);

create index if not exists tenant_contract_packages_tenant_hash_idx
  on public.tenant_contract_packages (tenant_id, project_id, content_hash);

alter table public.tenant_contract_packages enable row level security;

drop policy if exists "service role full access tenant_contract_packages"
  on public.tenant_contract_packages;
create policy "service role full access tenant_contract_packages"
  on public.tenant_contract_packages
  for all
  to service_role
  using (true)
  with check (true);

revoke all on table public.tenant_contract_packages from public;
revoke all on table public.tenant_contract_packages from anon;
revoke all on table public.tenant_contract_packages from authenticated;
grant all on table public.tenant_contract_packages to service_role;
