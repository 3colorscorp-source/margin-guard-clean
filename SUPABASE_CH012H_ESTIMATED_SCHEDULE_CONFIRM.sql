-- =============================================================================
-- Margin Guard | CH-012H — Server-persisted Estimated Schedule confirmation
-- =============================================================================
-- STATUS: PREPARED FOR REVIEW — DO NOT APPLY until explicit owner authorization.
-- Do not run from CI. Do not apply automatically. Do not apply to real projects
-- as a test.
--
-- ADDITIVE SCOPE:
--   * project_contract_setups.schedule_confirmed_at
--   * project_contract_setups.schedule_confirmed_start_date
--   * project_contract_setups.schedule_confirmed_due_date
--   * project_contract_setups.schedule_confirmed_by  (FK → public.profiles)
--   * confirm_project_estimated_schedule(...)
--   * trg_quotes_invalidate_estimated_schedule (AFTER UPDATE OF start_date, due_date)
--   * invalidate_estimated_schedule_on_quote_date_change()
--
-- KEY: tenant_id + project_id + quote_id
-- Confirmation copies quotes.start_date / quotes.due_date. Both dates are
-- required. Browser dates are never written as authority.
--
-- NOT IN THIS MIGRATION:
--   * Article 7 / payment terms / payment schedule items
--   * Invoice Hub, ledger, Payment Intents
--   * frozen snapshot mutation, RLS policy changes, new tables
-- =============================================================================

begin;

do $preflight$
declare
  v_setup_exists boolean;
  v_profiles_exists boolean;
begin
  select exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'project_contract_setups'
  )
  into v_setup_exists;

  if v_setup_exists is not true then
    raise exception
      'CH-012H preflight failed: public.project_contract_setups is missing';
  end if;

  select exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'profiles'
  )
  into v_profiles_exists;

  if v_profiles_exists is not true then
    raise exception 'CH-012H preflight failed: public.profiles is missing';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'project_contract_setups_tenant_project_quote_key'
  ) then
    raise exception
      'CH-012H preflight failed: tenant/project/quote unique key is missing';
  end if;
end;
$preflight$;

alter table public.project_contract_setups
  add column if not exists schedule_confirmed_at timestamptz null,
  add column if not exists schedule_confirmed_start_date date null,
  add column if not exists schedule_confirmed_due_date date null,
  add column if not exists schedule_confirmed_by uuid null;

alter table public.project_contract_setups
  drop constraint if exists project_contract_setups_schedule_confirmed_by_fkey;

alter table public.project_contract_setups
  add constraint project_contract_setups_schedule_confirmed_by_fkey
  foreign key (schedule_confirmed_by)
  references public.profiles (id)
  on delete restrict;

alter table public.project_contract_setups
  drop constraint if exists project_contract_setups_schedule_confirm_consistency;

alter table public.project_contract_setups
  add constraint project_contract_setups_schedule_confirm_consistency
  check (
    (
      schedule_confirmed_at is null
      and schedule_confirmed_start_date is null
      and schedule_confirmed_due_date is null
      and schedule_confirmed_by is null
    )
    or (
      schedule_confirmed_at is not null
      and schedule_confirmed_start_date is not null
      and schedule_confirmed_due_date is not null
      and schedule_confirmed_by is not null
      and schedule_confirmed_due_date >= schedule_confirmed_start_date
    )
  );

comment on column public.project_contract_setups.schedule_confirmed_at is
  'CH-012H. Set only by confirm_project_estimated_schedule from the Owner/Admin session. Never accepted from the browser.';

comment on column public.project_contract_setups.schedule_confirmed_start_date is
  'CH-012H. Canonical copy of quotes.start_date at confirmation. Browser dates are not authority.';

comment on column public.project_contract_setups.schedule_confirmed_due_date is
  'CH-012H. Canonical copy of quotes.due_date at confirmation. Null is not confirmable.';

comment on column public.project_contract_setups.schedule_confirmed_by is
  'CH-012H. profiles.id of the Owner/Admin who confirmed. Resolved from the server session.';

