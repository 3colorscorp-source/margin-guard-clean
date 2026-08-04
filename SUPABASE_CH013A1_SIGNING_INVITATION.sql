-- =============================================================================
-- Margin Guard | CH-013A.1 — Signing Invitation Lifecycle Foundation (additive)
-- =============================================================================
-- STATUS: MANUAL SUPABASE APPLY REQUIRED — do not run from CI or auto-deploy.
--
-- MODEL:
--   Invitation = stable identity per (tenant, envelope, signer)
--   Generation = versioned secure-link epoch (token-bound); history immutable
--   Delivery attempt = controlled lifecycle row (DELETE forbidden)
--
-- EXPIRATION POLICY:
--   Envelope.expires_at = overall signing-request deadline (ceiling)
--   Generation.expires_at = actual link expiration (<= envelope deadline)
--   Token.expires_at MUST equal generation.expires_at
--   Expired generation may be replaced by Resend before envelope deadline
--   Envelope expired/completed/cancelled/declined => no active generation
--
-- NOT IN THIS MIGRATION:
--   email adapters, UI, envelope-send wire-up, certificates, PDF, Invoice Hub
-- =============================================================================

do $$
begin
  if to_regclass('public.tenants') is null then
    raise exception 'CH-013A.1 blocked: missing public.tenants';
  end if;
  if to_regclass('public.tenant_contract_envelopes') is null then
    raise exception 'CH-013A.1 blocked: missing public.tenant_contract_envelopes';
  end if;
  if to_regclass('public.tenant_contract_signers') is null then
    raise exception 'CH-013A.1 blocked: missing public.tenant_contract_signers';
  end if;
  if to_regclass('public.tenant_contract_signing_tokens') is null then
    raise exception 'CH-013A.1 blocked: missing public.tenant_contract_signing_tokens';
  end if;
  if to_regclass('public.platform_domain_event_outbox') is null then
    raise exception 'CH-013A.1 blocked: missing public.platform_domain_event_outbox (apply CH-013A.0 first)';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1) Invitation aggregate (stable identity)
-- ---------------------------------------------------------------------------
create table if not exists public.tenant_contract_invitations (
  id uuid primary key default gen_random_uuid(),

  tenant_id uuid not null
    references public.tenants (id) on delete cascade,

  envelope_id uuid not null,
  signer_id uuid not null,
  package_id uuid null,
  project_id uuid null,
  quote_id uuid null,

  -- Pointer to latest generation number (1-based). 0 = none yet.
  current_generation integer not null default 0
    check (current_generation >= 0),

  status text not null default 'prepared'
    check (status in (
      'prepared',
      'queued',
      'sending',
      'sent',
      'delivered',
      'opened',
      'signed',
      'expired',
      'revoked',
      'cancelled',
      'failed',
      'bounced'
    )),

  channel text not null default 'email'
    check (channel in ('email', 'copy_link', 'in_app')),

  prepared_at timestamptz not null default timezone('utc', now()),
  queued_at timestamptz null,
  sending_at timestamptz null,
  sent_at timestamptz null,
  delivered_at timestamptz null,
  opened_at timestamptz null,
  signed_at timestamptz null,
  expired_at timestamptz null,
  revoked_at timestamptz null,
  cancelled_at timestamptz null,
  failed_at timestamptz null,
  bounced_at timestamptz null,

  -- Open tracking storage only (no pixel). First open preserved.
  opened_ip text null
    check (opened_ip is null or char_length(opened_ip) <= 64),
  opened_user_agent text null
    check (opened_user_agent is null or char_length(opened_user_agent) <= 512),
  open_count integer not null default 0
    check (open_count >= 0),
  last_opened_at timestamptz null,

  last_error_code text null
    check (last_error_code is null or char_length(last_error_code) <= 120),
  last_error_message text null
    check (last_error_message is null or char_length(last_error_message) <= 1000),

  correlation_id text null
    check (
      correlation_id is null
      or correlation_id ~ '^MG-EVT-[0-9A-Z]{8}$'
    ),

  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),

  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),

  constraint tenant_contract_invitations_tenant_id_key
    unique (tenant_id, id),

  constraint tenant_contract_invitations_envelope_signer_key
    unique (tenant_id, envelope_id, signer_id),

  constraint tenant_contract_invitations_envelope_fk
    foreign key (tenant_id, envelope_id)
    references public.tenant_contract_envelopes (tenant_id, id)
    on delete cascade,

  constraint tenant_contract_invitations_signer_fk
    foreign key (tenant_id, signer_id)
    references public.tenant_contract_signers (tenant_id, id)
    on delete cascade
);

