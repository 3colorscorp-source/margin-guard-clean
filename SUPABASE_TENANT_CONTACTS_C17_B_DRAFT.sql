-- =============================================================================
-- Margin Guard | Step 3E-C17-B — Tenant Contacts SQL/RLS Draft
-- =============================================================================
-- STATUS: DRAFT ONLY — DO NOT RUN UNTIL OWNER APPROVES
--
-- PURPOSE:
--   Tenant-scoped customer/supplier contact directory for Margin Guard™.
--   Owner Contacts module (C17-C+). Seller search/select/create from quote
--   form later (C17-D/E). Import batches for owner CSV/XLSX later (C17-F).
--
-- PRODUCTION BASELINE (unchanged by this file until applied):
--   dc2c5a9 — Q3L Pro Dark + seller text hierarchy Production PASS
--   Seller → Firmar Proyecto → Supervisor → Invoice Hub PASS
--   Deposit / check pending / record payment / payment ledger verified PASS
--
-- PROTECTED FLOWS — NOT TOUCHED BY THIS DRAFT:
--   * Seller quote flow, public quote link, Firmar Proyecto / sign project
--   * Supervisor project visibility and assignment
--   * Invoice Hub, deposit pending, record payment, payment ledger
--   * Quote/invoice pricing calculations, auth/device portal/session logic
--   * Existing quote / invoice / tenant_project text fields (client_name, etc.)
--
-- PREREQUISITES (must exist before apply):
--   * public.tenants (SUPABASE_MARGIN_GUARD_MULTITENANT.sql)
--   * public.profiles (membership rows; M1 optional but recommended)
--   * public.set_updated_at() trigger function (already in multitenancy / invoices SQL)
--
-- APPLY:
--   Run manually in Supabase SQL Editor only after explicit owner approval.
--   Do not run from CI. Do not run against production without review.
--
-- ROLLBACK (manual, after apply):
--   drop table if exists public.tenant_contacts cascade;
--   drop table if exists public.tenant_contact_import_batches cascade;
-- =============================================================================

-- -----------------------------------------------------------------------------
-- PREFLIGHT (read-only — run first, inspect output, then continue)
-- -----------------------------------------------------------------------------
-- SELECT to_regclass('public.tenants'), to_regclass('public.profiles');
-- SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND proname = 'set_updated_at';
-- SELECT count(*) FROM public.tenants;

-- =============================================================================
-- 1. tenant_contact_import_batches (create before contacts FK optional link)
-- =============================================================================

create table if not exists public.tenant_contact_import_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  filename text,
  source text not null default 'import',
  status text not null default 'draft'
    check (status in ('draft', 'previewed', 'committed', 'failed')),
  total_rows integer not null default 0,
  created_count integer not null default 0,
  updated_count integer not null default 0,
  skipped_count integer not null default 0,
  error_count integer not null default 0,
  summary jsonb not null default '{}'::jsonb,
  created_by_membership_id uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  committed_at timestamptz
);

comment on table public.tenant_contact_import_batches is
  'Owner-only contact import batches (CSV/XLSX/Google CSV). DRAFT C17-B — not used until C17-F.';

comment on column public.tenant_contact_import_batches.tenant_id is
  'Must match session tenant from Netlify handlers. Never accept tenant_id from browser body alone.';

comment on column public.tenant_contact_import_batches.status is
  'draft → previewed → committed | failed. Seller import not allowed in v1.';

comment on column public.tenant_contact_import_batches.summary is
  'Row-level warnings, duplicate counts, error samples. Warning-only duplicate policy in v1.';

-- -----------------------------------------------------------------------------
-- 2. tenant_contacts
-- -----------------------------------------------------------------------------

create table if not exists public.tenant_contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,

  display_name text not null,
  first_name text,
  last_name text,
  company_name text,

  contact_type text not null default 'homeowner'
    check (contact_type in (
      'homeowner',
      'general_contractor',
      'designer',
      'property_manager',
      'business',
      'supplier',
      'other'
    )),

  email text,
  phone text,
  phone_normalized text,

  address_line1 text,
  address_line2 text,
  city text,
  state text,
  postal_code text,
  country text not null default 'US',

  notes text,

  source text not null default 'manual'
    check (source in ('manual', 'quote', 'invoice', 'import', 'public_form')),

  status text not null default 'active'
    check (status in ('active', 'archived')),

  created_by_membership_id uuid references public.profiles (id) on delete set null,
  updated_by_membership_id uuid references public.profiles (id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_activity_at timestamptz,

  tags text[],
  preferred_contact_method text,
  google_contact_id text,
  imported_batch_id uuid references public.tenant_contact_import_batches (id) on delete set null,
  duplicate_key text
);