create or replace function public.confirm_project_estimated_schedule(
  p_tenant_id uuid,
  p_project_id uuid,
  p_quote_id uuid,
  p_confirmed_by uuid
)
returns jsonb
language plpgsql
security definer
set search_path to pg_catalog, public
as $$
declare
  v_project record;
  v_quote record;
  v_now timestamptz := now();
  v_start date;
  v_due date;
  v_setup public.project_contract_setups%rowtype;
  v_row_count integer := 0;
begin
  -- CH-012H-CONFIRM-BEGIN
  if p_tenant_id is null or p_project_id is null or p_quote_id is null then
    raise exception 'MG_ERR:invalid_id:project_id and quote_id are required';
  end if;

  if p_confirmed_by is null then
    raise exception 'MG_ERR:membership_not_found:Owner or admin membership required';
  end if;

  perform pg_advisory_xact_lock(
    hashtext(p_tenant_id::text || ':' || p_quote_id::text)
  );
  perform pg_advisory_xact_lock(
    hashtext(
      p_tenant_id::text || ':' || p_project_id::text || ':' || p_quote_id::text
    )
  );

  if not exists (
    select 1 from public.tenants t where t.id = p_tenant_id
  ) then
    raise exception 'MG_ERR:setup_unavailable:Project contract setup unavailable';
  end if;

  if not exists (
    select 1
    from public.profiles p
    where p.id = p_confirmed_by
      and p.tenant_id = p_tenant_id
      and p.status = 'active'
      and p.role in ('owner', 'admin')
  ) then
    raise exception 'MG_ERR:membership_not_found:Owner or admin membership required';
  end if;

  select tp.id, tp.quote_id, tp.tenant_id
  into v_project
  from public.tenant_projects tp
  where tp.id = p_project_id
    and tp.tenant_id = p_tenant_id
  limit 1;

  if v_project.id is null then
    raise exception 'MG_ERR:setup_unavailable:Project contract setup unavailable';
  end if;

  if v_project.quote_id is null
     or v_project.quote_id is distinct from p_quote_id then
    raise exception 'MG_ERR:project_quote_mismatch:Quote does not belong to this project';
  end if;

  select q.id, q.tenant_id, q.start_date, q.due_date
  into v_quote
  from public.quotes q
  where q.id = p_quote_id
    and q.tenant_id = p_tenant_id
  limit 1;

  if v_quote.id is null then
    raise exception 'MG_ERR:setup_unavailable:Project contract setup unavailable';
  end if;

  v_start := v_quote.start_date;
  v_due := v_quote.due_date;

  if v_start is null then
    raise exception 'MG_ERR:schedule_start_missing:Estimated start date is required.';
  end if;

  if v_due is null then
    raise exception 'MG_ERR:schedule_completion_missing:Estimated completion date is required.';
  end if;

  if v_due < v_start then
    raise exception
      'MG_ERR:schedule_completion_before_start:Completion date must be on or after the start date.';
  end if;

  select *
  into v_setup
  from public.project_contract_setups s
  where s.tenant_id = p_tenant_id
    and s.project_id = p_project_id
    and s.quote_id = p_quote_id
  limit 1;

  if v_setup.id is not null
     and v_setup.schedule_confirmed_at is not null
     and v_setup.schedule_confirmed_start_date is not distinct from v_start
     and v_setup.schedule_confirmed_due_date is not distinct from v_due then
    return jsonb_build_object(
      'setup', to_jsonb(v_setup),
      'idempotent', true
    );
  end if;

  if v_setup.id is null then
    insert into public.project_contract_setups (
      tenant_id,
      project_id,
      quote_id,
      schedule_confirmed_at,
      schedule_confirmed_start_date,
      schedule_confirmed_due_date,
      schedule_confirmed_by,
      created_at,
      updated_at
    )
    values (
      p_tenant_id,
      p_project_id,
      p_quote_id,
      v_now,
      v_start,
      v_due,
      p_confirmed_by,
      v_now,
      v_now
    )
    returning * into v_setup;
  else
    update public.project_contract_setups s
    set
      schedule_confirmed_at = v_now,
      schedule_confirmed_start_date = v_start,
      schedule_confirmed_due_date = v_due,
      schedule_confirmed_by = p_confirmed_by,
      updated_at = v_now
    where s.id = v_setup.id
      and s.tenant_id = p_tenant_id
      and s.project_id = p_project_id
      and s.quote_id = p_quote_id
    returning * into v_setup;

    get diagnostics v_row_count = row_count;
    if v_row_count <> 1 then
      raise exception 'MG_ERR:save_failed:Project contract setup save failed';
    end if;
  end if;

  return jsonb_build_object(
    'setup', to_jsonb(v_setup),
    'idempotent', false
  );
  -- CH-012H-CONFIRM-END
