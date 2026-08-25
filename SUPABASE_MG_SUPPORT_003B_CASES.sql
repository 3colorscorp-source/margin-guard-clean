-- =============================================================================
-- Margin Guard | MG-SUPPORT-003B — Support case intake (additive)
-- =============================================================================
-- STATUS: MANUAL SUPABASE APPLY REQUIRED — do not run from CI or auto-deploy.
--
-- PURPOSE:
--   Closed tenant-scoped support-case intake for confirmed owner escalations.
--   Writes happen only through Netlify mg-support-create-case (service role).
--
-- NOT IN THIS MIGRATION:
--   * owner case list UI
--   * Support Admin
--   * assignment / priority / SLA
--   * email / Zapier / notifications
--   * conversation or diagnostic JSON storage
--
-- DEPENDENCIES:
--   REQUIRED: public.tenants
-- =============================================================================

create table if not exists public.tenant_support_cases (
  id uuid primary key default gen_random_uuid(),

  tenant_id uuid not null
    references public.tenants (id) on delete cascade,

  created_by_user_id uuid null,

  status text not null default 'open'
    check (status in ('open', 'resolved')),

  category text not null
    check (category in (
      'unresolved_question',
      'diagnostic_unavailable',
      'possible_bug',
      'other'
    )),

  source text not null default 'support_chat'
    check (source = 'support_chat'),

  subject text not null
    check (char_length(subject) >= 1 and char_length(subject) <= 120),

  question_excerpt text not null default ''
    check (char_length(question_excerpt) <= 400),

  issue_fingerprint text not null
    check (issue_fingerprint ~ '^[a-f0-9]{64}$'),

  page_path text null
    check (page_path is null or char_length(page_path) <= 200),

  support_module text not null default 'unknown'
    check (support_module in (
      'invoice_hub',
      'quote',
      'project_control',
      'contract_hub',
      'documentation',
      'unknown'
    )),

  related_entity_type text not null default 'none'
    check (related_entity_type in (
      'invoice',
      'quote',
      'project',
      'contract',
      'none'
    )),

  related_entity_ref text null
    check (
      related_entity_ref is null
      or char_length(related_entity_ref) <= 80
    ),

  idempotency_key text not null
    check (char_length(trim(idempotency_key)) > 0),

  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),

  constraint tenant_support_cases_tenant_idempotency_key
    unique (tenant_id, idempotency_key)
);

comment on table public.tenant_support_cases is
  'MG-SUPPORT-003B confirmed owner support-case intake. Server writes only. No PII, money, tokens, or conversation JSON.';

comment on column public.tenant_support_cases.issue_fingerprint is
  'SHA-256 hex of the normalized sanitized question excerpt. Duplicate matching only. Not authentication.';

comment on column public.tenant_support_cases.idempotency_key is
  'Escalation token nonce. Unique per tenant.';

create index if not exists tenant_support_cases_tenant_created_idx
  on public.tenant_support_cases (tenant_id, created_at desc);

create index if not exists tenant_support_cases_tenant_status_created_idx
  on public.tenant_support_cases (tenant_id, status, created_at desc);

create index if not exists tenant_support_cases_tenant_entity_idx
  on public.tenant_support_cases (tenant_id, related_entity_type, related_entity_ref)
  where related_entity_ref is not null;

create index if not exists tenant_support_cases_duplicate_lookup_idx
  on public.tenant_support_cases (
    tenant_id,
    status,
    category,
    related_entity_type,
    issue_fingerprint,
    created_at desc
  );

alter table public.tenant_support_cases enable row level security;

drop policy if exists "service role full access tenant_support_cases"
  on public.tenant_support_cases;
create policy "service role full access tenant_support_cases"
  on public.tenant_support_cases
  for all
  to service_role
  using (true)
  with check (true);

revoke all on table public.tenant_support_cases from public;
revoke all on table public.tenant_support_cases from anon;
revoke all on table public.tenant_support_cases from authenticated;
grant all on table public.tenant_support_cases to service_role;
