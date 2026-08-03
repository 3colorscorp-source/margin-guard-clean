-- =============================================================================
-- Margin Guard | CH-010B — Canonical Payment Intent Foundation (additive)
-- =============================================================================
-- STATUS: MANUAL SUPABASE APPLY REQUIRED — do not run from CI or auto-deploy.
--
-- PURPOSE:
--   Durable tenant-scoped Payment INTENT rows (why money is owed / purpose /
--   amount / sequence / lifecycle). NOT invoices. NOT ledger cash.
--
-- DEPENDENCIES (MANUAL PRECHECK BEFORE APPLY):
--   REQUIRED: public.tenants, public.tenant_projects, public.quotes
--   OPTIONAL FKs (added only if present):
--     public.project_contract_payment_schedules   (CH-004A2)
--     public.project_contract_payment_schedule_items (CH-004A2)
--     public.tenant_project_change_orders
--
-- INTEGRITY:
--   Simple FKs alone do NOT prove same-tenant ownership (referenced tables
--   lack unique(tenant_id,id) except schedules). A BEFORE INSERT/UPDATE
--   trigger enforces tenant/project consistency without altering other tables.
--
-- NOT IN THIS MIGRATION:
--   * invoice FK / join tables (deferred to CH-010D — OPTION C)
--   * backfill / production write API (CH-010C+)
--   * alters to invoices, ledger, schedules, Stripe, quotes, projects
-- =============================================================================

create table if not exists public.tenant_project_payment_intents (
  id uuid primary key default gen_random_uuid(),

  tenant_id uuid not null
    references public.tenants (id) on delete cascade,
  project_id uuid not null
    references public.tenant_projects (id) on delete cascade,

  quote_id uuid null
    references public.quotes (id) on delete set null,
  schedule_id uuid null,
  schedule_item_id uuid null,
  change_order_id uuid null,

  payment_type text not null
    check (payment_type in (
      'initial_scheduling_payment',
      'start_payment',
      'progress_payment',
      'material_cost',
      'change_order',
      'remaining_balance',
      'final_payment',
      'custom'
    )),

  title text not null
    check (char_length(btrim(title)) >= 1 and char_length(title) <= 200),
  description text null
    check (description is null or char_length(description) <= 4000),

  amount numeric(14, 2) not null
    check (amount > 0),
  currency text not null default 'USD'
    check (currency = 'USD'),

  -- Durable intent lifecycle only. Collection states are DERIVED later.
  status text not null default 'draft'
    check (status in ('draft', 'ready', 'cancelled', 'voided')),

  sequence_number integer null
    check (sequence_number is null or sequence_number >= 1),
  due_date date null,

  -- Opaque actor id (membership/user). No FK: profiles/auth conventions vary.
  created_by uuid null,
  created_at timestamptz not null default now(),
  -- Writers (CH-010C+) must set updated_at explicitly; no auto-trigger in CH-010B.
  updated_at timestamptz not null default now(),
  cancelled_at timestamptz null,
  voided_at timestamptz null,

  metadata jsonb not null default '{}'::jsonb,

  constraint tenant_project_payment_intents_tenant_id_id_key
    unique (tenant_id, id),

  constraint tenant_project_payment_intents_status_timestamps_chk
    check (
      (
        status = 'draft'
        and cancelled_at is null
        and voided_at is null
      )
      or (
        status = 'ready'
        and cancelled_at is null
        and voided_at is null
      )
      or (
        status = 'cancelled'
        and cancelled_at is not null
        and voided_at is null
      )
      or (
        status = 'voided'
        and voided_at is not null
        and cancelled_at is null
      )
    ),

  constraint tenant_project_payment_intents_metadata_object_chk
    check (jsonb_typeof(metadata) = 'object')
);

comment on table public.tenant_project_payment_intents is
  'CH-010B canonical Payment INTENT: contractual/business money request. Not an invoice, not ledger cash, not a Stripe PaymentIntent.';

comment on column public.tenant_project_payment_intents.tenant_id is
  'Resolved from authenticated server session only; never accepted from browser input.';

comment on column public.tenant_project_payment_intents.amount is
  'Intended request amount (numeric dollars, 2dp). Must be > 0. Paid/balance are derived later.';

comment on column public.tenant_project_payment_intents.status is
  'Durable intent state: draft|ready|cancelled|voided. Collection readiness is derived from invoices+ledger in later milestones.';

comment on column public.tenant_project_payment_intents.payment_type is
  'Canonical product type. Map legacy schedule deposit→initial_scheduling_payment or start_payment by product policy; material→material_cost; completion→final_payment.';

