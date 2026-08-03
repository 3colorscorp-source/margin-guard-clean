-- CH-011I VERIFY — Signed Contract PDF artifacts
-- Run AFTER SUPABASE_CH011I_SIGNED_CONTRACT_PDF.sql. MANUAL SUPABASE APPLY.

do $$
begin
  if to_regclass('public.tenant_contract_signed_artifacts') is null then
    raise exception 'CH-011I VERIFY FAIL: missing tenant_contract_signed_artifacts';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenant_contract_signed_artifacts'::regclass
      and conname = 'tenant_contract_signed_artifacts_tenant_envelope_type_key'
  ) then
    raise exception 'CH-011I VERIFY FAIL: one-signed-pdf-per-envelope unique missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenant_contract_signed_artifacts'::regclass
      and conname = 'tenant_contract_signed_artifacts_certificate_fk'
  ) then
    raise exception 'CH-011I VERIFY FAIL: certificate FK missing';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'tenant_contract_signed_artifacts'
      and policyname = 'service role full access tenant_contract_signed_artifacts'
  ) then
    raise exception 'CH-011I VERIFY FAIL: RLS policy missing';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'tenant_contract_signed_artifacts_protect_immutable'
  ) then
    raise exception 'CH-011I VERIFY FAIL: immutability function missing';
  end if;

  raise notice 'CH-011I VERIFY PASS: signed artifacts table + RLS + immutability present';
  raise notice 'CH-011I VERIFY COMPLETE';
end;
$$;
