-- CH-011C Contract Signers Foundation (additive)
-- MANUAL SUPABASE APPLY. Requires: public.tenants, public.tenant_contract_envelopes,
-- public.tenant_contract_packages, public.tenant_projects

do $$
begin
  if to_regclass('public.tenants') is null then
    raise exception 'CH-011C blocked: missing public.tenants';
  end if;
  if to_regclass('public.tenant_contract_envelopes') is null then
    raise exception 'CH-011C blocked: missing public.tenant_contract_envelopes';
  end if;
  if to_regclass('public.tenant_contract_packages') is null then
    raise exception 'CH-011C blocked: missing public.tenant_contract_packages';
  end if;
  if to_regclass('public.tenant_projects') is null then
    raise exception 'CH-011C blocked: missing public.tenant_projects';
  end if;
end;
$$;

create table if not exists public.tenant_contract_signers (
  id uuid primary key default gen_random_uuid(),

  tenant_id uuid not null
    references public.tenants (id) on delete cascade,
  envelope_id uuid not null,
  package_id uuid not null,
  project_id uuid not null
    references public.tenant_projects (id) on delete cascade,

  role text not null
    check (role in ('owner', 'customer', 'additional')),

  party_name text not null
    check (char_length(trim(party_name)) > 0 and char_length(party_name) <= 200),

  email text not null
    check (char_length(trim(email)) > 0 and char_length(email) <= 320),

  phone text not null default ''
    check (char_length(phone) <= 40),

  sign_order integer not null
    check (sign_order >= 1),

  status text not null default 'pending'
    check (status in ('pending')),

  auth_method text not null
    check (auth_method in ('email_link', 'in_app')),

  is_required boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint tenant_contract_signers_tenant_id_id_key
    unique (tenant_id, id),

  constraint tenant_contract_signers_envelope_fk
    foreign key (tenant_id, envelope_id)
    references public.tenant_contract_envelopes (tenant_id, id)
    on delete cascade,

  constraint tenant_contract_signers_package_fk
    foreign key (tenant_id, package_id)
    references public.tenant_contract_packages (tenant_id, id)
    on delete restrict
);

comment on table public.tenant_contract_signers is
  'CH-011C signer roster for a draft Envelope. No tokens, email send, or signature capture.';

comment on column public.tenant_contract_signers.tenant_id is
  'Resolved from authenticated server session only; never accepted from browser input.';

comment on column public.tenant_contract_signers.status is
  'CH-011C: pending only. Future notify/view/sign states come later.';

create or replace function public.tenant_contract_signers_assert_refs()
returns trigger
language plpgsql
as $$
declare
  v_env_tenant uuid;
  v_env_package uuid;
  v_env_project uuid;
  v_env_status text;
begin
  select e.tenant_id, e.package_id, e.project_id, e.status
    into v_env_tenant, v_env_package, v_env_project, v_env_status
  from public.tenant_contract_envelopes e
  where e.id = new.envelope_id
    and e.tenant_id = new.tenant_id;

  if v_env_tenant is null then
    raise exception 'contract_signer_envelope_missing'
      using errcode = '23503';
  end if;
  if v_env_package is distinct from new.package_id then
    raise exception 'contract_signer_package_mismatch'
      using errcode = '23514';
  end if;
  if v_env_project is distinct from new.project_id then
    raise exception 'contract_signer_project_mismatch'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists tenant_contract_signers_assert_refs_bi
  on public.tenant_contract_signers;
create trigger tenant_contract_signers_assert_refs_bi
  before insert on public.tenant_contract_signers
  for each row
  execute function public.tenant_contract_signers_assert_refs();

drop trigger if exists tenant_contract_signers_assert_refs_bu
  on public.tenant_contract_signers;
create trigger tenant_contract_signers_assert_refs_bu
  before update on public.tenant_contract_signers
  for each row
  execute function public.tenant_contract_signers_assert_refs();

create or replace function public.tenant_contract_signers_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tenant_contract_signers_touch_updated_at_bu
  on public.tenant_contract_signers;
create trigger tenant_contract_signers_touch_updated_at_bu
  before update on public.tenant_contract_signers
  for each row
  execute function public.tenant_contract_signers_touch_updated_at();

-- Duplicate email blocked per envelope (case-insensitive).
create unique index if not exists tenant_contract_signers_envelope_email_uidx
  on public.tenant_contract_signers (tenant_id, envelope_id, lower(email));

create index if not exists tenant_contract_signers_tenant_envelope_idx
  on public.tenant_contract_signers (tenant_id, envelope_id);

create index if not exists tenant_contract_signers_tenant_envelope_order_idx
  on public.tenant_contract_signers (tenant_id, envelope_id, sign_order, created_at, id);

create index if not exists tenant_contract_signers_tenant_package_idx
  on public.tenant_contract_signers (tenant_id, package_id);

alter table public.tenant_contract_signers enable row level security;

drop policy if exists "service role full access tenant_contract_signers"
  on public.tenant_contract_signers;
create policy "service role full access tenant_contract_signers"
  on public.tenant_contract_signers
  for all
  to service_role
  using (true)
  with check (true);

revoke all on table public.tenant_contract_signers from public;
revoke all on table public.tenant_contract_signers from anon;
revoke all on table public.tenant_contract_signers from authenticated;
grant all on table public.tenant_contract_signers to service_role;

revoke all on function public.tenant_contract_signers_assert_refs() from public;
revoke all on function public.tenant_contract_signers_assert_refs() from anon;
revoke all on function public.tenant_contract_signers_assert_refs() from authenticated;
grant execute on function public.tenant_contract_signers_assert_refs() to service_role;

revoke all on function public.tenant_contract_signers_touch_updated_at() from public;
revoke all on function public.tenant_contract_signers_touch_updated_at() from anon;
revoke all on function public.tenant_contract_signers_touch_updated_at() from authenticated;
grant execute on function public.tenant_contract_signers_touch_updated_at() to service_role;
