-- =============================================================================
-- Margin Guard | MG-SUPPORT-003E.2D1 VERIFY (read-only)
-- =============================================================================
-- STATUS: MANUAL. Do not run from CI. Does not insert, update, or delete rows.
-- Run only after SUPABASE_MG_SUPPORT_003E_2D1_ATOMIC_CASE_TRANSITION_OUTBOX.sql
-- is applied. Do not apply or run in the D1 local-only phase.
--
-- SECURITY: p.prosecdef = false is the authoritative INVOKER proof.
-- pg_get_functiondef() may omit the literal SECURITY INVOKER clause because
-- INVOKER is the PostgreSQL default. Do not require that text.
-- =============================================================================

do $$
declare
  v_oid oid;
  v_definer boolean;
  v_src text;
  v_acl text;
  v_identity text;
  v_proconfig text[];
  v_proacl aclitem[];
  v_name_count integer;
  v_expected_identity constant text := 'uuid, text, integer, text, text, boolean, text';
begin
  select count(*)::integer
    into v_name_count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'mg_support_transition_case';

  if v_name_count is null or v_name_count = 0 then
    raise exception 'MG-SUPPORT-003E.2D1 VERIFY FAIL: function missing';
  end if;

  if v_name_count <> 1 then
    raise exception 'MG-SUPPORT-003E.2D1 VERIFY FAIL: unexpected overloads: %', v_name_count;
  end if;

  select p.oid,
         p.prosecdef,
         pg_get_functiondef(p.oid),
         pg_get_function_identity_arguments(p.oid),
         p.proconfig,
         p.proacl
    into v_oid, v_definer, v_src, v_identity, v_proconfig, v_proacl
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'mg_support_transition_case'
     and pg_get_function_identity_arguments(p.oid) = v_expected_identity;

  if v_oid is null then
    raise exception 'MG-SUPPORT-003E.2D1 VERIFY FAIL: expected identity missing: %', v_expected_identity;
  end if;

  if v_identity is distinct from v_expected_identity then
    raise exception 'MG-SUPPORT-003E.2D1 VERIFY FAIL: unexpected identity arguments: %', v_identity;
  end if;

  -- Canonical SECURITY INVOKER proof: prosecdef must be false.
  if v_definer is distinct from false then
    raise exception 'MG-SUPPORT-003E.2D1 VERIFY FAIL: SECURITY INVOKER required (prosecdef must be false)';
  end if;

  if v_src !~* 'and c.status = p_expected_status' or v_src !~* 'and c.status_version = p_expected_status_version' then
    raise exception 'MG-SUPPORT-003E.2D1 VERIFY FAIL: CAS predicates missing';
  end if;
  if v_src !~* 'status_version = c.status_version \+ 1' then
    raise exception 'MG-SUPPORT-003E.2D1 VERIFY FAIL: version increment missing';
  end if;

  if v_src !~* 'mark_in_review' or v_src !~* 'request_customer_action'
     or v_src !~* 'return_to_open' or v_src !~* 'case_reopened' then
    raise exception 'MG-SUPPORT-003E.2D1 VERIFY FAIL: closed action/event mapping missing';
  end if;

  if v_src !~* 'v_event_type := null' then
    raise exception 'MG-SUPPORT-003E.2D1 VERIFY FAIL: return_to_open must map to no event';
  end if;

  if v_src !~* 'tenant_support_notification_outbox' or v_src !~* 'delivery_status' then
    raise exception 'MG-SUPPORT-003E.2D1 VERIFY FAIL: outbox insert missing';
  end if;

  if v_src ~* 'p_tenant_id' or v_src ~* 'recipient_email' or v_src ~* 'owner_email'
     or v_src ~* 'p_event_type' or v_src ~* 'p_to_status' then
    raise exception 'MG-SUPPORT-003E.2D1 VERIFY FAIL: forbidden RPC parameter present';
  end if;

  if v_src ~* 'zapier' or v_src ~* 'hmac' or v_src ~* 'gmail' then
    raise exception 'MG-SUPPORT-003E.2D1 VERIFY FAIL: delivery code present';
  end if;

  if coalesce(array_to_string(v_proconfig, ','), '') !~* 'search_path'
     or v_src !~* 'search_path' then
    raise exception 'MG-SUPPORT-003E.2D1 VERIFY FAIL: search_path not pinned';
  end if;

  if v_src ~* 'security definer' then
    raise exception 'MG-SUPPORT-003E.2D1 VERIFY FAIL: SECURITY DEFINER present';
  end if;

  if v_src ~* 'execute immediate' or v_src ~* 'execute format' or v_src ~* 'execute \(' then
    raise exception 'MG-SUPPORT-003E.2D1 VERIFY FAIL: dynamic SQL present';
  end if;

  v_acl := coalesce(v_proacl::text, '');

  if v_proacl is null then
    raise exception 'MG-SUPPORT-003E.2D1 VERIFY FAIL: PUBLIC EXECUTE present (default ACL): %', v_acl;
  end if;

  if exists (
    select 1
      from aclexplode(v_proacl)
     where grantee = 0
       and privilege_type = 'EXECUTE'
  ) then
    raise exception 'MG-SUPPORT-003E.2D1 VERIFY FAIL: PUBLIC EXECUTE present: %', v_acl;
  end if;

  if exists (
    select 1
      from aclexplode(v_proacl) e
      join pg_roles r on r.oid = e.grantee
     where e.privilege_type = 'EXECUTE'
       and r.rolname in ('anon', 'authenticated')
  ) or v_acl ~* 'anon' or v_acl ~* 'authenticated' then
    raise exception 'MG-SUPPORT-003E.2D1 VERIFY FAIL: client EXECUTE present: %', v_acl;
  end if;

  if not exists (
    select 1
      from aclexplode(v_proacl)
     where grantee = 'service_role'::regrole
       and privilege_type = 'EXECUTE'
  ) and not exists (
    select 1
      from information_schema.routine_privileges
     where routine_schema = 'public'
       and routine_name = 'mg_support_transition_case'
       and grantee = 'service_role'
       and privilege_type = 'EXECUTE'
  ) then
    if v_acl !~* 'service_role' then
      raise exception 'MG-SUPPORT-003E.2D1 VERIFY FAIL: service_role EXECUTE missing: %', v_acl;
    end if;
  end if;

  raise notice 'MG-SUPPORT-003E.2D1 VERIFY PASS: invoker RPC, CAS, closed mapping, service_role only';
end
$$;
