-- =============================================================================
-- Margin Guard | CH-012H rollback — drop estimated schedule confirmation
-- =============================================================================
-- STATUS: PREPARED — DO NOT APPLY unless CH-012H was applied.
-- Drops only CH-012H columns, constraints, and RPCs. Does not touch Article 7,
-- payment schedules, Invoice Hub, ledger, or frozen snapshots.
-- =============================================================================

begin;

do $preflight$
begin
  if not exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'project_contract_setups'
  ) then
    raise exception
      'CH-012H rollback preflight failed: public.project_contract_setups is missing';
  end if;
end;
$preflight$;

drop trigger if exists trg_quotes_invalidate_estimated_schedule on public.quotes;
drop function if exists public.invalidate_estimated_schedule_on_quote_date_change();
drop function if exists public.confirm_project_estimated_schedule(uuid, uuid, uuid, uuid);
drop function if exists public.apply_quote_schedule_date_change(uuid, uuid, date, date, boolean, boolean);

alter table public.project_contract_setups
  drop constraint if exists project_contract_setups_schedule_confirm_consistency;

alter table public.project_contract_setups
  drop constraint if exists project_contract_setups_schedule_confirmed_by_fkey;

alter table public.project_contract_setups
  drop column if exists schedule_confirmed_at,
  drop column if exists schedule_confirmed_start_date,
  drop column if exists schedule_confirmed_due_date,
  drop column if exists schedule_confirmed_by;

do $postflight$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'confirm_project_estimated_schedule',
        'apply_quote_schedule_date_change',
        'invalidate_estimated_schedule_on_quote_date_change'
      )
  ) then
    raise exception 'CH-012H rollback postflight failed: CH-012H functions still present';
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'project_contract_setups'
      and column_name in (
        'schedule_confirmed_at',
        'schedule_confirmed_start_date',
        'schedule_confirmed_due_date',
        'schedule_confirmed_by'
      )
  ) then
    raise exception 'CH-012H rollback postflight failed: confirmation columns still present';
  end if;

  if exists (
    select 1
    from pg_constraint
    where conname in (
      'project_contract_setups_schedule_confirmed_by_fkey',
      'project_contract_setups_schedule_confirm_consistency'
    )
  ) then
    raise exception 'CH-012H rollback postflight failed: CH-012H constraints still present';
  end if;

  if exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'quotes'
      and t.tgname = 'trg_quotes_invalidate_estimated_schedule'
  ) then
    raise exception 'CH-012H rollback postflight failed: quote date trigger still present';
  end if;
end;
$postflight$;

commit;
