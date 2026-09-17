-- =============================================================================
-- Margin Guard | CH-084 — Require contractor signature VERIFY (manual)
-- =============================================================================
-- Run after SUPABASE_CH084_REQUIRE_CONTRACTOR_SIGNATURE.sql
-- Structural only. Does not freeze contracts, send envelopes, or write signatures.
--
-- Success returns a Results row: ch084_verify_result = PASS
-- Any failed check raises and must not return PASS.
-- =============================================================================

do $$
declare
  v_attname name;
  v_notnull boolean;
  v_default text;
  v_typname name;
begin
  if to_regclass('public.tenant_contract_preferences') is null then
    raise exception 'CH-084 VERIFY FAIL: missing public.tenant_contract_preferences';
  end if;

  select a.attname,
         a.attnotnull,
         pg_get_expr(ad.adbin, ad.adrelid),
         t.typname
    into v_attname, v_notnull, v_default, v_typname
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_type t on t.oid = a.atttypid
    left join pg_attrdef ad
      on ad.adrelid = a.attrelid
     and ad.adnum = a.attnum
   where n.nspname = 'public'
     and c.relname = 'tenant_contract_preferences'
     and a.attname = 'require_contractor_signature'
     and a.attnum > 0
     and not a.attisdropped;

  if v_attname is null then
    raise exception 'CH-084 VERIFY FAIL: missing column require_contractor_signature';
  end if;

  if v_typname is distinct from 'bool' then
    raise exception 'CH-084 VERIFY FAIL: require_contractor_signature must be boolean, found %', v_typname;
  end if;

  if v_notnull is distinct from true then
    raise exception 'CH-084 VERIFY FAIL: require_contractor_signature must be NOT NULL';
  end if;

  if v_default is null or v_default !~* 'false' then
    raise exception 'CH-084 VERIFY FAIL: require_contractor_signature default must be false: %', v_default;
  end if;
end
$$;

select 'PASS'::text as ch084_verify_result;
