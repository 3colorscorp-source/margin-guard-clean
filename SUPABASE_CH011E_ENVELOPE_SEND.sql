-- CH-011E Envelope Send Foundation (additive)
-- Adds sent_at / sent_by for draft → sent transition audit.
-- MANUAL SUPABASE APPLY. Requires: public.tenant_contract_envelopes

do $$
begin
  if to_regclass('public.tenant_contract_envelopes') is null then
    raise exception 'CH-011E blocked: missing public.tenant_contract_envelopes';
  end if;
end;
$$;

alter table public.tenant_contract_envelopes
  add column if not exists sent_at timestamptz null;

alter table public.tenant_contract_envelopes
  add column if not exists sent_by uuid null;

comment on column public.tenant_contract_envelopes.sent_at is
  'CH-011E: when envelope transitioned draft → sent. Null while draft.';

comment on column public.tenant_contract_envelopes.sent_by is
  'CH-011E: membership id of owner/admin who sent. Not a raw token store.';