comment on table public.tenant_contacts is
  'Tenant-isolated contact directory (customers, suppliers, GCs, etc.). C17-B draft.';

comment on column public.tenant_contacts.tenant_id is
  'Tenant scope. Netlify handlers MUST derive tenant_id from mg_session / device session — reject client-supplied tenant_id.';

comment on column public.tenant_contacts.display_name is
  'Primary label for UI search. Fallback order on write: company → first+last → email → phone → Unnamed Contact.';

comment on column public.tenant_contacts.phone_normalized is
  'Digits-only (and optional country) for soft duplicate search. Display uses phone column.';

comment on column public.tenant_contacts.contact_type is
  'Includes supplier per owner C17-A. Filter in owner UI; seller picker may default to customer types.';

comment on column public.tenant_contacts.status is
  'active | archived. Archived contacts excluded from default search (owner may include via filter later).';

comment on column public.tenant_contacts.source is
  'Provenance: manual, quote, invoice, import, public_form. No silent auto-save from quote in v1.';

comment on column public.tenant_contacts.duplicate_key is
  'Optional soft-match helper (e.g. lower(email), phone_normalized). NOT unique — warning-only duplicate detection in v1.';

comment on column public.tenant_contacts.imported_batch_id is
  'Set when source = import. Owner-only import in v1; seller cannot import.';

comment on column public.tenant_contacts.created_by_membership_id is
  'profiles.id of creator (owner or seller membership). Audit for seller create permission.';

-- No UNIQUE constraints on email/phone/display_name in v1 — legitimate repeats allowed.
-- Duplicate detection is application-level warning only (skip | update | create anyway).

-- Existing quotes.invoices.tenant_projects client_name / customer_name text fields remain
-- source-of-truth snapshots until optional contact_id is added in C17-E.

-- Supervisor role: no contacts API or UI in v1.

-- Deposit logic, hub-quote-manual-step, tenant_project_payments ledger: unchanged by this table.

-- =============================================================================
-- 3. Indexes — tenant_contacts
-- =============================================================================

create index if not exists tenant_contacts_tenant_id_idx
  on public.tenant_contacts (tenant_id);

create index if not exists tenant_contacts_tenant_status_idx
  on public.tenant_contacts (tenant_id, status);

create index if not exists tenant_contacts_tenant_created_at_idx
  on public.tenant_contacts (tenant_id, created_at desc);

create index if not exists tenant_contacts_tenant_contact_type_idx
  on public.tenant_contacts (tenant_id, contact_type);

create index if not exists tenant_contacts_tenant_email_lower_idx
  on public.tenant_contacts (tenant_id, lower(email))
  where email is not null and email <> '';

create index if not exists tenant_contacts_tenant_phone_normalized_idx
  on public.tenant_contacts (tenant_id, phone_normalized)
  where phone_normalized is not null and phone_normalized <> '';

create index if not exists tenant_contacts_tenant_display_name_lower_idx
  on public.tenant_contacts (tenant_id, lower(display_name));

create index if not exists tenant_contacts_tenant_company_name_lower_idx
  on public.tenant_contacts (tenant_id, lower(company_name))
  where company_name is not null and company_name <> '';

-- Optional future: pg_trgm or tsvector for fuzzy search (C17-C+ performance tuning)
-- create extension if not exists pg_trgm;
-- create index tenant_contacts_search_trgm_idx on public.tenant_contacts
--   using gin (display_name gin_trgm_ops, email gin_trgm_ops);

-- =============================================================================
-- 4. Indexes — tenant_contact_import_batches
-- =============================================================================

create index if not exists tenant_contact_import_batches_tenant_id_idx
  on public.tenant_contact_import_batches (tenant_id);

create index if not exists tenant_contact_import_batches_tenant_created_at_idx
  on public.tenant_contact_import_batches (tenant_id, created_at desc);

create index if not exists tenant_contact_import_batches_tenant_status_idx
  on public.tenant_contact_import_batches (tenant_id, status);

