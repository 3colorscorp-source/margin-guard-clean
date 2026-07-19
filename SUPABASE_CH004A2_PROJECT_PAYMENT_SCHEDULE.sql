-- =============================================================================
-- Margin Guard | CH-004A2 — Project Payment Schedule Foundation
-- =============================================================================
-- STATUS: MANUAL SUPABASE APPLY REQUIRED
--
-- Apply manually in Supabase SQL Editor only after owner review.
-- Do not run from CI. Do not apply automatically.
--
-- ADDITIVE SCOPE:
--   * public.project_contract_payment_schedules
--   * public.project_contract_payment_schedule_items
--   * public.replace_project_contract_payment_schedule(...)
--
-- NOT IN THIS MIGRATION:
--   * invoices, payments, signatures, contracts, or executed documents
--   * changes to quotes, tenant_projects, invoices, payments, or existing tables
--   * fake production rows
--
-- ROLLBACK (manual, only if required before production data exists):
--   drop function if exists public.replace_project_contract_payment_schedule(
--     uuid, uuid, uuid, numeric, text, boolean, jsonb, timestamptz
--   );
--   drop table if exists public.project_contract_payment_schedule_items cascade;
--   drop table if exists public.project_contract_payment_schedules cascade;
-- =============================================================================

create table if not exists public.project_contract_payment_schedules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  project_id uuid not null references public.tenant_projects (id) on delete cascade,
  quote_id uuid not null references public.quotes (id) on delete cascade,

  currency text not null default 'USD'
    check (char_length(currency) <= 12),
  contract_total numeric(14,2) not null
    check (contract_total >= 0),
  status text not null default 'draft'
    check (status in ('draft', 'confirmed')),
  confirmed_at timestamptz null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint project_contract_payment_schedules_tenant_project_quote_key
    unique (tenant_id, project_id, quote_id),
  constraint project_contract_payment_schedules_tenant_id_id_key
    unique (tenant_id, id),
  constraint project_contract_payment_schedules_confirmation_state_chk
    check (
      (status = 'draft' and confirmed_at is null)
      or (status = 'confirmed' and confirmed_at is not null)
    )
);

comment on table public.project_contract_payment_schedules is
  'Tenant-scoped planned contract payment schedule. It is not an invoice, payment ledger, or payment request.';

comment on column public.project_contract_payment_schedules.tenant_id is
  'Resolved from authenticated server session only; never accepted from browser input.';

comment on column public.project_contract_payment_schedules.contract_total is
  'Server-derived from tenant_projects.sale_price or approved quote total only. Never browser supplied.';

comment on column public.project_contract_payment_schedules.confirmed_at is
  'Set by the Owner/Admin endpoint only when schedule items exactly total the authoritative contract total.';

create table if not exists public.project_contract_payment_schedule_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  schedule_id uuid not null references public.project_contract_payment_schedules (id) on delete cascade,

  sequence_number integer not null
    check (sequence_number >= 1),
  label text not null default ''
    check (char_length(label) <= 160),
  payment_type text not null
    check (payment_type in ('deposit', 'start', 'progress', 'material', 'completion', 'final', 'custom')),
  amount numeric(14,2) not null
    check (amount >= 0),
  percentage numeric(7,4) null
    check (percentage is null or (percentage >= 0 and percentage <= 100)),
  due_rule text not null
    check (due_rule in ('on_signature', 'before_start', 'on_start', 'milestone', 'on_completion', 'fixed_date', 'custom')),
  milestone_description text not null default ''
    check (char_length(milestone_description) <= 1000),
  fixed_due_date date null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint project_contract_payment_schedule_items_tenant_schedule_sequence_key
    unique (tenant_id, schedule_id, sequence_number),
  constraint project_contract_payment_schedule_items_tenant_schedule_fk
    foreign key (tenant_id, schedule_id)
    references public.project_contract_payment_schedules (tenant_id, id)
    on delete cascade,
  constraint project_contract_payment_schedule_items_fixed_due_date_chk
    check (
      (due_rule = 'fixed_date' and fixed_due_date is not null)
      or (due_rule <> 'fixed_date' and fixed_due_date is null)
    )
);

comment on table public.project_contract_payment_schedule_items is
  'Tenant-scoped planned payment stages for a contract schedule. These rows do not create invoices or record payments.';