comment on column public.tenant_project_payment_intents.schedule_item_id is
  'Optional link to planned schedule item. Seeding deferred to CH-010F; column reserved now.';

comment on column public.tenant_project_payment_intents.created_by is
  'Optional opaque UUID for creating actor. Not FK-backed in CH-010B.';

comment on column public.tenant_project_payment_intents.updated_at is
  'Must be set by future write API on every mutation; CH-010B has no auto-update trigger.';

comment on column public.tenant_project_payment_intents.metadata is
  'Non-authoritative extensibility (installments, splits). Never stores paid_amount or ledger truth.';

-- ---------------------------------------------------------------------------
-- Optional FKs (only when dependency tables exist). Composite where possible.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.project_contract_payment_schedules') is not null then
    begin
      alter table public.tenant_project_payment_intents
        drop constraint if exists tenant_project_payment_intents_schedule_id_fkey;
      alter table public.tenant_project_payment_intents
        drop constraint if exists tenant_project_payment_intents_tenant_schedule_fk;
      alter table public.tenant_project_payment_intents
        add constraint tenant_project_payment_intents_tenant_schedule_fk
        foreign key (tenant_id, schedule_id)
        references public.project_contract_payment_schedules (tenant_id, id)
        on delete set null;
    exception
      when undefined_object then
        raise notice 'CH-010B: schedule composite FK skipped (unique tenant_id,id missing)';
      when others then
        raise notice 'CH-010B: schedule FK not applied: %', SQLERRM;
    end;
  else
    raise notice 'CH-010B PRECHECK: project_contract_payment_schedules missing — schedule_id has no FK';
  end if;

  if to_regclass('public.project_contract_payment_schedule_items') is not null then
    begin
      alter table public.tenant_project_payment_intents
        drop constraint if exists tenant_project_payment_intents_schedule_item_id_fkey;
      alter table public.tenant_project_payment_intents
        add constraint tenant_project_payment_intents_schedule_item_id_fkey
        foreign key (schedule_item_id)
        references public.project_contract_payment_schedule_items (id)
        on delete set null;
    exception
      when others then
        raise notice 'CH-010B: schedule_item FK not applied: %', SQLERRM;
    end;
  else
    raise notice 'CH-010B PRECHECK: project_contract_payment_schedule_items missing — schedule_item_id has no FK';
  end if;

  if to_regclass('public.tenant_project_change_orders') is not null then
    begin
      alter table public.tenant_project_payment_intents
        drop constraint if exists tenant_project_payment_intents_change_order_id_fkey;
      alter table public.tenant_project_payment_intents
        add constraint tenant_project_payment_intents_change_order_id_fkey
        foreign key (change_order_id)
        references public.tenant_project_change_orders (id)
        on delete set null;
    exception
      when others then
        raise notice 'CH-010B: change_order FK not applied: %', SQLERRM;
    end;
  else
    raise notice 'CH-010B PRECHECK: tenant_project_change_orders missing — change_order_id has no FK';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Tenant / project referential integrity (DB-enforced for service-role writers)
-- Does not alter existing referenced tables.
-- ---------------------------------------------------------------------------
create or replace function public.tenant_project_payment_intents_assert_refs()
returns trigger
language plpgsql
as $$
declare
  v_project_tenant uuid;
  v_project_quote uuid;
  v_quote_tenant uuid;
  v_schedule_tenant uuid;
  v_schedule_project uuid;
  v_item_tenant uuid;
  v_item_schedule uuid;
  v_co_tenant uuid;
  v_co_project uuid;
