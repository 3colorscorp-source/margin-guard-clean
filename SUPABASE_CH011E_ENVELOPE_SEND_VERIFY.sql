-- CH-011E VERIFY — Envelope Send columns
-- Run AFTER SUPABASE_CH011E_ENVELOPE_SEND.sql. MANUAL SUPABASE APPLY.

do $$
begin
  if to_regclass('public.tenant_contract_envelopes') is null then
    raise exception 'CH-011E VERIFY FAIL: missing tenant_contract_envelopes';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'tenant_contract_envelopes'
      and column_name = 'sent_at'
  ) then
    raise exception 'CH-011E VERIFY FAIL: sent_at column missing';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'tenant_contract_envelopes'
      and column_name = 'sent_by'
  ) then
    raise exception 'CH-011E VERIFY FAIL: sent_by column missing';
  end if;

  raise notice 'CH-011E VERIFY PASS: sent_at and sent_by present';
  raise notice 'CH-011E VERIFY COMPLETE';
end;
$$;
