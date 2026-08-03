-- CH-011H Audit Certificate Foundation (additive)
-- MANUAL SUPABASE APPLY.
-- Requires: tenants, tenant_projects, tenant_contract_envelopes,
--           tenant_contract_packages, tenant_contract_signature_events

do $$
begin
  if to_regclass('public.tenants') is null then
    raise exception 'CH-011H blocked: missing public.tenants';
  end if;
  if to_regclass('public.tenant_projects') is null then
    raise exception 'CH-011H blocked: missing public.tenant_projects';
  end if;
  if to_regclass('public.tenant_contract_envelopes') is null then
    raise exception 'CH-011H blocked: missing public.tenant_contract_envelopes';
  end if;
  if to_regclass('public.tenant_contract_packages') is null then
    raise exception 'CH-011H blocked: missing public.tenant_contract_packages';
  end if;
  if to_regclass('public.tenant_contract_signature_events') is null then
    raise exception 'CH-011H blocked: missing public.tenant_contract_signature_events';
  end if;
end;
$$;

create table if not exists public.tenant_contract_certificates (
  id uuid primary key default gen_random_uuid(),

  tenant_id uuid not null
    references public.tenants (id) on delete cascade,
  envelope_id uuid not null,
  package_id uuid not null,
  project_id uuid not null
    references public.tenant_projects (id) on delete cascade,

  certificate_number text not null
    check (char_length(trim(certificate_number)) > 0 and char_length(certificate_number) <= 80),

  status text not null default 'issued'
    check (status in ('issued')),

  certificate_json jsonb not null
    check (jsonb_typeof(certificate_json) = 'object'),

  content_hash text not null
    check (content_hash ~ '^[a-f0-9]{64}$'),

  issued_at timestamptz not null default now(),
  created_by uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint tenant_contract_certificates_tenant_id_id_key
    unique (tenant_id, id),

  constraint tenant_contract_certificates_tenant_envelope_key
    unique (tenant_id, envelope_id),

  constraint tenant_contract_certificates_tenant_number_key
    unique (tenant_id, certificate_number),

  constraint tenant_contract_certificates_envelope_fk
    foreign key (tenant_id, envelope_id)
    references public.tenant_contract_envelopes (tenant_id, id)
    on delete restrict,

  constraint tenant_contract_certificates_package_fk
    foreign key (tenant_id, package_id)
    references public.tenant_contract_packages (tenant_id, id)
    on delete restrict
);

comment on table public.tenant_contract_certificates is
  'CH-011H immutable audit certificate for a completed envelope. No PDF. No raw tokens.';

comment on column public.tenant_contract_certificates.certificate_json is
  'Frozen authoritative signing evidence. Immutable after insert.';

comment on column public.tenant_contract_certificates.content_hash is
  'SHA-256 hex of canonical certificate evidence (excludes issued_at wrapper).';

create or replace function public.tenant_contract_certificates_protect_immutable()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    if new.tenant_id is distinct from old.tenant_id
       or new.envelope_id is distinct from old.envelope_id
       or new.package_id is distinct from old.package_id
       or new.project_id is distinct from old.project_id
       or new.certificate_number is distinct from old.certificate_number
       or new.status is distinct from old.status
       or new.certificate_json is distinct from old.certificate_json
       or new.content_hash is distinct from old.content_hash
       or new.issued_at is distinct from old.issued_at
       or new.created_by is distinct from old.created_by
       or new.created_at is distinct from old.created_at then
      raise exception 'contract_certificate_immutable'
        using errcode = '23514';
    end if;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists tenant_contract_certificates_protect_immutable_bu
  on public.tenant_contract_certificates;
create trigger tenant_contract_certificates_protect_immutable_bu
  before update on public.tenant_contract_certificates
  for each row
  execute function public.tenant_contract_certificates_protect_immutable();

create index if not exists tenant_contract_certificates_tenant_package_idx
  on public.tenant_contract_certificates (tenant_id, package_id);

create index if not exists tenant_contract_certificates_tenant_project_idx
  on public.tenant_contract_certificates (tenant_id, project_id);

alter table public.tenant_contract_certificates enable row level security;

drop policy if exists "service role full access tenant_contract_certificates"
  on public.tenant_contract_certificates;
create policy "service role full access tenant_contract_certificates"
  on public.tenant_contract_certificates
  for all
  to service_role
  using (true)
  with check (true);

revoke all on table public.tenant_contract_certificates from public;
revoke all on table public.tenant_contract_certificates from anon;
revoke all on table public.tenant_contract_certificates from authenticated;
grant all on table public.tenant_contract_certificates to service_role;

revoke all on function public.tenant_contract_certificates_protect_immutable() from public;
revoke all on function public.tenant_contract_certificates_protect_immutable() from anon;
revoke all on function public.tenant_contract_certificates_protect_immutable() from authenticated;
grant execute on function public.tenant_contract_certificates_protect_immutable() to service_role;