end;
$$;

comment on function public.confirm_project_estimated_schedule(uuid, uuid, uuid, uuid) is
  'CH-012H: stamp estimated schedule confirmation from quotes.start_date/due_date. Service-role only. Browser dates are ignored. Confirmer must be an active Owner/Admin on the same tenant.';

create or replace function public.invalidate_estimated_schedule_on_quote_date_change()
returns trigger
language plpgsql
security definer
set search_path to pg_catalog, public
as $$
begin
  -- CH-012H-TRIGGER-BEGIN
  if TG_OP = 'UPDATE'
     and (
       NEW.start_date is distinct from OLD.start_date
       or NEW.due_date is distinct from OLD.due_date
     ) then
    update public.project_contract_setups s
    set
      schedule_confirmed_at = null,
      schedule_confirmed_start_date = null,
      schedule_confirmed_due_date = null,
      schedule_confirmed_by = null,
      updated_at = now()
    where s.tenant_id = NEW.tenant_id
      and s.quote_id = NEW.id
      and s.project_id in (
        select tp.id
        from public.tenant_projects tp
        where tp.tenant_id = NEW.tenant_id
          and tp.quote_id = NEW.id
      );
  end if;
  return NEW;
  -- CH-012H-TRIGGER-END
end;
$$;

comment on function public.invalidate_estimated_schedule_on_quote_date_change() is
  'CH-012H: when quotes.start_date or due_date actually change, clear matching estimated-schedule confirmation in the same transaction.';

drop trigger if exists trg_quotes_invalidate_estimated_schedule
  on public.quotes;
create trigger trg_quotes_invalidate_estimated_schedule
after update of start_date, due_date on public.quotes
for each row
execute function public.invalidate_estimated_schedule_on_quote_date_change();

alter function public.confirm_project_estimated_schedule(uuid, uuid, uuid, uuid)
  owner to postgres;
alter function public.invalidate_estimated_schedule_on_quote_date_change()
  owner to postgres;

revoke all on function public.confirm_project_estimated_schedule(uuid, uuid, uuid, uuid) from public;
revoke all on function public.confirm_project_estimated_schedule(uuid, uuid, uuid, uuid) from anon;
revoke all on function public.confirm_project_estimated_schedule(uuid, uuid, uuid, uuid) from authenticated;

grant execute on function public.confirm_project_estimated_schedule(uuid, uuid, uuid, uuid)
  to service_role;

revoke all on function public.invalidate_estimated_schedule_on_quote_date_change() from public;
revoke all on function public.invalidate_estimated_schedule_on_quote_date_change() from anon;
revoke all on function public.invalidate_estimated_schedule_on_quote_date_change() from authenticated;