comment on table public.tenant_contract_invitations is
  'CH-013A.1 stable Invitation aggregate (one per tenant+envelope+signer). Link expiration lives on generations, not here.';

comment on column public.tenant_contract_invitations.current_generation is
  'Latest generation_number. Resend increments. 0 means no generation created yet.';

create index if not exists tenant_contract_invitations_tenant_status_idx
  on public.tenant_contract_invitations (tenant_id, status);

create index if not exists tenant_contract_invitations_tenant_envelope_idx
  on public.tenant_contract_invitations (tenant_id, envelope_id);

create index if not exists tenant_contract_invitations_tenant_correlation_idx
  on public.tenant_contract_invitations (tenant_id, correlation_id);

create or replace function public.tenant_contract_invitations_assert_refs()
returns trigger
language plpgsql
as $$
declare
  v_env_package uuid;
  v_env_project uuid;
  v_env_quote uuid;
  v_signer_envelope uuid;
begin
  select e.package_id, e.project_id, e.quote_id
    into v_env_package, v_env_project, v_env_quote
  from public.tenant_contract_envelopes e
  where e.id = new.envelope_id
    and e.tenant_id = new.tenant_id;

  if not found then
    raise exception 'contract_invitation_envelope_missing' using errcode = '23503';
  end if;

  select s.envelope_id into v_signer_envelope
  from public.tenant_contract_signers s
  where s.id = new.signer_id
    and s.tenant_id = new.tenant_id;

  if not found then
    raise exception 'contract_invitation_signer_missing' using errcode = '23503';
  end if;

  if v_signer_envelope is distinct from new.envelope_id then
    raise exception 'contract_invitation_signer_envelope_mismatch' using errcode = '23514';
  end if;

  if new.package_id is null then
    new.package_id := v_env_package;
  end if;
  if new.project_id is null then
    new.project_id := v_env_project;
  end if;
  if new.quote_id is null then
    new.quote_id := v_env_quote;
  end if;

  new.updated_at := timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists tenant_contract_invitations_assert_refs_bi
  on public.tenant_contract_invitations;
create trigger tenant_contract_invitations_assert_refs_bi
  before insert on public.tenant_contract_invitations
  for each row
  execute function public.tenant_contract_invitations_assert_refs();

drop trigger if exists tenant_contract_invitations_assert_refs_bu
  on public.tenant_contract_invitations;
create trigger tenant_contract_invitations_assert_refs_bu
  before update on public.tenant_contract_invitations
  for each row
  execute function public.tenant_contract_invitations_assert_refs();

create or replace function public.tenant_contract_invitations_protect_terminal()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'signed' and new.status is distinct from 'signed' then
    raise exception 'contract_invitation_signed_immutable' using errcode = '23514';
  end if;
  if old.status = 'expired' and new.status is distinct from 'expired' then
    raise exception 'contract_invitation_expired_terminal' using errcode = '23514';
  end if;
  if old.status = 'revoked' and new.status is distinct from 'revoked' then
    raise exception 'contract_invitation_revoked_terminal' using errcode = '23514';
  end if;
  if old.status = 'cancelled' and new.status is distinct from 'cancelled' then
    raise exception 'contract_invitation_cancelled_terminal' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists tenant_contract_invitations_protect_signed_bu
  on public.tenant_contract_invitations;
drop trigger if exists tenant_contract_invitations_protect_terminal_bu
  on public.tenant_contract_invitations;
