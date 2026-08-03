-- CH-011I Signed Contract PDF artifacts (additive)
-- MANUAL SUPABASE APPLY.
-- Requires: tenants, tenant_projects, tenant_contract_envelopes,
--           tenant_contract_packages, tenant_contract_certificates

do $$
begin
  if to_regclass('public.tenants') is null then
    raise exception 'CH-011I blocked: missing public.tenants';
  end if;
  if to_regclass('public.tenant_projects') is null then
    raise exception 'CH-011I blocked: missing public.tenant_projects';
  end if;
  if to_regclass('public.tenant_contract_envelopes') is null then
    raise exception 'CH-011I blocked: missing public.tenant_contract_envelopes';
  end if;
  if to_regclass('public.tenant_contract_packages') is null then
    raise exception 'CH-011I blocked: missing public.tenant_contract_packages';
  end if;
  if to_regclass('public.tenant_contract_certificates') is null then
    raise exception 'CH-011I blocked: missing public.tenant_contract_certificates';
  end if;
end;
$$;

create table if not exists public.tenant_contract_signed_artifacts (
  id uuid primary key default gen_random_uuid(),

  tenant_id uuid not null
    references public.tenants (id) on delete cascade,
  envelope_id uuid not null,
  package_id uuid not null,
  certificate_id uuid not null,
  project_id uuid not null
    references public.tenant_projects (id) on delete cascade,

  artifact_type text not null default 'signed_pdf'
    check (artifact_type in ('signed_pdf')),

  storage_ref text not null
    check (char_length(trim(storage_ref)) > 0 and char_length(storage_ref) <= 500),

  sha256 text not null
    check (sha256 ~ '^[a-f0-9]{64}$'),

  file_size integer not null
    check (file_size > 0),

  mime_type text not null default 'application/pdf'
    check (mime_type = 'application/pdf'),

  generated_at timestamptz not null default now(),
  generator_version text not null
    check (char_length(trim(generator_version)) > 0 and char_length(generator_version) <= 40),

  created_by uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint tenant_contract_signed_artifacts_tenant_id_id_key
    unique (tenant_id, id),

  constraint tenant_contract_signed_artifacts_tenant_envelope_type_key
    unique (tenant_id, envelope_id, artifact_type),

  constraint tenant_contract_signed_artifacts_envelope_fk
    foreign key (tenant_id, envelope_id)
    references public.tenant_contract_envelopes (tenant_id, id)
    on delete restrict,

  constraint tenant_contract_signed_artifacts_package_fk
    foreign key (tenant_id, package_id)
    references public.tenant_contract_packages (tenant_id, id)
    on delete restrict,

  constraint tenant_contract_signed_artifacts_certificate_fk
    foreign key (tenant_id, certificate_id)
    references public.tenant_contract_certificates (tenant_id, id)
    on delete restrict
);

comment on table public.tenant_contract_signed_artifacts is
  'CH-011I immutable signed contract PDF metadata. Private storage only. No public URLs.';

comment on column public.tenant_contract_signed_artifacts.storage_ref is
  'Private storage object path: contracts/<tenant_id>/<project_id>/<envelope_id>/signed-contract.pdf';

comment on column public.tenant_contract_signed_artifacts.sha256 is
  'SHA-256 hex of generated PDF bytes.';

create or replace function public.tenant_contract_signed_artifacts_protect_immutable()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    if new.tenant_id is distinct from old.tenant_id
       or new.envelope_id is distinct from old.envelope_id
       or new.package_id is distinct from old.package_id
       or new.certificate_id is distinct from old.certificate_id
       or new.project_id is distinct from old.project_id
       or new.artifact_type is distinct from old.artifact_type
       or new.storage_ref is distinct from old.storage_ref
       or new.sha256 is distinct from old.sha256
       or new.file_size is distinct from old.file_size
       or new.mime_type is distinct from old.mime_type
       or new.generated_at is distinct from old.generated_at
       or new.generator_version is distinct from old.generator_version
       or new.created_by is distinct from old.created_by
       or new.created_at is distinct from old.created_at then
      raise exception 'contract_signed_artifact_immutable'
        using errcode = '23514';
    end if;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists tenant_contract_signed_artifacts_protect_immutable_bu
  on public.tenant_contract_signed_artifacts;
create trigger tenant_contract_signed_artifacts_protect_immutable_bu
  before update on public.tenant_contract_signed_artifacts
  for each row
  execute function public.tenant_contract_signed_artifacts_protect_immutable();

create index if not exists tenant_contract_signed_artifacts_tenant_package_idx
  on public.tenant_contract_signed_artifacts (tenant_id, package_id);

create index if not exists tenant_contract_signed_artifacts_tenant_certificate_idx
  on public.tenant_contract_signed_artifacts (tenant_id, certificate_id);

create index if not exists tenant_contract_signed_artifacts_tenant_project_idx
  on public.tenant_contract_signed_artifacts (tenant_id, project_id);

alter table public.tenant_contract_signed_artifacts enable row level security;

drop policy if exists "service role full access tenant_contract_signed_artifacts"
  on public.tenant_contract_signed_artifacts;
create policy "service role full access tenant_contract_signed_artifacts"
  on public.tenant_contract_signed_artifacts
  for all
  to service_role
  using (true)
  with check (true);

revoke all on table public.tenant_contract_signed_artifacts from public;
revoke all on table public.tenant_contract_signed_artifacts from anon;
revoke all on table public.tenant_contract_signed_artifacts from authenticated;
grant all on table public.tenant_contract_signed_artifacts to service_role;

revoke all on function public.tenant_contract_signed_artifacts_protect_immutable() from public;
revoke all on function public.tenant_contract_signed_artifacts_protect_immutable() from anon;
revoke all on function public.tenant_contract_signed_artifacts_protect_immutable() from authenticated;
grant execute on function public.tenant_contract_signed_artifacts_protect_immutable() to service_role;
