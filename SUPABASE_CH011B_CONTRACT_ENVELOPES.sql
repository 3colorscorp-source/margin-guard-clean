-- CH-011B Contract Envelope Foundation (additive)
-- MANUAL SUPABASE APPLY. Requires: public.tenants, public.tenant_projects,
-- public.quotes, public.tenant_contract_packages

do $$
begin
  if to_regclass('public.tenants') is null then
    raise exception 'CH-011B blocked: missing public.tenants';
  end if;
  if to_regclass('public.tenant_projects') is null then
    raise exception 'CH-011B blocked: missing public.tenant_projects';
  end if;
  if to_regclass('public.quotes') is null then
    raise exception 'CH-011B blocked: missing public.quotes';
  end if;
  if to_regclass('public.tenant_contract_packages') is null then
    raise exception 'CH-011B blocked: missing public.tenant_contract_packages';
  end if;
end;
$$;

create table if not exists public.tenant_contract_envelopes (
  id uuid primary key default gen_random_uuid(),

  tenant_id uuid not null
    references public.tenants (id) on delete cascade,
  package_id uuid not null,
  project_id uuid not null
    references public.tenant_projects (id) on delete cascade,
  quote_id uuid not null
    references public.quotes (id) on delete restrict,

  status text not null default 'draft'
    check (status in (
      'draft',
      'sent',
      'opened',
      'completed',
      'declined',
      'expired',
      'cancelled'
    )),

  created_by uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  expires_at timestamptz null,
  completed_at timestamptz null,
  cancelled_at timestamptz null,
  declined_at timestamptz null,

  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),

  constraint tenant_contract_envelopes_tenant_id_id_key
    unique (tenant_id, id),

  constraint tenant_contract_envelopes_package_fk
    foreign key (tenant_id, package_id)
    references public.tenant_contract_packages (tenant_id, id)
    on delete restrict
);

comment on table public.tenant_contract_envelopes is
  'CH-011B signing Envelope for one Contract Package. Package remains immutable.';

comment on column public.tenant_contract_envelopes.tenant_id is
  'Resolved from authenticated server session only; never accepted from browser input.';

comment on column public.tenant_contract_envelopes.package_id is
  'Immutable Contract Package this signing process targets.';

comment on column public.tenant_contract_envelopes.status is
  'draft|sent|opened|completed|declined|expired|cancelled';

comment on column public.tenant_contract_envelopes.metadata is
  'Non-authoritative envelope metadata object. Not contract content.';

create or replace function public.tenant_contract_envelopes_assert_refs()
returns trigger
language plpgsql
as $$
declare
  v_pkg_tenant uuid;
  v_pkg_project uuid;
  v_pkg_quote uuid;
  v_pkg_status text;
  v_project_tenant uuid;
  v_quote_tenant uuid;
begin
  select p.tenant_id, p.project_id, p.quote_id, p.status
    into v_pkg_tenant, v_pkg_project, v_pkg_quote, v_pkg_status
  from public.tenant_contract_packages p
  where p.id = new.package_id
    and p.tenant_id = new.tenant_id;

  if v_pkg_tenant is null then
    raise exception 'contract_envelope_package_missing'
      using errcode = '23503';
  end if;
  if v_pkg_project is distinct from new.project_id then
    raise exception 'contract_envelope_package_project_mismatch'
      using errcode = '23514';
  end if;
  if v_pkg_quote is distinct from new.quote_id then
    raise exception 'contract_envelope_package_quote_mismatch'
      using errcode = '23514';
  end if;

  select p.tenant_id into v_project_tenant
  from public.tenant_projects p
  where p.id = new.project_id;

  if v_project_tenant is null then
    raise exception 'contract_envelope_project_missing'
      using errcode = '23503';
  end if;
  if v_project_tenant is distinct from new.tenant_id then
    raise exception 'contract_envelope_project_tenant_mismatch'
      using errcode = '23514';
  end if;

  select q.tenant_id into v_quote_tenant
  from public.quotes q
  where q.id = new.quote_id;

  if v_quote_tenant is null then
    raise exception 'contract_envelope_quote_missing'
      using errcode = '23503';
  end if;
  if v_quote_tenant is distinct from new.tenant_id then
    raise exception 'contract_envelope_quote_tenant_mismatch'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists tenant_contract_envelopes_assert_refs_bi
  on public.tenant_contract_envelopes;
create trigger tenant_contract_envelopes_assert_refs_bi
  before insert on public.tenant_contract_envelopes
  for each row
  execute function public.tenant_contract_envelopes_assert_refs();

drop trigger if exists tenant_contract_envelopes_assert_refs_bu
  on public.tenant_contract_envelopes;
create trigger tenant_contract_envelopes_assert_refs_bu
  before update on public.tenant_contract_envelopes
  for each row
  execute function public.tenant_contract_envelopes_assert_refs();

create or replace function public.tenant_contract_envelopes_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tenant_contract_envelopes_touch_updated_at_bu
  on public.tenant_contract_envelopes;
create trigger tenant_contract_envelopes_touch_updated_at_bu
  before update on public.tenant_contract_envelopes
  for each row
  execute function public.tenant_contract_envelopes_touch_updated_at();

-- One active envelope per package (draft/sent/opened).
create unique index if not exists tenant_contract_envelopes_one_active_per_package_uidx
  on public.tenant_contract_envelopes (tenant_id, package_id)
  where status in ('draft', 'sent', 'opened');

create index if not exists tenant_contract_envelopes_tenant_package_idx
  on public.tenant_contract_envelopes (tenant_id, package_id);

create index if not exists tenant_contract_envelopes_tenant_package_created_desc_idx
  on public.tenant_contract_envelopes (tenant_id, package_id, created_at desc);

create index if not exists tenant_contract_envelopes_tenant_project_idx
  on public.tenant_contract_envelopes (tenant_id, project_id);

create index if not exists tenant_contract_envelopes_tenant_status_idx
  on public.tenant_contract_envelopes (tenant_id, status);

alter table public.tenant_contract_envelopes enable row level security;

drop policy if exists "service role full access tenant_contract_envelopes"
  on public.tenant_contract_envelopes;
create policy "service role full access tenant_contract_envelopes"
  on public.tenant_contract_envelopes
  for all
  to service_role
  using (true)
  with check (true);

revoke all on table public.tenant_contract_envelopes from public;
revoke all on table public.tenant_contract_envelopes from anon;
revoke all on table public.tenant_contract_envelopes from authenticated;
grant all on table public.tenant_contract_envelopes to service_role;

revoke all on function public.tenant_contract_envelopes_assert_refs() from public;
revoke all on function public.tenant_contract_envelopes_assert_refs() from anon;
revoke all on function public.tenant_contract_envelopes_assert_refs() from authenticated;
grant execute on function public.tenant_contract_envelopes_assert_refs() to service_role;

revoke all on function public.tenant_contract_envelopes_touch_updated_at() from public;
revoke all on function public.tenant_contract_envelopes_touch_updated_at() from anon;
revoke all on function public.tenant_contract_envelopes_touch_updated_at() from authenticated;
grant execute on function public.tenant_contract_envelopes_touch_updated_at() to service_role;
