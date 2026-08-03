-- CH-011G VERIFY — Signature capture foundation
-- Run AFTER SUPABASE_CH011G_SIGNATURE_CAPTURE.sql. MANUAL SUPABASE APPLY.

do $$
begin
  if to_regclass('public.tenant_contract_signature_events') is null then
    raise exception 'CH-011G VERIFY FAIL: missing tenant_contract_signature_events';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'tenant_contract_signers'
      and column_name = 'signed_at'
  ) then
    raise exception 'CH-011G VERIFY FAIL: signers.signed_at missing';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'tenant_contract_packages'
      and column_name = 'executed_at'
  ) then
    raise exception 'CH-011G VERIFY FAIL: packages.executed_at missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenant_contract_signers'::regclass
      and conname = 'tenant_contract_signers_status_check'
  ) then
    raise exception 'CH-011G VERIFY FAIL: signer status check missing';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'tenant_contract_signature_events'
      and policyname = 'service role full access tenant_contract_signature_events'
  ) then
    raise exception 'CH-011G VERIFY FAIL: RLS policy missing';
  end if;

  raise notice 'CH-011G VERIFY PASS: signature events + signer/package columns present';
  raise notice 'CH-011G VERIFY COMPLETE';
end;
$$;
