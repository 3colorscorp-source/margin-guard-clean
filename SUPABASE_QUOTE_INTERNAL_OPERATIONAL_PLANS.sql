-- Phase 1 Voice Operational Plan — dedicated internal table.
-- DO NOT apply this file to remote Supabase from this PR.
-- Live inspect confirmed one public.mg_confirm_quote_operational_plan with
-- 11 arguments and 8 defaults, including p_membership_id DEFAULT NULL.
-- quote_internal_operational_plans is complete. PostgREST schema cache was
-- reloaded with NOTIFY pgrst, 'reload schema'. No align migration.
-- Read-only inspect helper: SUPABASE_QUOTE_INTERNAL_OPERATIONAL_PLANS_INSPECT.sql
-- Never select or return this table from public estimate, accept, PDF, email, or Zapier.

create table if not exists public.quote_internal_operational_plans (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  document jsonb not null,
  schema_version integer not null default 1,
  last_updated_by_membership_id uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint quote_internal_operational_plans_tenant_quote_uidx unique (tenant_id, quote_id),
  constraint quote_internal_operational_plans_document_object
    check (jsonb_typeof(document) = 'object')
);

comment on table public.quote_internal_operational_plans is
  'Tenant-internal structured daily operational plan. Service-role Netlify only. Never expose on public quote APIs.';

comment on column public.quote_internal_operational_plans.document is
  'Versioned JSON: schema_version, source, days[].day_id, client_scope, internal tasks/assignments. No labor rates.';

comment on column public.quote_internal_operational_plans.last_updated_by_membership_id is
  'Membership id that last confirmed the plan, when the session has one.';

create index if not exists quote_internal_operational_plans_quote_id_idx
  on public.quote_internal_operational_plans (quote_id);

alter table public.quote_internal_operational_plans enable row level security;
alter table public.quote_internal_operational_plans force row level security;

revoke all on table public.quote_internal_operational_plans from public;
revoke all on table public.quote_internal_operational_plans from anon;
revoke all on table public.quote_internal_operational_plans from authenticated;

grant select, insert, update, delete on table public.quote_internal_operational_plans to service_role;

drop policy if exists "service role full access quote_internal_operational_plans"
  on public.quote_internal_operational_plans;

create policy "service role full access quote_internal_operational_plans"
  on public.quote_internal_operational_plans
  for all
  to service_role
  using (true)
  with check (true);

-- Confirm the internal document and its quote-facing projection in one transaction.
-- The Netlify endpoint performs the owner/seller and CH-011 edit guards before this call.
create or replace function public.mg_confirm_quote_operational_plan(
  p_tenant_id uuid,
  p_quote_id uuid,
  p_document jsonb,
  p_schema_version integer default 1,
  p_membership_id uuid default null,
  p_operational_plan jsonb default '[]'::jsonb,
  p_estimated_days numeric default null,
  p_estimated_hours numeric default null,
  p_start_date date default null,
  p_due_date date default null,
  p_scope_of_work text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_quote public.quotes%rowtype;
begin
  if p_document is null or jsonb_typeof(p_document) <> 'object' then
    raise exception 'p_document must be a JSON object' using errcode = '22023';
  end if;
  if p_operational_plan is null or jsonb_typeof(p_operational_plan) <> 'array' then
    raise exception 'p_operational_plan must be a JSON array' using errcode = '22023';
  end if;

  select q.*
    into v_quote
    from public.quotes q
   where q.id = p_quote_id
     and q.tenant_id = p_tenant_id
   for update;

  if v_quote.id is null then
    raise exception 'quote not found for tenant' using errcode = 'P0002';
  end if;

  -- Recheck the contractual lock while holding the quote row lock.
  if lower(btrim(coalesce(v_quote.status, ''))) not in (
    'draft', 'ready_to_send', 'sent', 'pending', 'declined', 'rejected'
  )
    or v_quote.accepted_at is not null
    or v_quote.deposit_paid_at is not null
    or nullif(btrim(coalesce(v_quote.exclusions_initials, '')), '') is not null
    or v_quote.exclusions_acknowledged_at is not null
    or v_quote.change_order_acknowledged_at is not null
    or exists (
      select 1
        from public.tenant_projects tp
       where tp.tenant_id = p_tenant_id
         and tp.quote_id = p_quote_id
    )
    or exists (
      select 1
        from public.invoices i
       where i.tenant_id = p_tenant_id
         and i.quote_id = p_quote_id
         and lower(btrim(coalesce(i.status, ''))) not in (
           'void', 'archived', 'cancelled', 'canceled'
         )
    )
    or exists (
      select 1
        from public.tenant_project_payments tpp
       where tpp.tenant_id = p_tenant_id
         and (
           tpp.quote_id = p_quote_id
           or tpp.invoice_id in (
             select i.id
               from public.invoices i
              where i.tenant_id = p_tenant_id
                and i.quote_id = p_quote_id
           )
         )
    )
  then
    raise exception 'quote is locked and cannot be edited' using errcode = '55000';
  end if;

  update public.quotes q
     set operational_plan = p_operational_plan,
         estimated_days = p_estimated_days,
         estimated_hours = p_estimated_hours,
         start_date = coalesce(p_start_date, q.start_date),
         due_date = coalesce(p_due_date, q.due_date),
         scope_of_work = coalesce(nullif(btrim(p_scope_of_work), ''), q.scope_of_work),
         updated_at = timezone('utc', now())
   where q.id = p_quote_id
     and q.tenant_id = p_tenant_id;

  insert into public.quote_internal_operational_plans (
    quote_id,
    tenant_id,
    document,
    schema_version,
    last_updated_by_membership_id,
    created_at,
    updated_at
  ) values (
    p_quote_id,
    p_tenant_id,
    p_document,
    greatest(coalesce(p_schema_version, 1), 1),
    p_membership_id,
    timezone('utc', now()),
    timezone('utc', now())
  )
  on conflict (tenant_id, quote_id) do update
    set document = excluded.document,
        schema_version = excluded.schema_version,
        last_updated_by_membership_id = excluded.last_updated_by_membership_id,
        updated_at = excluded.updated_at;

  return jsonb_build_object(
    'ok', true,
    'quote_id', p_quote_id,
    'tenant_id', p_tenant_id,
    'persisted', true
  );
end;
$function$;

revoke all on function public.mg_confirm_quote_operational_plan(
  uuid, uuid, jsonb, integer, uuid, jsonb, numeric, numeric, date, date, text
) from public;
revoke all on function public.mg_confirm_quote_operational_plan(
  uuid, uuid, jsonb, integer, uuid, jsonb, numeric, numeric, date, date, text
) from anon;
revoke all on function public.mg_confirm_quote_operational_plan(
  uuid, uuid, jsonb, integer, uuid, jsonb, numeric, numeric, date, date, text
) from authenticated;
grant execute on function public.mg_confirm_quote_operational_plan(
  uuid, uuid, jsonb, integer, uuid, jsonb, numeric, numeric, date, date, text
) to service_role;