begin
  select p.tenant_id, p.quote_id
    into v_project_tenant, v_project_quote
  from public.tenant_projects p
  where p.id = new.project_id;

  if v_project_tenant is null then
    raise exception 'payment_intent_project_missing'
      using errcode = '23503';
  end if;
  if v_project_tenant is distinct from new.tenant_id then
    raise exception 'payment_intent_project_tenant_mismatch'
      using errcode = '23514';
  end if;

  if new.quote_id is not null then
    select q.tenant_id into v_quote_tenant
    from public.quotes q
    where q.id = new.quote_id;
    if v_quote_tenant is null then
      raise exception 'payment_intent_quote_missing'
        using errcode = '23503';
    end if;
    if v_quote_tenant is distinct from new.tenant_id then
      raise exception 'payment_intent_quote_tenant_mismatch'
        using errcode = '23514';
    end if;
    if v_project_quote is not null and v_project_quote is distinct from new.quote_id then
      raise exception 'payment_intent_quote_project_mismatch'
        using errcode = '23514';
    end if;
  end if;

  if new.schedule_id is not null then
    if to_regclass('public.project_contract_payment_schedules') is null then
      raise exception 'payment_intent_schedule_unavailable'
        using errcode = '23503';
    end if;
    execute
      'select tenant_id, project_id from public.project_contract_payment_schedules where id = $1'
      into v_schedule_tenant, v_schedule_project
      using new.schedule_id;
    if v_schedule_tenant is null then
      raise exception 'payment_intent_schedule_missing'
        using errcode = '23503';
    end if;
    if v_schedule_tenant is distinct from new.tenant_id
       or v_schedule_project is distinct from new.project_id then
      raise exception 'payment_intent_schedule_scope_mismatch'
        using errcode = '23514';
    end if;
  end if;

  if new.schedule_item_id is not null then
    if to_regclass('public.project_contract_payment_schedule_items') is null then
      raise exception 'payment_intent_schedule_item_unavailable'
        using errcode = '23503';
    end if;
    if new.schedule_id is null then
      raise exception 'payment_intent_schedule_item_requires_schedule'
        using errcode = '23514';
    end if;
    execute
      'select tenant_id, schedule_id from public.project_contract_payment_schedule_items where id = $1'
      into v_item_tenant, v_item_schedule
      using new.schedule_item_id;
    if v_item_tenant is null then
      raise exception 'payment_intent_schedule_item_missing'
        using errcode = '23503';
    end if;
    if v_item_tenant is distinct from new.tenant_id
       or v_item_schedule is distinct from new.schedule_id then
      raise exception 'payment_intent_schedule_item_scope_mismatch'
        using errcode = '23514';
    end if;
  end if;

  if new.change_order_id is not null then
    if to_regclass('public.tenant_project_change_orders') is null then
      raise exception 'payment_intent_change_order_unavailable'
        using errcode = '23503';
    end if;
    execute
      'select tenant_id, project_id from public.tenant_project_change_orders where id = $1'
      into v_co_tenant, v_co_project
      using new.change_order_id;
    if v_co_tenant is null then
      raise exception 'payment_intent_change_order_missing'
        using errcode = '23503';
    end if;
    if v_co_tenant is distinct from new.tenant_id
       or v_co_project is distinct from new.project_id then
      raise exception 'payment_intent_change_order_scope_mismatch'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_tenant_project_payment_intents_assert_refs
  on public.tenant_project_payment_intents;
create trigger trg_tenant_project_payment_intents_assert_refs
  before insert or update of
    tenant_id, project_id, quote_id, schedule_id, schedule_item_id, change_order_id
  on public.tenant_project_payment_intents
  for each row
  execute function public.tenant_project_payment_intents_assert_refs();

comment on function public.tenant_project_payment_intents_assert_refs() is
  'CH-010B: enforces same-tenant/same-project ownership for payment intent references without altering parent tables.';

revoke all on function public.tenant_project_payment_intents_assert_refs() from public;
revoke all on function public.tenant_project_payment_intents_assert_refs() from anon;
revoke all on function public.tenant_project_payment_intents_assert_refs() from authenticated;
grant execute on function public.tenant_project_payment_intents_assert_refs() to service_role;

create index if not exists tenant_project_payment_intents_tenant_project_idx
  on public.tenant_project_payment_intents (tenant_id, project_id);

create index if not exists tenant_project_payment_intents_tenant_project_status_idx
  on public.tenant_project_payment_intents (tenant_id, project_id, status);

create index if not exists tenant_project_payment_intents_tenant_project_type_idx
  on public.tenant_project_payment_intents (tenant_id, project_id, payment_type);

create index if not exists tenant_project_payment_intents_tenant_project_order_idx
  on public.tenant_project_payment_intents (
    tenant_id,
    project_id,
    sequence_number nulls last,
    due_date nulls last,
    created_at,
    id
  );

create index if not exists tenant_project_payment_intents_tenant_quote_idx
  on public.tenant_project_payment_intents (tenant_id, quote_id)
  where quote_id is not null;

create index if not exists tenant_project_payment_intents_tenant_schedule_item_idx
  on public.tenant_project_payment_intents (tenant_id, schedule_item_id)
  where schedule_item_id is not null;

alter table public.tenant_project_payment_intents enable row level security;

drop policy if exists "service role full access tenant_project_payment_intents"
  on public.tenant_project_payment_intents;
create policy "service role full access tenant_project_payment_intents"
  on public.tenant_project_payment_intents
  for all
  to service_role
  using (true)
  with check (true);

revoke all on table public.tenant_project_payment_intents from public;
revoke all on table public.tenant_project_payment_intents from anon;
revoke all on table public.tenant_project_payment_intents from authenticated;
grant all on table public.tenant_project_payment_intents to service_role;
