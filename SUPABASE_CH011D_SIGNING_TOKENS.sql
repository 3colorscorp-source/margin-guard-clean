-- CH-011D Signing Tokens Foundation (additive)
-- MANUAL SUPABASE APPLY. Requires: tenants, tenant_contract_envelopes, tenant_contract_signers

do $$
begin
  if to_regclass('public.tenants') is null then
    raise exception 'CH-011D blocked: missing public.tenants';
  end if;
  if to_regclass('public.tenant_contract_envelopes') is null then
    raise exception 'CH-011D blocked: missing public.tenant_contract_envelopes';
  end if;
  if to_regclass('public.tenant_contract_signers') is null then
    raise exception 'CH-011D blocked: missing public.tenant_contract_signers';
  end if;
end;
$$;

create table if not exists public.tenant_contract_signing_tokens (
  id uuid primary key default gen_random_uuid(),

  tenant_id uuid not null
    references public.tenants (id) on delete cascade,
  envelope_id uuid not null,
  signer_id uuid not null,

  token_hash text not null
    check (token_hash ~ '^[a-f0-9]{64}$'),

  status text not null default 'active'
    check (status in ('active', 'revoked', 'consumed', 'expired')),

  expires_at timestamptz not null,
  consumed_at timestamptz null,
  revoked_at timestamptz null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint tenant_contract_signing_tokens_tenant_id_id_key
    unique (tenant_id, id),

  constraint tenant_contract_signing_tokens_hash_key
    unique (token_hash),

  constraint tenant_contract_signing_tokens_envelope_fk
    foreign key (tenant_id, envelope_id)
    references public.tenant_contract_envelopes (tenant_id, id)
    on delete cascade,

  constraint tenant_contract_signing_tokens_signer_fk
    foreign key (tenant_id, signer_id)
    references public.tenant_contract_signers (tenant_id, id)
    on delete cascade
);

comment on table public.tenant_contract_signing_tokens is
  'CH-011D signing access tokens. Raw token never stored; SHA-256 hash only.';

comment on column public.tenant_contract_signing_tokens.token_hash is
  'SHA-256 hex of raw token. Immutable after insert. Raw token returned once at create.';

comment on column public.tenant_contract_signing_tokens.status is
  'active|revoked|consumed|expired';

create or replace function public.tenant_contract_signing_tokens_assert_refs()
returns trigger
language plpgsql
as $$
declare
  v_signer_tenant uuid;
  v_signer_envelope uuid;
begin
  select s.tenant_id, s.envelope_id
    into v_signer_tenant, v_signer_envelope
  from public.tenant_contract_signers s
  where s.id = new.signer_id
    and s.tenant_id = new.tenant_id;

  if v_signer_tenant is null then
    raise exception 'signing_token_signer_missing'
      using errcode = '23503';
  end if;
  if v_signer_envelope is distinct from new.envelope_id then
    raise exception 'signing_token_envelope_mismatch'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists tenant_contract_signing_tokens_assert_refs_bi
  on public.tenant_contract_signing_tokens;
create trigger tenant_contract_signing_tokens_assert_refs_bi
  before insert on public.tenant_contract_signing_tokens
  for each row
  execute function public.tenant_contract_signing_tokens_assert_refs();

drop trigger if exists tenant_contract_signing_tokens_assert_refs_bu
  on public.tenant_contract_signing_tokens;
create trigger tenant_contract_signing_tokens_assert_refs_bu
  before update on public.tenant_contract_signing_tokens
  for each row
  execute function public.tenant_contract_signing_tokens_assert_refs();

create or replace function public.tenant_contract_signing_tokens_protect_immutable()
returns trigger
language plpgsql
as $$
begin
  if new.token_hash is distinct from old.token_hash then
    raise exception 'signing_token_hash_immutable'
      using errcode = '23514';
  end if;
  if new.tenant_id is distinct from old.tenant_id
     or new.envelope_id is distinct from old.envelope_id
     or new.signer_id is distinct from old.signer_id then
    raise exception 'signing_token_refs_immutable'
      using errcode = '23514';
  end if;
  if new.created_at is distinct from old.created_at then
    raise exception 'signing_token_created_at_immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists tenant_contract_signing_tokens_protect_immutable_bu
  on public.tenant_contract_signing_tokens;
create trigger tenant_contract_signing_tokens_protect_immutable_bu
  before update on public.tenant_contract_signing_tokens
  for each row
  execute function public.tenant_contract_signing_tokens_protect_immutable();

create or replace function public.tenant_contract_signing_tokens_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tenant_contract_signing_tokens_touch_updated_at_bu
  on public.tenant_contract_signing_tokens;
create trigger tenant_contract_signing_tokens_touch_updated_at_bu
  before update on public.tenant_contract_signing_tokens
  for each row
  execute function public.tenant_contract_signing_tokens_touch_updated_at();

-- One active token per signer.
create unique index if not exists tenant_contract_signing_tokens_one_active_per_signer_uidx
  on public.tenant_contract_signing_tokens (tenant_id, signer_id)
  where status = 'active';

create index if not exists tenant_contract_signing_tokens_tenant_signer_idx
  on public.tenant_contract_signing_tokens (tenant_id, signer_id);

create index if not exists tenant_contract_signing_tokens_tenant_envelope_idx
  on public.tenant_contract_signing_tokens (tenant_id, envelope_id);

create index if not exists tenant_contract_signing_tokens_tenant_status_idx
  on public.tenant_contract_signing_tokens (tenant_id, status);

alter table public.tenant_contract_signing_tokens enable row level security;

drop policy if exists "service role full access tenant_contract_signing_tokens"
  on public.tenant_contract_signing_tokens;
create policy "service role full access tenant_contract_signing_tokens"
  on public.tenant_contract_signing_tokens
  for all
  to service_role
  using (true)
  with check (true);

revoke all on table public.tenant_contract_signing_tokens from public;
revoke all on table public.tenant_contract_signing_tokens from anon;
revoke all on table public.tenant_contract_signing_tokens from authenticated;
grant all on table public.tenant_contract_signing_tokens to service_role;

revoke all on function public.tenant_contract_signing_tokens_assert_refs() from public;
revoke all on function public.tenant_contract_signing_tokens_assert_refs() from anon;
revoke all on function public.tenant_contract_signing_tokens_assert_refs() from authenticated;
grant execute on function public.tenant_contract_signing_tokens_assert_refs() to service_role;

revoke all on function public.tenant_contract_signing_tokens_protect_immutable() from public;
revoke all on function public.tenant_contract_signing_tokens_protect_immutable() from anon;
revoke all on function public.tenant_contract_signing_tokens_protect_immutable() from authenticated;
grant execute on function public.tenant_contract_signing_tokens_protect_immutable() to service_role;

revoke all on function public.tenant_contract_signing_tokens_touch_updated_at() from public;
revoke all on function public.tenant_contract_signing_tokens_touch_updated_at() from anon;
revoke all on function public.tenant_contract_signing_tokens_touch_updated_at() from authenticated;
grant execute on function public.tenant_contract_signing_tokens_touch_updated_at() to service_role;
