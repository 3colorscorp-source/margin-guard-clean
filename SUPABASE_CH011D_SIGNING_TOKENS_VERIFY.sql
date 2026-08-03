-- CH-011D VERIFY — Signing Tokens foundation
-- Run AFTER SUPABASE_CH011D_SIGNING_TOKENS.sql. MANUAL SUPABASE APPLY.

do $$
declare
  v_tenant uuid;
  v_project uuid;
  v_quote uuid;
  v_pkg uuid;
  v_env uuid;
  v_signer uuid;
  v_token uuid;
  v_token2 uuid;
  v_hit boolean := false;
begin
  if to_regclass('public.tenant_contract_signing_tokens') is null then
    raise exception
      'CH-011D VERIFY FAIL: relation public.tenant_contract_signing_tokens does not exist. Run SUPABASE_CH011D_SIGNING_TOKENS.sql first.';
  end if;

  select id into v_tenant from public.tenants order by id limit 1;
  if v_tenant is null then
    raise exception 'CH-011D VERIFY FAIL: no tenants row';
  end if;

  select id, quote_id into v_project, v_quote
  from public.tenant_projects
  where tenant_id = v_tenant
    and quote_id is not null
  order by id
  limit 1;

  if v_project is null or v_quote is null then
    raise notice 'CH-011D VERIFY SKIP: no tenant_projects with quote_id for insert tests';
  else
    insert into public.tenant_contract_packages (
      tenant_id, project_id, quote_id, version, status,
      snapshot_json, content_hash, source_readiness
    ) values (
      v_tenant, v_project, v_quote, 930001, 'ready',
      '{"schema":"ch-011d-verify"}'::jsonb,
      repeat('e', 64),
      '{"ok":true}'::jsonb
    )
    returning id into v_pkg;

    insert into public.tenant_contract_envelopes (
      tenant_id, package_id, project_id, quote_id, status
    ) values (
      v_tenant, v_pkg, v_project, v_quote, 'draft'
    )
    returning id into v_env;

    insert into public.tenant_contract_signers (
      tenant_id, envelope_id, package_id, project_id,
      role, party_name, email, sign_order, auth_method, is_required
    ) values (
      v_tenant, v_env, v_pkg, v_project,
      'customer', 'Token Verify', 'token-verify@example.com', 1, 'email_link', true
    )
    returning id into v_signer;

    insert into public.tenant_contract_signing_tokens (
      tenant_id, envelope_id, signer_id, token_hash, status, expires_at
    ) values (
      v_tenant, v_env, v_signer, repeat('a', 64), 'active', now() + interval '7 days'
    )
    returning id into v_token;
    raise notice 'CH-011D VERIFY PASS: active token insert';

    begin
      insert into public.tenant_contract_signing_tokens (
        tenant_id, envelope_id, signer_id, token_hash, status, expires_at
      ) values (
        v_tenant, v_env, v_signer, repeat('b', 64), 'active', now() + interval '7 days'
      );
      raise exception 'CH-011D VERIFY FAIL: duplicate active token allowed';
    exception
      when unique_violation then
        raise notice 'CH-011D VERIFY PASS: one active token per signer enforced';
        v_hit := true;
    end;
    if not v_hit then
      raise exception 'CH-011D VERIFY FAIL: active uniqueness did not fire';
    end if;

    begin
      update public.tenant_contract_signing_tokens
      set token_hash = repeat('c', 64)
      where id = v_token;
      raise exception 'CH-011D VERIFY FAIL: token_hash mutation allowed';
    exception
      when check_violation then
        raise notice 'CH-011D VERIFY PASS: token_hash immutable blocked';
      when others then
        if sqlerrm like '%signing_token_hash_immutable%' then
          raise notice 'CH-011D VERIFY PASS: token_hash immutable blocked';
        else
          raise;
        end if;
    end;

    update public.tenant_contract_signing_tokens
    set status = 'revoked', revoked_at = now()
    where id = v_token;
    raise notice 'CH-011D VERIFY PASS: revoke status allowed';

    insert into public.tenant_contract_signing_tokens (
      tenant_id, envelope_id, signer_id, token_hash, status, expires_at
    ) values (
      v_tenant, v_env, v_signer, repeat('d', 64), 'active', now() + interval '7 days'
    )
    returning id into v_token2;
    raise notice 'CH-011D VERIFY PASS: regeneration after revoke allowed';

    delete from public.tenant_contract_signing_tokens where id in (v_token, v_token2);
    delete from public.tenant_contract_signers where id = v_signer;
    delete from public.tenant_contract_envelopes where id = v_env;
    delete from public.tenant_contract_packages where id = v_pkg;
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'tenant_contract_signing_tokens'
      and policyname = 'service role full access tenant_contract_signing_tokens'
  ) then
    raise exception 'CH-011D VERIFY FAIL: RLS policy missing';
  end if;
  raise notice 'CH-011D VERIFY PASS: RLS policy present';

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'tenant_contract_signing_tokens_one_active_per_signer_uidx'
  ) then
    raise exception 'CH-011D VERIFY FAIL: one-active unique index missing';
  end if;
  raise notice 'CH-011D VERIFY PASS: one-active unique index present';

  raise notice 'CH-011D VERIFY COMPLETE';
end;
$$;