create trigger tenant_contract_invitations_protect_terminal_bu
  before update on public.tenant_contract_invitations
  for each row
  execute function public.tenant_contract_invitations_protect_terminal();

alter table public.tenant_contract_invitations enable row level security;

drop policy if exists "service role full access tenant_contract_invitations"
  on public.tenant_contract_invitations;
create policy "service role full access tenant_contract_invitations"
  on public.tenant_contract_invitations
  for all
  to service_role
  using (true)
  with check (true);

revoke all on table public.tenant_contract_invitations from public;
revoke all on table public.tenant_contract_invitations from anon;
revoke all on table public.tenant_contract_invitations from authenticated;
grant all on table public.tenant_contract_invitations to service_role;

-- ---------------------------------------------------------------------------
-- 2) Invitation generations (token-bound epochs; history immutable)
-- ---------------------------------------------------------------------------
create table if not exists public.tenant_contract_invitation_generations (
  id uuid primary key default gen_random_uuid(),

  tenant_id uuid not null
    references public.tenants (id) on delete cascade,

  invitation_id uuid not null,

  generation_number integer not null
    check (generation_number >= 1),

  token_id uuid not null,

  status text not null default 'active'
    check (status in ('active', 'revoked', 'expired', 'superseded', 'consumed')),

  expires_at timestamptz not null,

  revoked_at timestamptz null,

  reason text not null default 'initial_send'
    check (reason in (
      'initial_send',
      'owner_resend',
      'email_correction',
      'security_rotation'
    )),

  created_at timestamptz not null default timezone('utc', now()),

  constraint tenant_contract_invitation_generations_tenant_id_key
    unique (tenant_id, id),

  constraint tenant_contract_invitation_generations_inv_gen_key
    unique (tenant_id, invitation_id, generation_number),

  constraint tenant_contract_invitation_generations_invitation_fk
    foreign key (tenant_id, invitation_id)
    references public.tenant_contract_invitations (tenant_id, id)
    on delete cascade,

  constraint tenant_contract_invitation_generations_token_fk
    foreign key (tenant_id, token_id)
    references public.tenant_contract_signing_tokens (tenant_id, id)
    on delete restrict
);

comment on table public.tenant_contract_invitation_generations is
  'CH-013A.1 invitation generations. One active generation per invitation. token_id only (never raw token). expires_at equals token.expires_at and cannot exceed envelope.expires_at.';

comment on column public.tenant_contract_invitation_generations.reason is
  'initial_send | owner_resend | email_correction | security_rotation';

-- Exactly one active generation per invitation
create unique index if not exists tenant_contract_invitation_generations_one_active_idx
  on public.tenant_contract_invitation_generations (tenant_id, invitation_id)
  where status = 'active';

create index if not exists tenant_contract_invitation_generations_token_idx
  on public.tenant_contract_invitation_generations (tenant_id, token_id);

create or replace function public.tenant_contract_invitation_generations_assert_refs()
returns trigger
language plpgsql
as $$
declare
  v_inv_envelope uuid;
  v_inv_signer uuid;
  v_tok_envelope uuid;
  v_tok_signer uuid;
  v_tok_status text;
  v_tok_expires timestamptz;
  v_env_expires timestamptz;
  v_env_status text;
