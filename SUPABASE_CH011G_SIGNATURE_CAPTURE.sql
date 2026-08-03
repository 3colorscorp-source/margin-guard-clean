-- CH-011G Signature Capture Engine (additive)
-- MANUAL SUPABASE APPLY.
-- Requires: tenants, tenant_contract_envelopes, tenant_contract_signers,
--           tenant_contract_packages, tenant_contract_signing_tokens

do $$
begin
  if to_regclass('public.tenants') is null then
    raise exception 'CH-011G blocked: missing public.tenants';
  end if;
  if to_regclass('public.tenant_contract_envelopes') is null then
    raise exception 'CH-011G blocked: missing public.tenant_contract_envelopes';
  end if;
  if to_regclass('public.tenant_contract_signers') is null then
    raise exception 'CH-011G blocked: missing public.tenant_contract_signers';
  end if;
  if to_regclass('public.tenant_contract_packages') is null then
    raise exception 'CH-011G blocked: missing public.tenant_contract_packages';
  end if;
  if to_regclass('public.tenant_contract_signing_tokens') is null then
    raise exception 'CH-011G blocked: missing public.tenant_contract_signing_tokens';
  end if;
end;
$$;

-- Signer: allow signed + signed_at
alter table public.tenant_contract_signers
  drop constraint if exists tenant_contract_signers_status_check;

alter table public.tenant_contract_signers
  add constraint tenant_contract_signers_status_check
  check (status in ('pending', 'signed'));

alter table public.tenant_contract_signers
  add column if not exists signed_at timestamptz null;

comment on column public.tenant_contract_signers.status is
  'CH-011G: pending|signed';

comment on column public.tenant_contract_signers.signed_at is
  'CH-011G: when signer completed electronic signature. Null while pending.';

-- Package: executed_at audit timestamp
alter table public.tenant_contract_packages
  add column if not exists executed_at timestamptz null;

comment on column public.tenant_contract_packages.executed_at is
  'CH-011G: when package became executed after all required signatures.';

-- Append-only signature events
create table if not exists public.tenant_contract_signature_events (
  id uuid primary key default gen_random_uuid(),

  tenant_id uuid not null
    references public.tenants (id) on delete cascade,
  envelope_id uuid not null,
  signer_id uuid not null,
  package_id uuid not null,
  token_id uuid not null,

  signature_method text not null
    check (signature_method in ('typed', 'drawn')),

  signature_json jsonb not null
    check (jsonb_typeof(signature_json) = 'object'),

  signed_at timestamptz not null default now(),
  ip_address text null
    check (ip_address is null or char_length(ip_address) <= 128),
  user_agent text null
    check (user_agent is null or char_length(user_agent) <= 1000),

  signer_role text not null
    check (signer_role in ('owner', 'customer', 'additional')),
  signer_party_name text not null
    check (char_length(trim(signer_party_name)) > 0),
  package_version integer not null
    check (package_version >= 1),
  envelope_status_at_sign text not null,

  consent_esign boolean not null
    check (consent_esign = true),

  created_at timestamptz not null default now(),

  constraint tenant_contract_signature_events_tenant_id_id_key
    unique (tenant_id, id),

  constraint tenant_contract_signature_events_envelope_fk
    foreign key (tenant_id, envelope_id)
    references public.tenant_contract_envelopes (tenant_id, id)
    on delete cascade,

  constraint tenant_contract_signature_events_signer_fk
    foreign key (tenant_id, signer_id)
    references public.tenant_contract_signers (tenant_id, id)
    on delete cascade,

  constraint tenant_contract_signature_events_package_fk
    foreign key (tenant_id, package_id)
    references public.tenant_contract_packages (tenant_id, id)
    on delete restrict,

  constraint tenant_contract_signature_events_token_fk
    foreign key (tenant_id, token_id)
    references public.tenant_contract_signing_tokens (tenant_id, id)
    on delete restrict
);

comment on table public.tenant_contract_signature_events is
  'CH-011G append-only electronic signature audit. Raw signing token never stored.';

comment on column public.tenant_contract_signature_events.signature_json is
  'Typed: {typed_name, rendered_name, signed_at}. Drawn: {format, paths|svg_path}. No raster images.';

create unique index if not exists tenant_contract_signature_events_one_per_signer_uidx
  on public.tenant_contract_signature_events (tenant_id, envelope_id, signer_id);

create index if not exists tenant_contract_signature_events_tenant_envelope_idx
  on public.tenant_contract_signature_events (tenant_id, envelope_id, signed_at desc);

create index if not exists tenant_contract_signature_events_tenant_token_idx
  on public.tenant_contract_signature_events (tenant_id, token_id);

-- Append-only: block update/delete
create or replace function public.tenant_contract_signature_events_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'signature_event_append_only'
    using errcode = '23514';
end;
$$;

drop trigger if exists tenant_contract_signature_events_append_only_bu
  on public.tenant_contract_signature_events;
create trigger tenant_contract_signature_events_append_only_bu
  before update on public.tenant_contract_signature_events
  for each row
  execute function public.tenant_contract_signature_events_append_only();

drop trigger if exists tenant_contract_signature_events_append_only_bd
  on public.tenant_contract_signature_events;
create trigger tenant_contract_signature_events_append_only_bd
  before delete on public.tenant_contract_signature_events
  for each row
  execute function public.tenant_contract_signature_events_append_only();

alter table public.tenant_contract_signature_events enable row level security;

drop policy if exists "service role full access tenant_contract_signature_events"
  on public.tenant_contract_signature_events;
create policy "service role full access tenant_contract_signature_events"
  on public.tenant_contract_signature_events
  for all
  to service_role
  using (true)
  with check (true);

revoke all on table public.tenant_contract_signature_events from public;
revoke all on table public.tenant_contract_signature_events from anon;
revoke all on table public.tenant_contract_signature_events from authenticated;
grant all on table public.tenant_contract_signature_events to service_role;

revoke all on function public.tenant_contract_signature_events_append_only() from public;
revoke all on function public.tenant_contract_signature_events_append_only() from anon;
revoke all on function public.tenant_contract_signature_events_append_only() from authenticated;
grant execute on function public.tenant_contract_signature_events_append_only() to service_role;