comment on column public.project_contract_payment_schedule_items.percentage is
  'Server-derived from amount divided by authoritative contract_total; browser input is ignored/rejected by the handler.';

create index if not exists project_contract_payment_schedules_tenant_id_idx
  on public.project_contract_payment_schedules (tenant_id);

create index if not exists project_contract_payment_schedules_tenant_project_idx
  on public.project_contract_payment_schedules (tenant_id, project_id);

create index if not exists project_contract_payment_schedules_tenant_quote_idx
  on public.project_contract_payment_schedules (tenant_id, quote_id);

create index if not exists project_contract_payment_schedule_items_tenant_id_idx
  on public.project_contract_payment_schedule_items (tenant_id);

create index if not exists project_contract_payment_schedule_items_tenant_schedule_idx
  on public.project_contract_payment_schedule_items (tenant_id, schedule_id);

drop trigger if exists trg_project_contract_payment_schedules_updated_at
  on public.project_contract_payment_schedules;
create trigger trg_project_contract_payment_schedules_updated_at
before update on public.project_contract_payment_schedules
for each row execute function public.set_updated_at();

drop trigger if exists trg_project_contract_payment_schedule_items_updated_at
  on public.project_contract_payment_schedule_items;
create trigger trg_project_contract_payment_schedule_items_updated_at
before update on public.project_contract_payment_schedule_items
for each row execute function public.set_updated_at();

alter table public.project_contract_payment_schedules enable row level security;
alter table public.project_contract_payment_schedule_items enable row level security;

drop policy if exists "service role full access project_contract_payment_schedules"
  on public.project_contract_payment_schedules;
create policy "service role full access project_contract_payment_schedules"
on public.project_contract_payment_schedules
for all
to service_role
using (true)
with check (true);

drop policy if exists "service role full access project_contract_payment_schedule_items"
  on public.project_contract_payment_schedule_items;
create policy "service role full access project_contract_payment_schedule_items"
on public.project_contract_payment_schedule_items
for all
to service_role
using (true)
with check (true);

-- -----------------------------------------------------------------------------
-- Atomic schedule replacement RPC (single PostgreSQL transaction)
-- -----------------------------------------------------------------------------

