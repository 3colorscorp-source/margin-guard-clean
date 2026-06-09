-- =============================================================================
-- Margin Guard | Multi-Seller Roadmap — M4: Attribution columns (nullable)
-- =============================================================================
-- STATUS: DRAFT — DO NOT RUN
-- Apply only after M1–M3 (M2 required for source_device_id FK) and owner approval.
--
-- RULES:
--   - ALL columns nullable (no breaking change to existing rows)
--   - NO data backfill in this migration
--   - NO changes to amount, paid_amount, balance_due, pricing, or payment fields
--   - Application populates on device-origin writes (Step 3F+)
--
-- PREREQUISITES:
--   - public.quotes, tenant_projects, tenant_project_day_progress,
--     tenant_project_reports, tenant_project_expenses, sales_approvals exist
--   - SUPABASE_TENANT_DEVICES_M2.sql for source_device_id FK targets
--
-- ROLLBACK: DROP COLUMN for each added column (after code no longer references).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- quotes
-- -----------------------------------------------------------------------------
alter table public.quotes
  add column if not exists seller_membership_id uuid null,
  add column if not exists seller_user_id uuid null,
  add column if not exists seller_email text null,
  add column if not exists source_device_id uuid null,
  add column if not exists created_by_role text null;

do $fk_quotes$
begin
  if to_regclass('public.profiles') is not null then
    if not exists (select 1 from pg_constraint where conname = 'quotes_seller_membership_id_fkey') then
      alter table public.quotes
        add constraint quotes_seller_membership_id_fkey
        foreign key (seller_membership_id) references public.profiles (id)
        on delete set null;
    end if;
  end if;
  if to_regclass('public.tenant_devices') is not null then
    if not exists (select 1 from pg_constraint where conname = 'quotes_source_device_id_fkey') then
      alter table public.quotes
        add constraint quotes_source_device_id_fkey
        foreign key (source_device_id) references public.tenant_devices (id)
        on delete set null;
    end if;
  end if;
end
$fk_quotes$;

comment on column public.quotes.seller_membership_id is
  'Tenant membership that published the quote (seller device or owner). Nullable for legacy.';

comment on column public.quotes.created_by_role is
  'Role at publish time. Nullable for legacy rows; when set must be owner, admin, seller, or supervisor.';

alter table public.quotes drop constraint if exists quotes_created_by_role_check;
alter table public.quotes add constraint quotes_created_by_role_check
  check (
    created_by_role is null
    or created_by_role in ('owner', 'admin', 'seller', 'supervisor')
  );

create index if not exists quotes_tenant_seller_membership_idx
  on public.quotes (tenant_id, seller_membership_id)
  where seller_membership_id is not null;

create index if not exists quotes_source_device_id_idx
  on public.quotes (source_device_id)
  where source_device_id is not null;

-- -----------------------------------------------------------------------------
-- tenant_projects
-- -----------------------------------------------------------------------------
alter table public.tenant_projects
  add column if not exists seller_membership_id uuid null,
  add column if not exists seller_user_id uuid null,
  add column if not exists seller_email text null,
  add column if not exists source_device_id uuid null;

do $fk_tp$
begin
  if to_regclass('public.profiles') is not null then
    if not exists (select 1 from pg_constraint where conname = 'tenant_projects_seller_membership_id_fkey') then
      alter table public.tenant_projects
        add constraint tenant_projects_seller_membership_id_fkey
        foreign key (seller_membership_id) references public.profiles (id)
        on delete set null;
    end if;
  end if;
  if to_regclass('public.tenant_devices') is not null then
    if not exists (select 1 from pg_constraint where conname = 'tenant_projects_source_device_id_fkey') then
      alter table public.tenant_projects
        add constraint tenant_projects_source_device_id_fkey
        foreign key (source_device_id) references public.tenant_devices (id)
        on delete set null;
    end if;
  end if;
end
$fk_tp$;

create index if not exists tenant_projects_tenant_seller_membership_idx
  on public.tenant_projects (tenant_id, seller_membership_id)
  where seller_membership_id is not null;

-- -----------------------------------------------------------------------------
-- tenant_project_day_progress
-- -----------------------------------------------------------------------------
alter table public.tenant_project_day_progress
  add column if not exists supervisor_membership_id uuid null,
  add column if not exists source_device_id uuid null;

