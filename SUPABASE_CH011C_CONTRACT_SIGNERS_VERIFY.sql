-- CH-011C VERIFY — Contract Signers foundation
-- Run AFTER SUPABASE_CH011C_CONTRACT_SIGNERS.sql. MANUAL SUPABASE APPLY.

do $$
declare
  v_tenant uuid;
  v_project uuid;
  v_quote uuid;
  v_pkg uuid;
  v_env uuid;
  v_signer uuid;
  v_signer2 uuid;
  v_hit boolean := false;
begin
  if to_regclass('public.tenant_contract_signers') is null then
    raise exception
      'CH-011C VERIFY FAIL: relation public.tenant_contract_signers does not exist. Run SUPABASE_CH011C_CONTRACT_SIGNERS.sql first.';
  end if;

  select id into v_tenant from public.tenants order by id limit 1;
  if v_tenant is null then
    raise exception 'CH-011C VERIFY FAIL: no tenants row';
  end if;

  select id, quote_id into v_project, v_quote
  from public.tenant_projects
  where tenant_id = v_tenant
    and quote_id is not null
  order by id
  limit 1;

  if v_project is null or v_quote is null then
    raise notice 'CH-011C VERIFY SKIP: no tenant_projects with quote_id for insert tests';
  else
    insert into public.tenant_contract_packages (
      tenant_id, project_id, quote_id, version, status,
      snapshot_json, content_hash, source_readiness
    ) values (
      v_tenant, v_project, v_quote, 920001, 'ready',
      '{"schema":"ch-011c-verify"}'::jsonb,
      repeat('d', 64),
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
      role, party_name, email, phone, sign_order, status, auth_method, is_required
    ) values (
      v_tenant, v_env, v_pkg, v_project,
      'customer', 'Customer One', 'customer-verify@example.com', '', 1, 'pending', 'email_link', true
    )
    returning id into v_signer;
    raise notice 'CH-011C VERIFY PASS: customer signer insert';

    begin
      insert into public.tenant_contract_signers (
        tenant_id, envelope_id, package_id, project_id,
        role, party_name, email, sign_order, auth_method
      ) values (
        v_tenant, v_env, v_pkg, v_project,
        'additional', 'Other', 'Customer-Verify@example.com', 2, 'in_app'
      );
      raise exception 'CH-011C VERIFY FAIL: duplicate email allowed';
    exception
      when unique_violation then
        raise notice 'CH-011C VERIFY PASS: duplicate email blocked';
        v_hit := true;
    end;
    if not v_hit then
      raise exception 'CH-011C VERIFY FAIL: email uniqueness did not fire';
    end if;

    insert into public.tenant_contract_signers (
      tenant_id, envelope_id, package_id, project_id,
      role, party_name, email, sign_order, auth_method, is_required
    ) values (
      v_tenant, v_env, v_pkg, v_project,
      'owner', 'Owner One', 'owner-verify@example.com', 2, 'in_app', false
    )
    returning id into v_signer2;
    raise notice 'CH-011C VERIFY PASS: owner signer insert';

    begin
      insert into public.tenant_contract_signers (
        tenant_id, envelope_id, package_id, project_id,
        role, party_name, email, sign_order, auth_method
      ) values (
        v_tenant, v_env, v_pkg, v_project,
        'bogus', 'X', 'x@example.com', 3, 'email_link'
      );
      raise exception 'CH-011C VERIFY FAIL: invalid role allowed';
    exception
      when check_violation then
        raise notice 'CH-011C VERIFY PASS: invalid role blocked';
    end;

    delete from public.tenant_contract_signers where id in (v_signer, v_signer2);
    delete from public.tenant_contract_envelopes where id = v_env;
    delete from public.tenant_contract_packages where id = v_pkg;
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'tenant_contract_signers'
      and policyname = 'service role full access tenant_contract_signers'
  ) then
    raise exception 'CH-011C VERIFY FAIL: RLS policy missing';
  end if;
  raise notice 'CH-011C VERIFY PASS: RLS policy present';

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'tenant_contract_signers_envelope_email_uidx'
  ) then
    raise exception 'CH-011C VERIFY FAIL: email unique index missing';
  end if;
  raise notice 'CH-011C VERIFY PASS: email unique index present';

  raise notice 'CH-011C VERIFY COMPLETE';
end;
$$;