create or replace function public.replace_project_contract_payment_schedule(
  p_tenant_id uuid,
  p_project_id uuid,
  p_quote_id uuid,
  p_contract_total numeric,
  p_currency text,
  p_confirm_schedule boolean,
  p_items jsonb,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_project record;
  v_quote record;
  v_auth_total numeric(14,2);
  v_currency text;
  v_total_source text;
  v_schedule public.project_contract_payment_schedules%rowtype;
  v_item jsonb;
  v_idx integer := 0;
  v_seq integer;
  v_label text;
  v_payment_type text;
  v_amount numeric(14,2);
  v_due_rule text;
  v_milestone text;
  v_fixed_due_date date;
  v_percentage numeric(7,4);
  v_seen_sequences int[] := array[]::int[];
  v_scheduled_total numeric(14,2) := 0;
  v_status text;
  v_confirmed_at timestamptz;
  v_now timestamptz := now();
  v_items_out jsonb := '[]'::jsonb;
  v_item_count integer := 0;
  v_readiness_status text;
  v_row_count integer := 0;
  v_item_row jsonb;
  v_allowed_item_keys text[] := array[
    'sequence_number',
    'label',
    'payment_type',
    'amount',
    'due_rule',
    'milestone_description',
    'fixed_due_date'
  ];
begin
  if p_tenant_id is null or p_project_id is null or p_quote_id is null then
    raise exception 'MG_ERR:invalid_id:project_id and quote_id are required';
  end if;

  if p_confirm_schedule is null then
    raise exception 'MG_ERR:invalid_confirmation:confirm_schedule must be a boolean';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'MG_ERR:invalid_items:items must be a JSON array';
  end if;

  -- Deterministic transaction lock for this logical schedule resource.
  perform pg_advisory_xact_lock(
    hashtext(
      p_tenant_id::text || ':' || p_project_id::text || ':' || p_quote_id::text
    )
  );

  if not exists (
    select 1
    from public.tenants t
    where t.id = p_tenant_id
  ) then
    raise exception 'MG_ERR:schedule_unavailable:Project payment schedule unavailable';
  end if;

  select tp.id, tp.quote_id, tp.sale_price
  into v_project
  from public.tenant_projects tp
  where tp.id = p_project_id
    and tp.tenant_id = p_tenant_id
  limit 1;

  if v_project.id is null then
    raise exception 'MG_ERR:schedule_unavailable:Project payment schedule unavailable';
  end if;

  if v_project.quote_id is null
     or v_project.quote_id is distinct from p_quote_id then
    raise exception 'MG_ERR:project_quote_mismatch:Quote does not belong to this project';
  end if;

  select q.id, q.total, q.currency, q.status
  into v_quote
  from public.quotes q
  where q.id = p_quote_id
    and q.tenant_id = p_tenant_id
  limit 1;

  if v_quote.id is null then
    raise exception 'MG_ERR:schedule_unavailable:Project payment schedule unavailable';
  end if;

  if v_project.sale_price is not null and v_project.sale_price > 0 then
    v_auth_total := round(v_project.sale_price::numeric, 2);
    v_total_source := 'tenant_projects.sale_price';
  elsif lower(coalesce(v_quote.status, '')) in ('accepted', 'approved')
        and v_quote.total is not null
        and v_quote.total > 0 then
    v_auth_total := round(v_quote.total::numeric, 2);
    v_total_source := 'approved_quote.total';
  else
    raise exception 'MG_ERR:contract_total_unavailable:Authoritative contract total is unavailable';
  end if;

  if p_contract_total is null
     or round(p_contract_total::numeric, 2) is distinct from v_auth_total then
    raise exception 'MG_ERR:contract_total_changed:Authoritative contract total changed. Reload before saving.';
  end if;

  v_currency := left(nullif(btrim(coalesce(v_quote.currency, '')), ''), 12);
  if v_currency is null or v_currency = '' then
    v_currency := 'USD';
  end if;
  if left(nullif(btrim(coalesce(p_currency, '')), ''), 12) is distinct from v_currency then
    raise exception 'MG_ERR:currency_mismatch:Currency does not match the authoritative quote currency';
  end if;

  select *
  into v_schedule
  from public.project_contract_payment_schedules s
  where s.tenant_id = p_tenant_id
    and s.project_id = p_project_id
    and s.quote_id = p_quote_id
  limit 1;

  if v_schedule.id is null then
    if p_expected_updated_at is not null then
      raise exception 'MG_ERR:schedule_version_conflict:This payment schedule changed in another session. Reload before saving.';
    end if;
  else
    if p_expected_updated_at is null
       or p_expected_updated_at is distinct from v_schedule.updated_at then
      raise exception 'MG_ERR:schedule_version_conflict:This payment schedule changed in another session. Reload before saving.';
    end if;
  end if;

  -- Validate and normalize items before any mutation.
  for v_item in
    select value
    from jsonb_array_elements(p_items) as t(value)
  loop
    v_idx := v_idx + 1;
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'MG_ERR:invalid_item:items[%] must be an object', v_idx - 1;
    end if;

    if exists (
      select 1
      from jsonb_object_keys(v_item) as k
      where not (k = any (v_allowed_item_keys))
    ) then
      raise exception 'MG_ERR:unknown_item_fields:Unknown item fields rejected';
    end if;

    begin
      v_seq := (v_item ->> 'sequence_number')::integer;
    exception
      when others then
        raise exception 'MG_ERR:invalid_sequence:sequence_number must be an integer >= 1';
    end;
    if v_seq is null or v_seq < 1 then
      raise exception 'MG_ERR:invalid_sequence:sequence_number must be an integer >= 1';
    end if;
    if v_seq = any (v_seen_sequences) then
      raise exception 'MG_ERR:duplicate_sequence:Duplicate sequence_number';
    end if;
    v_seen_sequences := array_append(v_seen_sequences, v_seq);

    v_label := coalesce(btrim(v_item ->> 'label'), '');
    if char_length(v_label) > 160 then
      raise exception 'MG_ERR:invalid_label:label exceeds 160 characters';
    end if;

    v_payment_type := lower(btrim(coalesce(v_item ->> 'payment_type', '')));
    if v_payment_type not in (
      'deposit', 'start', 'progress', 'material', 'completion', 'final', 'custom'
    ) then
      raise exception 'MG_ERR:invalid_enum:Invalid payment_type';
    end if;

    begin
      v_amount := round((v_item ->> 'amount')::numeric, 2);
    exception
      when others then
        raise exception 'MG_ERR:invalid_amount:amount must be a non-negative amount with up to 2 decimals';
    end;
    if v_amount is null or v_amount < 0 then
      raise exception 'MG_ERR:invalid_amount:amount must be a non-negative amount with up to 2 decimals';
    end if;

    v_due_rule := lower(btrim(coalesce(v_item ->> 'due_rule', '')));
    if v_due_rule not in (
      'on_signature', 'before_start', 'on_start', 'milestone',
      'on_completion', 'fixed_date', 'custom'
    ) then
      raise exception 'MG_ERR:invalid_enum:Invalid due_rule';
    end if;

    v_milestone := coalesce(btrim(v_item ->> 'milestone_description'), '');
    if char_length(v_milestone) > 1000 then
      raise exception 'MG_ERR:invalid_milestone:milestone_description exceeds 1000 characters';
    end if;

    if v_item ? 'fixed_due_date'
       and nullif(btrim(v_item ->> 'fixed_due_date'), '') is not null then
      begin
        v_fixed_due_date := (btrim(v_item ->> 'fixed_due_date'))::date;
      exception
        when others then
          raise exception 'MG_ERR:invalid_fixed_due_date:fixed_due_date must be YYYY-MM-DD';
      end;
    else
      v_fixed_due_date := null;
    end if;

    if v_due_rule = 'fixed_date' and v_fixed_due_date is null then
      raise exception 'MG_ERR:fixed_date_required:fixed_due_date is required for fixed_date due_rule';
    end if;
    if v_due_rule <> 'fixed_date' and v_fixed_due_date is not null then
      raise exception 'MG_ERR:fixed_date_not_allowed:fixed_due_date must be null unless due_rule is fixed_date';
    end if;

    v_scheduled_total := v_scheduled_total + v_amount;
  end loop;

  v_item_count := coalesce(jsonb_array_length(p_items), 0);

  if p_confirm_schedule and v_item_count < 1 then
    raise exception 'MG_ERR:items_required:At least one payment stage is required to confirm a schedule';
  end if;

  if p_confirm_schedule and v_scheduled_total is distinct from v_auth_total then
    raise exception 'MG_ERR:schedule_total_mismatch:Payment schedule total must equal the contract total before confirmation';
  end if;

  if p_confirm_schedule and v_scheduled_total = v_auth_total and v_item_count > 0 then
    v_status := 'confirmed';
    v_confirmed_at := v_now;
  else
    v_status := 'draft';
    v_confirmed_at := null;
  end if;

  if v_schedule.id is null then
    insert into public.project_contract_payment_schedules (
      tenant_id,
      project_id,
      quote_id,
      currency,
      contract_total,
      status,
      confirmed_at,
      created_at,
      updated_at
    )
    values (
      p_tenant_id,
      p_project_id,
      p_quote_id,
      v_currency,
      v_auth_total,
      v_status,
      v_confirmed_at,
      v_now,
      v_now
    )
    returning * into v_schedule;
  else
    update public.project_contract_payment_schedules s
    set
      currency = v_currency,
      contract_total = v_auth_total,
      status = v_status,
      confirmed_at = v_confirmed_at,
      updated_at = v_now
    where s.id = v_schedule.id
      and s.tenant_id = p_tenant_id
    returning * into v_schedule;

    get diagnostics v_row_count = row_count;
    if v_row_count <> 1 then
      raise exception 'MG_ERR:save_failed:Payment schedule save failed';
    end if;
  end if;

  delete from public.project_contract_payment_schedule_items i
  where i.tenant_id = p_tenant_id
    and i.schedule_id = v_schedule.id;

  for v_item in
    select t.value
    from jsonb_array_elements(p_items) as t(value)
    order by (t.value ->> 'sequence_number')::integer
  loop
    v_seq := (v_item ->> 'sequence_number')::integer;
    v_label := coalesce(btrim(v_item ->> 'label'), '');
    v_payment_type := lower(btrim(coalesce(v_item ->> 'payment_type', '')));
    v_amount := round((v_item ->> 'amount')::numeric, 2);
    v_due_rule := lower(btrim(coalesce(v_item ->> 'due_rule', '')));
    v_milestone := coalesce(btrim(v_item ->> 'milestone_description'), '');
    if v_item ? 'fixed_due_date'
       and nullif(btrim(v_item ->> 'fixed_due_date'), '') is not null then
      v_fixed_due_date := (btrim(v_item ->> 'fixed_due_date'))::date;
    else
      v_fixed_due_date := null;
    end if;

    if v_auth_total > 0 then
      v_percentage := round((v_amount * 100) / v_auth_total, 4);
    else
      v_percentage := null;
    end if;

    insert into public.project_contract_payment_schedule_items (
      tenant_id,
      schedule_id,
      sequence_number,
      label,
      payment_type,
      amount,
      percentage,
      due_rule,
      milestone_description,
      fixed_due_date,
      created_at,
      updated_at
    )
    values (
      p_tenant_id,
      v_schedule.id,
      v_seq,
      v_label,
      v_payment_type,
      v_amount,
      v_percentage,
      v_due_rule,
      v_milestone,
      v_fixed_due_date,
      v_now,
      v_now
    )
    returning jsonb_build_object(
      'id', id,
      'sequence_number', sequence_number,
      'label', label,
      'payment_type', payment_type,
      'amount', amount,
      'percentage', percentage,
      'due_rule', due_rule,
      'milestone_description', milestone_description,
      'fixed_due_date', fixed_due_date
    ) into v_item_row;

    v_items_out := v_items_out || jsonb_build_array(v_item_row);
  end loop;

  select coalesce(sum(i.amount), 0), count(*)::integer
  into v_scheduled_total, v_item_count
  from public.project_contract_payment_schedule_items i
  where i.tenant_id = p_tenant_id
    and i.schedule_id = v_schedule.id;

  if v_status = 'confirmed'
     and (
       v_item_count < 1
       or v_scheduled_total is distinct from v_auth_total
       or v_confirmed_at is null
     ) then
    raise exception 'MG_ERR:schedule_total_mismatch:Payment schedule total must equal the contract total before confirmation';
  end if;

  if v_status = 'confirmed' then
    v_readiness_status := 'configured';
  else
    v_readiness_status := 'draft';
  end if;

  return jsonb_build_object(
    'schedule', jsonb_build_object(
      'id', v_schedule.id,
      'tenant_id', v_schedule.tenant_id,
      'project_id', v_schedule.project_id,
      'quote_id', v_schedule.quote_id,
      'currency', v_schedule.currency,
      'contract_total', v_schedule.contract_total,
      'status', v_schedule.status,
      'confirmed_at', v_schedule.confirmed_at,
      'created_at', v_schedule.created_at,
      'updated_at', v_schedule.updated_at
    ),
    'items', v_items_out,
    'readiness', jsonb_build_object(
      'status', v_readiness_status,
      'contract_total', v_auth_total,
      'scheduled_total', v_scheduled_total,
      'remaining_difference', (v_auth_total - v_scheduled_total),
      'item_count', v_item_count,
      'confirmed_at', v_schedule.confirmed_at
    ),
    'source', jsonb_build_object(
      'contract_total_source', v_total_source,
      'currency', v_currency
    )
  );
end;
$$;

comment on function public.replace_project_contract_payment_schedule(
  uuid, uuid, uuid, numeric, text, boolean, jsonb, timestamptz
) is
  'Atomic Owner/Admin payment schedule replacement. Service-role only. Validates relationships, totals, and optimistic concurrency inside one transaction.';

revoke all on function public.replace_project_contract_payment_schedule(
  uuid, uuid, uuid, numeric, text, boolean, jsonb, timestamptz
) from public;

revoke execute on function public.replace_project_contract_payment_schedule(
  uuid, uuid, uuid, numeric, text, boolean, jsonb, timestamptz
) from anon;

revoke execute on function public.replace_project_contract_payment_schedule(
  uuid, uuid, uuid, numeric, text, boolean, jsonb, timestamptz
) from authenticated;

grant execute on function public.replace_project_contract_payment_schedule(
  uuid, uuid, uuid, numeric, text, boolean, jsonb, timestamptz
) to service_role;

-- No anon or authenticated policies. Browser access is via Netlify handlers.
-- This migration inserts no rows.