do $fk_dp$
begin
  if to_regclass('public.profiles') is not null then
    if not exists (select 1 from pg_constraint where conname = 'tenant_project_day_progress_supervisor_membership_id_fkey') then
      alter table public.tenant_project_day_progress
        add constraint tenant_project_day_progress_supervisor_membership_id_fkey
        foreign key (supervisor_membership_id) references public.profiles (id)
        on delete set null;
    end if;
  end if;
  if to_regclass('public.tenant_devices') is not null then
    if not exists (select 1 from pg_constraint where conname = 'tenant_project_day_progress_source_device_id_fkey') then
      alter table public.tenant_project_day_progress
        add constraint tenant_project_day_progress_source_device_id_fkey
        foreign key (source_device_id) references public.tenant_devices (id)
        on delete set null;
    end if;
  end if;
end
$fk_dp$;

create index if not exists tenant_project_day_progress_supervisor_membership_idx
  on public.tenant_project_day_progress (tenant_id, supervisor_membership_id)
  where supervisor_membership_id is not null;

-- -----------------------------------------------------------------------------
-- tenant_project_reports
-- -----------------------------------------------------------------------------
alter table public.tenant_project_reports
  add column if not exists supervisor_membership_id uuid null,
  add column if not exists source_device_id uuid null;

do $fk_rpt$
begin
  if to_regclass('public.profiles') is not null then
    if not exists (select 1 from pg_constraint where conname = 'tenant_project_reports_supervisor_membership_id_fkey') then
      alter table public.tenant_project_reports
        add constraint tenant_project_reports_supervisor_membership_id_fkey
        foreign key (supervisor_membership_id) references public.profiles (id)
        on delete set null;
    end if;
  end if;
  if to_regclass('public.tenant_devices') is not null then
    if not exists (select 1 from pg_constraint where conname = 'tenant_project_reports_source_device_id_fkey') then
      alter table public.tenant_project_reports
        add constraint tenant_project_reports_source_device_id_fkey
        foreign key (source_device_id) references public.tenant_devices (id)
        on delete set null;
    end if;
  end if;
end
$fk_rpt$;

-- -----------------------------------------------------------------------------
-- tenant_project_expenses
-- -----------------------------------------------------------------------------
alter table public.tenant_project_expenses
  add column if not exists supervisor_membership_id uuid null,
  add column if not exists source_device_id uuid null;

do $fk_exp$
begin
  if to_regclass('public.profiles') is not null then
    if not exists (select 1 from pg_constraint where conname = 'tenant_project_expenses_supervisor_membership_id_fkey') then
      alter table public.tenant_project_expenses
        add constraint tenant_project_expenses_supervisor_membership_id_fkey
        foreign key (supervisor_membership_id) references public.profiles (id)
        on delete set null;
    end if;
  end if;
  if to_regclass('public.tenant_devices') is not null then
    if not exists (select 1 from pg_constraint where conname = 'tenant_project_expenses_source_device_id_fkey') then
      alter table public.tenant_project_expenses
        add constraint tenant_project_expenses_source_device_id_fkey
        foreign key (source_device_id) references public.tenant_devices (id)
        on delete set null;
    end if;
  end if;
end
$fk_exp$;

-- -----------------------------------------------------------------------------
-- sales_approvals (requested_by_email already exists via prior migration)
-- -----------------------------------------------------------------------------
alter table public.sales_approvals
  add column if not exists quote_id uuid null,
  add column if not exists requested_by_membership_id uuid null,
  add column if not exists source_device_id uuid null;

do $fk_sa$
begin
  if to_regclass('public.quotes') is not null then
    if not exists (select 1 from pg_constraint where conname = 'sales_approvals_quote_id_fkey') then
      alter table public.sales_approvals
        add constraint sales_approvals_quote_id_fkey
        foreign key (quote_id) references public.quotes (id)
        on delete set null;
    end if;
  end if;
  if to_regclass('public.profiles') is not null then
    if not exists (select 1 from pg_constraint where conname = 'sales_approvals_requested_by_membership_id_fkey') then
      alter table public.sales_approvals
        add constraint sales_approvals_requested_by_membership_id_fkey
        foreign key (requested_by_membership_id) references public.profiles (id)
        on delete set null;
    end if;
  end if;
  if to_regclass('public.tenant_devices') is not null then
    if not exists (select 1 from pg_constraint where conname = 'sales_approvals_source_device_id_fkey') then
      alter table public.sales_approvals
        add constraint sales_approvals_source_device_id_fkey
        foreign key (source_device_id) references public.tenant_devices (id)
        on delete set null;
    end if;
  end if;
end
$fk_sa$;

create index if not exists sales_approvals_quote_id_idx
  on public.sales_approvals (quote_id)
  where quote_id is not null;

-- =============================================================================
-- END M4 — DRAFT — DO NOT RUN without owner approval
-- No NOT NULL. No backfill. No updates to existing financial columns.
-- =============================================================================