begin
  select i.envelope_id, i.signer_id
    into v_inv_envelope, v_inv_signer
  from public.tenant_contract_invitations i
  where i.id = new.invitation_id
    and i.tenant_id = new.tenant_id;

  if not found then
    raise exception 'contract_invitation_generation_invitation_missing' using errcode = '23503';
  end if;

  select t.envelope_id, t.signer_id, t.status, t.expires_at
    into v_tok_envelope, v_tok_signer, v_tok_status, v_tok_expires
  from public.tenant_contract_signing_tokens t
  where t.id = new.token_id
    and t.tenant_id = new.tenant_id;

  if not found then
    raise exception 'contract_invitation_generation_token_missing' using errcode = '23503';
  end if;

  if v_tok_envelope is distinct from v_inv_envelope
     or v_tok_signer is distinct from v_inv_signer then
    raise exception 'contract_invitation_generation_token_scope_mismatch' using errcode = '23514';
  end if;

  if tg_op = 'INSERT' and new.status = 'active' and v_tok_status is distinct from 'active' then
    raise exception 'contract_invitation_generation_token_not_active' using errcode = '23514';
  end if;

  -- Token expiration must equal generation expiration
  if v_tok_expires is distinct from new.expires_at then
    raise exception 'contract_invitation_generation_token_expires_mismatch' using errcode = '23514';
  end if;

  select e.expires_at, e.status
    into v_env_expires, v_env_status
  from public.tenant_contract_envelopes e
  where e.id = v_inv_envelope
    and e.tenant_id = new.tenant_id;

  -- Generation cannot exceed envelope deadline when envelope has one
  if v_env_expires is not null and new.expires_at > v_env_expires then
    raise exception 'contract_invitation_generation_exceeds_envelope_deadline' using errcode = '23514';
  end if;

  -- Envelope terminal states cannot have a new active generation
  if new.status = 'active' and v_env_status in ('completed', 'cancelled', 'declined', 'expired') then
    raise exception 'contract_invitation_generation_envelope_terminal' using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists tenant_contract_invitation_generations_assert_refs_bi
  on public.tenant_contract_invitation_generations;
create trigger tenant_contract_invitation_generations_assert_refs_bi
  before insert on public.tenant_contract_invitation_generations
  for each row
  execute function public.tenant_contract_invitation_generations_assert_refs();

drop trigger if exists tenant_contract_invitation_generations_assert_refs_bu
  on public.tenant_contract_invitation_generations;
create trigger tenant_contract_invitation_generations_assert_refs_bu
  before update on public.tenant_contract_invitation_generations
  for each row
  execute function public.tenant_contract_invitation_generations_assert_refs();

-- Generation history immutable except controlled status/revoked_at transitions
create or replace function public.tenant_contract_invitation_generations_protect_update()
returns trigger
language plpgsql
as $$
begin
  if old.tenant_id is distinct from new.tenant_id
     or old.invitation_id is distinct from new.invitation_id
     or old.generation_number is distinct from new.generation_number
     or old.token_id is distinct from new.token_id
     or old.expires_at is distinct from new.expires_at
     or old.reason is distinct from new.reason
     or old.created_at is distinct from new.created_at
     or old.id is distinct from new.id then
    raise exception 'contract_invitation_generation_immutable_fields' using errcode = '23514';
  end if;

  if old.status in ('revoked', 'expired', 'superseded', 'consumed')
     and new.status is distinct from old.status then
    raise exception 'contract_invitation_generation_terminal' using errcode = '23514';
  end if;

  if old.status = 'active' and new.status is distinct from 'active' then
    if new.status not in ('revoked', 'expired', 'superseded', 'consumed') then
      raise exception 'contract_invitation_generation_illegal_transition' using errcode = '23514';
    end if;
    if new.status = 'revoked' and new.revoked_at is null then
      new.revoked_at := timezone('utc', now());
    end if;
  elsif old.status = 'active' and new.status = 'active' then
    if old.revoked_at is distinct from new.revoked_at then
      raise exception 'contract_invitation_generation_immutable_fields' using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.tenant_contract_invitation_generations_protect_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception 'contract_invitation_generation_delete_forbidden' using errcode = '23514';
end;
$$;

drop trigger if exists tenant_contract_invitation_generations_protect_bu
  on public.tenant_contract_invitation_generations;
create trigger tenant_contract_invitation_generations_protect_bu
  before update on public.tenant_contract_invitation_generations
  for each row
  execute function public.tenant_contract_invitation_generations_protect_update();

drop trigger if exists tenant_contract_invitation_generations_protect_bd
  on public.tenant_contract_invitation_generations;
create trigger tenant_contract_invitation_generations_protect_bd
  before delete on public.tenant_contract_invitation_generations
  for each row
  execute function public.tenant_contract_invitation_generations_protect_delete();

