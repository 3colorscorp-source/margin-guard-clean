-- CH-013A.2.1 — Atomic invitation generation rotation (service-role RPC)
-- MANUAL SUPABASE APPLY ONLY. Do not auto-apply from app deploy.
--
-- Invariant (externally visible):
--   At every committed snapshot the invitation has either
--   (A) prior active generation/token still valid, or
--   (B) new generation/token fully active with current_generation advanced.
-- Never: zero active gens, two active gens, or current_generation → revoked/missing.
--
-- Design A: single SECURITY DEFINER function runs revoke+create+advance in ONE transaction.
-- App mints raw token off-DB; RPC binds token_hash/id only (never plaintext).

do $$
begin
  if to_regclass('public.tenant_contract_invitations') is null then
    raise exception 'CH-013A.2.1 atomic rotation blocked: missing invitations';
  end if;
  if to_regclass('public.tenant_contract_invitation_generations') is null then
    raise exception 'CH-013A.2.1 atomic rotation blocked: missing generations';
  end if;
  if to_regclass('public.tenant_contract_signing_tokens') is null then
    raise exception 'CH-013A.2.1 atomic rotation blocked: missing signing tokens';
  end if;
end;
$$;

-- Allow recording provider_message_id while status remains sending (accepted_db_pending).
-- Same-status update is permitted ONLY when setting provider_message_id from null → value
-- and no other protected fields change. Enables DB finalization without a second provider send.
create or replace function public.tenant_contract_invitation_delivery_attempts_protect_update()
returns trigger
language plpgsql
as $$
declare
  v_terminal boolean;
  v_pmid_only boolean;
begin
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

  -- accepted_db_pending: allow writing provider_message_id once while staying in sending
  v_pmid_only :=
    old.status = 'sending'
    and new.status = 'sending'
    and old.provider_message_id is null
    and new.provider_message_id is not null
    and old.error_code is not distinct from new.error_code
    and old.error_message is not distinct from new.error_message
    and old.completed_at is not distinct from new.completed_at;

  if old.status is not distinct from new.status and not v_pmid_only then
    raise exception 'contract_invitation_attempt_illegal_transition' using errcode = '23514';
  end if;

  if old.status = 'queued' and new.status not in ('sending', 'cancelled', 'failed') then
    raise exception 'contract_invitation_attempt_illegal_transition' using errcode = '23514';
  end if;
  if old.status = 'sending' and new.status not in ('sending', 'sent', 'delivered', 'failed', 'bounced', 'cancelled') then
    raise exception 'contract_invitation_attempt_illegal_transition' using errcode = '23514';
  end if;
  -- sending → sending only via v_pmid_only (handled above)

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
        if not v_pmid_only then
          raise exception 'contract_invitation_attempt_error_fields_illegal' using errcode = '23514';
        end if;
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