-- =============================================================================
-- 5. updated_at trigger — tenant_contacts only
-- =============================================================================
-- Reuses public.set_updated_at() from SUPABASE_MARGIN_GUARD_MULTITENANT.sql /
-- SUPABASE_INVOICES_SCHEMA.sql. Do NOT redefine here unless preflight shows missing.
--
-- If preflight returns no row for set_updated_at, uncomment block below ONCE:
--
-- create or replace function public.set_updated_at()
-- returns trigger
-- language plpgsql
-- as $$
-- begin
--   new.updated_at = now();
--   return new;
-- end;
-- $$;

drop trigger if exists trg_tenant_contacts_updated_at on public.tenant_contacts;
create trigger trg_tenant_contacts_updated_at
before update on public.tenant_contacts
for each row execute function public.set_updated_at();

-- Import batches: no updated_at column; no trigger required.

-- =============================================================================
-- 6. Row Level Security — service_role only (Netlify pattern)
-- =============================================================================
-- Browser does not query Supabase directly. All access via Netlify functions with
-- service_role + mandatory tenant_id filters derived from session membership.

alter table public.tenant_contacts enable row level security;

drop policy if exists "service role full access tenant_contacts" on public.tenant_contacts;
create policy "service role full access tenant_contacts"
on public.tenant_contacts
for all
to service_role
using (true)
with check (true);

-- No anon or authenticated policies — prevents cross-tenant direct client access.

alter table public.tenant_contact_import_batches enable row level security;

drop policy if exists "service role full access tenant_contact_import_batches" on public.tenant_contact_import_batches;
create policy "service role full access tenant_contact_import_batches"
on public.tenant_contact_import_batches
for all
to service_role
using (true)
with check (true);

-- =============================================================================
-- 7. FUTURE C17-E ONLY — DO NOT RUN IN C17-B
-- =============================================================================
-- Optional nullable contact_id links. Keep quote/invoice/project text fields as
-- historical snapshots. Apply only after owner approves C17-E integration.
--
-- alter table public.quotes
--   add column if not exists contact_id uuid references public.tenant_contacts (id) on delete set null;
-- comment on column public.quotes.contact_id is
--   'Optional link to tenant_contacts. client_name/client_email remain snapshot fields.';
--
-- alter table public.tenant_projects
--   add column if not exists contact_id uuid references public.tenant_contacts (id) on delete set null;
-- comment on column public.tenant_projects.contact_id is
--   'Optional link. client_name/client_email remain snapshot fields.';
--
-- alter table public.invoices
--   add column if not exists contact_id uuid references public.tenant_contacts (id) on delete set null;
-- comment on column public.invoices.contact_id is
--   'Optional link. customer_name/customer_email remain snapshot fields.';
--
-- create index if not exists quotes_tenant_contact_id_idx
--   on public.quotes (tenant_id, contact_id) where contact_id is not null;
-- create index if not exists tenant_projects_tenant_contact_id_idx
--   on public.tenant_projects (tenant_id, contact_id) where contact_id is not null;
-- create index if not exists invoices_tenant_contact_id_idx
--   on public.invoices (tenant_id, contact_id) where contact_id is not null;

-- =============================================================================
-- C17-B VALIDATION CHECKLIST (verify before and after owner-approved apply)
-- =============================================================================
-- [ ] This SQL file was NOT executed against Supabase during C17-B draft work
-- [ ] Production database unchanged until owner explicitly runs this script
-- [ ] No app code, Netlify functions, or public HTML/JS touched in C17-B
-- [ ] Deposit / check pending / deposit received / record payment logic untouched
-- [ ] Payment ledger (tenant_project_payments) untouched
-- [ ] Quote accept / Firmar Proyecto / quote-accept-bridge untouched
-- [ ] Supervisor project assignment logic untouched
-- [ ] Seller device / session / portal auth untouched
-- [ ] Tenant isolation enforced in Netlify handlers (session-derived tenant_id)
-- [ ] No unique constraints on contacts in v1
-- [ ] Duplicate detection remains warning-only in application layer
-- [ ] Seller import disabled in v1 (owner-only import batches)
-- [ ] Supervisor has no contacts access in v1
-- [ ] Existing quote/invoice/project text fields remain authoritative until C17-E