drop function if exists public.tenant_contract_invitation_generations_protect();

alter table public.tenant_contract_invitation_generations enable row level security;

drop policy if exists "service role full access tenant_contract_invitation_generations"
  on public.tenant_contract_invitation_generations;
create policy "service role full access tenant_contract_invitation_generations"
  on public.tenant_contract_invitation_generations
  for all
  to service_role
  using (true)
  with check (true);

revoke all on table public.tenant_contract_invitation_generations from public;
revoke all on table public.tenant_contract_invitation_generations from anon;
revoke all on table public.tenant_contract_invitation_generations from authenticated;
grant all on table public.tenant_contract_invitation_generations to service_role;

-- ---------------------------------------------------------------------------
-- 3) Delivery attempts — controlled status updates (NOT fully append-only)
-- Chosen model: same attempt row transitions queued→sending→sent|failed|bounced.
-- DELETE forbidden. Identity/provider fields immutable once set.
-- ---------------------------------------------------------------------------
create table if not exists public.tenant_contract_invitation_delivery_attempts (
  attempt_id uuid primary key default gen_random_uuid(),

  tenant_id uuid not null
    references public.tenants (id) on delete cascade,

  invitation_id uuid not null,
  generation_id uuid null,

  provider text not null default 'none'
    check (char_length(trim(provider)) > 0 and char_length(provider) <= 80),

  provider_message_id text null
    check (
      provider_message_id is null
      or char_length(provider_message_id) <= 200
    ),

  status text not null default 'queued'
    check (status in (
      'queued',
      'sending',
      'sent',
      'delivered',
      'failed',
      'bounced',
      'cancelled'
    )),

  started_at timestamptz not null default timezone('utc', now()),
  completed_at timestamptz null,

  error_code text null
    check (error_code is null or char_length(error_code) <= 120),
  error_message text null
    check (error_message is null or char_length(error_message) <= 1000),

  retry_number integer not null default 0
    check (retry_number >= 0),

  created_at timestamptz not null default timezone('utc', now()),

  constraint tenant_contract_invitation_delivery_attempts_tenant_attempt_key
    unique (tenant_id, attempt_id),

  constraint tenant_contract_invitation_delivery_attempts_invitation_fk
    foreign key (tenant_id, invitation_id)
    references public.tenant_contract_invitations (tenant_id, id)
    on delete cascade,

  constraint tenant_contract_invitation_delivery_attempts_generation_fk
    foreign key (tenant_id, generation_id)
    references public.tenant_contract_invitation_generations (tenant_id, id)
    on delete set null
);

comment on table public.tenant_contract_invitation_delivery_attempts is
  'CH-013A.1 delivery attempts. Controlled status transitions only. DELETE forbidden. No provider API keys.';

create index if not exists tenant_contract_invitation_delivery_attempts_inv_idx
  on public.tenant_contract_invitation_delivery_attempts (tenant_id, invitation_id, started_at desc);

create or replace function public.tenant_contract_invitation_delivery_attempts_protect_update()
returns trigger
language plpgsql
as $$
declare
  v_terminal boolean;