create or replace function public.rotate_contract_invitation_generation(
  p_tenant_id uuid,
  p_invitation_id uuid,
  p_new_token_id uuid,
  p_token_hash text,
  p_expires_at timestamptz,
  p_reason text default 'security_rotation',
  p_idempotency_key text default null,
  p_expected_prior_generation integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv public.tenant_contract_invitations%rowtype;
  v_prior public.tenant_contract_invitation_generations%rowtype;
  v_env_status text;
  v_env_expires timestamptz;
  v_signer_id uuid;
  v_envelope_id uuid;
  v_prior_num integer;
  v_next_num integer;
  v_new_gen public.tenant_contract_invitation_generations%rowtype;
  v_meta jsonb;
  v_existing_key text;
  v_now timestamptz := timezone('utc', now());
begin
  if p_tenant_id is null or p_invitation_id is null then
    raise exception 'atomic_rotation_invalid_id' using errcode = '22023';
  end if;
  if p_new_token_id is null then
    raise exception 'atomic_rotation_token_id_required' using errcode = '22023';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'atomic_rotation_invalid_token_hash' using errcode = '22023';
  end if;
  if p_expires_at is null or p_expires_at <= v_now then
    raise exception 'atomic_rotation_invalid_expires_at' using errcode = '22023';
  end if;
  if p_reason is null or p_reason not in (
    'initial_send', 'owner_resend', 'email_correction', 'security_rotation'
  ) then
    raise exception 'atomic_rotation_invalid_reason' using errcode = '22023';
  end if;

  -- Serialize all rotations for this invitation
  select *
    into v_inv
  from public.tenant_contract_invitations
  where tenant_id = p_tenant_id
    and id = p_invitation_id
  for update;

  if not found then
    raise exception 'atomic_rotation_invitation_missing' using errcode = 'P0002';
  end if;

  if v_inv.status in ('signed', 'expired', 'revoked', 'cancelled') then
    raise exception 'atomic_rotation_invitation_terminal' using errcode = '23514';
  end if;

  v_meta := coalesce(v_inv.metadata, '{}'::jsonb);
  v_existing_key := nullif(v_meta->>'rotation_idempotency_key', '');

  -- Idempotent replay: return already-active generation for same key
  if p_idempotency_key is not null
     and length(trim(p_idempotency_key)) > 0
     and v_existing_key is not distinct from trim(p_idempotency_key) then
    select *
      into v_new_gen
    from public.tenant_contract_invitation_generations
    where tenant_id = p_tenant_id
      and invitation_id = p_invitation_id
      and status = 'active'
    limit 1;

    if found then
      return jsonb_build_object(
        'ok', true,
        'idempotent', true,
        'invitation_id', v_inv.id,
        'generation_id', v_new_gen.id,
        'generation_number', v_new_gen.generation_number,
        'token_id', v_new_gen.token_id,
        'prior_generation_number', null,
        'prior_generation_id', null,
        'prior_token_id', null,
        'expires_at', v_new_gen.expires_at,
        'reason', v_new_gen.reason,
        'current_generation', v_inv.current_generation
      );
    end if;
  end if;

  v_signer_id := v_inv.signer_id;
  v_envelope_id := v_inv.envelope_id;

  select e.status, e.expires_at
    into v_env_status, v_env_expires
  from public.tenant_contract_envelopes e
  where e.tenant_id = p_tenant_id
    and e.id = v_envelope_id;

  if not found then
    raise exception 'atomic_rotation_envelope_missing' using errcode = 'P0002';
  end if;
  if v_env_status in ('completed', 'cancelled', 'declined', 'expired') then
    raise exception 'atomic_rotation_envelope_terminal' using errcode = '23514';
  end if;
  if v_env_expires is not null and p_expires_at > v_env_expires then
    raise exception 'atomic_rotation_exceeds_envelope_deadline' using errcode = '23514';
  end if;

  select *
    into v_prior
  from public.tenant_contract_invitation_generations
  where tenant_id = p_tenant_id
    and invitation_id = p_invitation_id
    and status = 'active'
  for update;

  v_prior_num := coalesce(v_inv.current_generation, 0);
  if found then
    v_prior_num := v_prior.generation_number;
  else
    select coalesce(max(generation_number), 0)
      into v_prior_num
    from public.tenant_contract_invitation_generations
    where tenant_id = p_tenant_id
      and invitation_id = p_invitation_id;
    if v_prior_num < coalesce(v_inv.current_generation, 0) then
      v_prior_num := v_inv.current_generation;
    end if;
  end if;

  if p_expected_prior_generation is not null
     and p_expected_prior_generation is distinct from v_prior_num then
    raise exception 'atomic_rotation_prior_generation_mismatch' using errcode = '23514';
  end if;

  v_next_num := v_prior_num + 1;
  if v_next_num < 1 then
    v_next_num := 1;
  end if;

  -- 1) Revoke prior generation (if any) — still uncommitted / not externally visible
  if v_prior.id is not null then
    update public.tenant_contract_invitation_generations
       set status = 'revoked',
           revoked_at = v_now
     where tenant_id = p_tenant_id
       and id = v_prior.id
       and status = 'active';

    if v_prior.token_id is not null then
      update public.tenant_contract_signing_tokens
         set status = 'revoked',
             revoked_at = v_now,
             updated_at = v_now
       where tenant_id = p_tenant_id
         and id = v_prior.token_id
         and status = 'active';
    end if;
  end if;

  -- 2) Insert new token (hash only — never raw)
  insert into public.tenant_contract_signing_tokens (
    id, tenant_id, envelope_id, signer_id, token_hash, status, expires_at
  ) values (
    p_new_token_id,
    p_tenant_id,
    v_envelope_id,
    v_signer_id,
    p_token_hash,
    'active',
    p_expires_at
  );

  -- 3) Insert Generation N+1 bound to new token
  insert into public.tenant_contract_invitation_generations (
    tenant_id, invitation_id, generation_number, token_id, status, expires_at, reason
  ) values (
    p_tenant_id,
    p_invitation_id,
    v_next_num,
    p_new_token_id,
    'active',
    p_expires_at,
    p_reason
  )
  returning * into v_new_gen;

  -- 4) Advance current_generation + rotation idempotency (safe metadata merge)
  v_meta := coalesce(v_inv.metadata, '{}'::jsonb);
  if p_idempotency_key is not null and length(trim(p_idempotency_key)) > 0 then
    v_meta := v_meta || jsonb_build_object(
      'rotation_idempotency_key', trim(p_idempotency_key),
      'rotation_generation_id', v_new_gen.id,
      'rotation_at', v_now
    );
  end if;

  update public.tenant_contract_invitations
     set current_generation = v_next_num,
         metadata = v_meta,
         updated_at = v_now
   where tenant_id = p_tenant_id
     and id = p_invitation_id;

  -- Post-condition checks inside the same transaction
  if (
    select count(*)::int
    from public.tenant_contract_invitation_generations
    where tenant_id = p_tenant_id
      and invitation_id = p_invitation_id
      and status = 'active'
  ) <> 1 then
    raise exception 'atomic_rotation_active_generation_invariant' using errcode = '23514';
  end if;

  if (
    select count(*)::int
    from public.tenant_contract_signing_tokens
    where tenant_id = p_tenant_id
      and signer_id = v_signer_id
      and status = 'active'
  ) <> 1 then
    raise exception 'atomic_rotation_active_token_invariant' using errcode = '23514';
  end if;

  return jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'invitation_id', p_invitation_id,
    'generation_id', v_new_gen.id,
    'generation_number', v_next_num,
    'token_id', p_new_token_id,
    'prior_generation_number', case when v_prior.id is null then null else v_prior.generation_number end,
    'prior_generation_id', v_prior.id,
    'prior_token_id', v_prior.token_id,
    'expires_at', p_expires_at,
    'reason', p_reason,
    'current_generation', v_next_num
  );
exception
  when others then
    -- Function body is transactional; any exception rolls back all writes.
    raise;
end;
$$;

comment on function public.rotate_contract_invitation_generation(
  uuid, uuid, uuid, text, timestamptz, text, text, integer
) is
  'CH-013A.2.1 atomic generation rotation. Revoke prior + create Gen N+1 + advance current_generation in one transaction. Binds token_hash only (never raw token).';

revoke all on function public.rotate_contract_invitation_generation(
  uuid, uuid, uuid, text, timestamptz, text, text, integer
) from public;
revoke all on function public.rotate_contract_invitation_generation(
  uuid, uuid, uuid, text, timestamptz, text, text, integer
) from anon;
revoke all on function public.rotate_contract_invitation_generation(
  uuid, uuid, uuid, text, timestamptz, text, text, integer
) from authenticated;
grant execute on function public.rotate_contract_invitation_generation(
  uuid, uuid, uuid, text, timestamptz, text, text, integer
) to service_role;
