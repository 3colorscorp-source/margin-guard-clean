-- CH-011H VERIFY — Audit Certificate foundation
-- Run AFTER SUPABASE_CH011H_CONTRACT_CERTIFICATES.sql. MANUAL SUPABASE APPLY.

do $$
begin
  if to_regclass('public.tenant_contract_certificates') is null then
    raise exception 'CH-011H VERIFY FAIL: missing tenant_contract_certificates';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenant_contract_certificates'::regclass
      and conname = 'tenant_contract_certificates_tenant_envelope_key'
  ) then
    raise exception 'CH-011H VERIFY FAIL: one-certificate-per-envelope unique missing';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'tenant_contract_certificates'
      and policyname = 'service role full access tenant_contract_certificates'
  ) then
    raise exception 'CH-011H VERIFY FAIL: RLS policy missing';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'tenant_contract_certificates_protect_immutable'
  ) then
    raise exception 'CH-011H VERIFY FAIL: immutability function missing';
  end if;

  raise notice 'CH-011H VERIFY PASS: certificates table + RLS + immutability present';
  raise notice 'CH-011H VERIFY COMPLETE';
end;
$$;