begin
  -- Immutable identity / reference / provider identity once set
  if old.attempt_id is distinct from new.attempt_id
     or old.tenant_id is distinct from new.tenant_id
     or old.invitation_id is distinct from new.invitation_id
     or old.retry_number is distinct from new.retry_number
     or old.started_at is distinct from new.started_at
     or old.created_at is distinct from new.created_at then
    raise exception 'contract_invitation_attempt_immutable_fields' using errcode = '23514';
  end if;

  if old.generation_id is not null
     and new.generation_id is distinct from old.generation_id then
    raise exception 'contract_invitation_attempt_immutable_fields' using errcode = '23514';
  end if;

  if old.provider is distinct from new.provider then
    raise exception 'contract_invitation_attempt_immutable_fields' using errcode = '23514';
  end if;

  if old.provider_message_id is not null
     and new.provider_message_id is distinct from old.provider_message_id then
    raise exception 'contract_invitation_attempt_immutable_fields' using errcode = '23514';
  end if;

  v_terminal := old.status in ('sent', 'delivered', 'failed', 'bounced', 'cancelled');
  if v_terminal then
    raise exception 'contract_invitation_attempt_terminal' using errcode = '23514';
  end if;

  if old.status = 'queued' and new.status not in ('sending', 'cancelled', 'failed') then
    raise exception 'contract_invitation_attempt_illegal_transition' using errcode = '23514';
  end if;
  if old.status = 'sending' and new.status not in ('sent', 'delivered', 'failed', 'bounced', 'cancelled') then
    raise exception 'contract_invitation_attempt_illegal_transition' using errcode = '23514';
  end if;
  if old.status is not distinct from new.status then
    raise exception 'contract_invitation_attempt_illegal_transition' using errcode = '23514';
  end if;

  if old.completed_at is not null and new.completed_at is distinct from old.completed_at then
    raise exception 'contract_invitation_attempt_immutable_fields' using errcode = '23514';
  end if;
  if new.status in ('sent', 'delivered', 'failed', 'bounced', 'cancelled')
     and new.completed_at is null then
    new.completed_at := timezone('utc', now());
  end if;

  if new.status not in ('failed', 'bounced') then
    if new.error_code is distinct from old.error_code
       or new.error_message is distinct from old.error_message then
      if old.error_code is not null or old.error_message is not null
         or new.error_code is not null or new.error_message is not null then
        raise exception 'contract_invitation_attempt_error_fields_illegal' using errcode = '23514';
      end if;
    end if;
  else
    if old.error_code is not null and new.error_code is distinct from old.error_code then
      raise exception 'contract_invitation_attempt_immutable_fields' using errcode = '23514';
    end if;
    if old.error_message is not null and new.error_message is distinct from old.error_message then
      raise exception 'contract_invitation_attempt_immutable_fields' using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.tenant_contract_invitation_delivery_attempts_protect_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception 'contract_invitation_attempt_delete_forbidden' using errcode = '23514';
end;
$$;

drop trigger if exists tenant_contract_invitation_delivery_attempts_no_update
  on public.tenant_contract_invitation_delivery_attempts;
drop trigger if exists tenant_contract_invitation_delivery_attempts_no_delete
  on public.tenant_contract_invitation_delivery_attempts;
drop trigger if exists tenant_contract_invitation_delivery_attempts_protect_bu
  on public.tenant_contract_invitation_delivery_attempts;
create trigger tenant_contract_invitation_delivery_attempts_protect_bu
  before update on public.tenant_contract_invitation_delivery_attempts
  for each row
  execute function public.tenant_contract_invitation_delivery_attempts_protect_update();

drop trigger if exists tenant_contract_invitation_delivery_attempts_protect_bd
  on public.tenant_contract_invitation_delivery_attempts;
create trigger tenant_contract_invitation_delivery_attempts_protect_bd
  before delete on public.tenant_contract_invitation_delivery_attempts
  for each row
  execute function public.tenant_contract_invitation_delivery_attempts_protect_delete();

drop function if exists public.tenant_contract_invitation_delivery_attempts_protect();
drop function if exists public.tenant_contract_invitation_delivery_attempts_reject_mutation();

alter table public.tenant_contract_invitation_delivery_attempts enable row level security;

drop policy if exists "service role full access tenant_contract_invitation_delivery_attempts"
  on public.tenant_contract_invitation_delivery_attempts;
create policy "service role full access tenant_contract_invitation_delivery_attempts"
  on public.tenant_contract_invitation_delivery_attempts
  for all
  to service_role
  using (true)
  with check (true);

revoke all on table public.tenant_contract_invitation_delivery_attempts from public;
revoke all on table public.tenant_contract_invitation_delivery_attempts from anon;
revoke all on table public.tenant_contract_invitation_delivery_attempts from authenticated;
grant all on table public.tenant_contract_invitation_delivery_attempts to service_role;