do $postflight$
declare
  v_start boolean;
  v_due boolean;
  v_at boolean;
  v_by boolean;
  v_fk boolean;
  v_check boolean;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'project_contract_setups'
      and column_name = 'schedule_confirmed_at'
      and data_type = 'timestamp with time zone'
  ) into v_at;
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'project_contract_setups'
      and column_name = 'schedule_confirmed_start_date'
      and data_type = 'date'
  ) into v_start;
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'project_contract_setups'
      and column_name = 'schedule_confirmed_due_date'
      and data_type = 'date'
  ) into v_due;
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'project_contract_setups'
      and column_name = 'schedule_confirmed_by'
      and udt_name = 'uuid'
  ) into v_by;

  if v_at is not true or v_start is not true or v_due is not true or v_by is not true then
    raise exception 'CH-012H postflight failed: confirmation columns missing';
  end if;

  select exists (
    select 1
    from pg_constraint
    where conname = 'project_contract_setups_schedule_confirmed_by_fkey'
  ) into v_fk;
  if v_fk is not true then
    raise exception 'CH-012H postflight failed: schedule_confirmed_by FK missing';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'project_contract_setups_schedule_confirmed_by_fkey'
      and pg_get_constraintdef(oid) ilike '%on delete restrict%'
  ) then
    raise exception
      'CH-012H postflight failed: schedule_confirmed_by FK must ON DELETE RESTRICT';
  end if;

  select exists (
    select 1
    from pg_constraint
    where conname = 'project_contract_setups_schedule_confirm_consistency'
  ) into v_check;
  if v_check is not true then
    raise exception 'CH-012H postflight failed: consistency check missing';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'project_contract_setups_schedule_confirm_consistency'
      and pg_get_constraintdef(oid) ilike '%schedule_confirmed_due_date is not null%'
      and pg_get_constraintdef(oid) ilike '%schedule_confirmed_at is not null%'
      and pg_get_constraintdef(oid) ilike '%schedule_confirmed_start_date is not null%'
      and pg_get_constraintdef(oid) ilike '%schedule_confirmed_by is not null%'
  ) then
    raise exception
      'CH-012H postflight failed: consistency check must require all four confirmation fields';
  end if;

  if position(
       'CH-012H-CONFIRM-BEGIN'
       in pg_get_functiondef('public.confirm_project_estimated_schedule(uuid,uuid,uuid,uuid)'::regprocedure)
     ) = 0 then
    raise exception 'CH-012H postflight failed: confirm function markers missing';
  end if;

  if position(
       'MG_ERR:schedule_completion_missing'
       in pg_get_functiondef('public.confirm_project_estimated_schedule(uuid,uuid,uuid,uuid)'::regprocedure)
     ) = 0 then
    raise exception 'CH-012H postflight failed: null due_date reject missing';
  end if;

  if position(
       $q$p.id = p_confirmed_by$q$
       in pg_get_functiondef('public.confirm_project_estimated_schedule(uuid,uuid,uuid,uuid)'::regprocedure)
     ) = 0
     or position(
       $q$p.tenant_id = p_tenant_id$q$
       in pg_get_functiondef('public.confirm_project_estimated_schedule(uuid,uuid,uuid,uuid)'::regprocedure)
     ) = 0
     or position(
       $q$p.status = 'active'$q$
       in pg_get_functiondef('public.confirm_project_estimated_schedule(uuid,uuid,uuid,uuid)'::regprocedure)
     ) = 0
     or position(
       $q$p.role in ('owner', 'admin')$q$
       in pg_get_functiondef('public.confirm_project_estimated_schedule(uuid,uuid,uuid,uuid)'::regprocedure)
     ) = 0 then
    raise exception 'CH-012H postflight failed: confirmer tenant/active/owner-admin check missing';
  end if;

  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'apply_quote_schedule_date_change'
  ) then
    raise exception 'CH-012H postflight failed: unused apply_quote_schedule_date_change must not exist';
  end if;

  if position(
       'CH-012H-TRIGGER-BEGIN'
       in pg_get_functiondef(
         'public.invalidate_estimated_schedule_on_quote_date_change()'::regprocedure
       )
     ) = 0 then
    raise exception 'CH-012H postflight failed: quote date trigger markers missing';
  end if;

  if not exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'quotes'
      and t.tgname = 'trg_quotes_invalidate_estimated_schedule'
      and t.tgenabled <> 'D'
  ) then
    raise exception 'CH-012H postflight failed: quote date invalidation trigger missing';
  end if;
end;
$postflight$;

commit;
