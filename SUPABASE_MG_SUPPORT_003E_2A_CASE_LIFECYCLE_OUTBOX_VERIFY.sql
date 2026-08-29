-- =============================================================================
-- Margin Guard | MG-SUPPORT-003E.2A VERIFY (read-only)
-- =============================================================================
-- STATUS: MANUAL. Do not run from CI. Does not insert, update, or delete rows.
-- Run after SUPABASE_MG_SUPPORT_003E_2A_CASE_LIFECYCLE_OUTBOX.sql.
-- =============================================================================

do $$
declare
  v_ok boolean := false;
  v_nullable text;
  v_type text;
  v_default text;
  v_def text;
  v_open integer := 0;
  v_resolved integer := 0;
  v_other integer := 0;
  v_bad_version integer := 0;
  v_filled_resolution integer := 0;
  v_filled_action integer := 0;
  v_outbox integer := 0;
  v_svc_priv integer := 0;
begin
  if to_regclass('public.tenant_support_cases') is null then
    raise exception 'MG-SUPPORT-003E.2A VERIFY FAIL: tenant_support_cases missing';
  end if;

  -- 1. status CHECK allows exactly the four canonical values
  select pg_get_constraintdef(oid)
    into v_def
    from pg_constraint
   where conrelid = 'public.tenant_support_cases'::regclass
     and contype = 'c'
     and conname = 'tenant_support_cases_status_check';

  if v_def is null then
    raise exception 'MG-SUPPORT-003E.2A VERIFY FAIL: status CHECK missing';
  end if;
  if v_def !~* 'in_review' or v_def !~* 'waiting_on_customer' then
    raise exception 'MG-SUPPORT-003E.2A VERIFY FAIL: status CHECK missing new values: %', v_def;
  end if;
  if v_def ~* 'closed' or v_def ~* 'waiting_on_user' or v_def ~* 'pending' or v_def ~* 'reviewing' then
    raise exception 'MG-SUPPORT-003E.2A VERIFY FAIL: status CHECK contains forbidden value: %', v_def;
  end if;
  if v_def !~* '\mopen\M' or v_def !~* '\mresolved\M' then
    raise exception 'MG-SUPPORT-003E.2A VERIFY FAIL: status CHECK missing open/resolved: %', v_def;
  end if;

  -- 2–4. snapshot columns
  select data_type, is_nullable
    into v_type, v_nullable
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'tenant_support_cases'
     and column_name = 'customer_resolution';
  if v_type is distinct from 'text' or v_nullable is distinct from 'YES' then
    raise exception 'MG-SUPPORT-003E.2A VERIFY FAIL: customer_resolution must be nullable text';
  end if;

  select data_type, is_nullable
    into v_type, v_nullable
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'tenant_support_cases'
     and column_name = 'tenant_action_message';
  if v_type is distinct from 'text' or v_nullable is distinct from 'YES' then
    raise exception 'MG-SUPPORT-003E.2A VERIFY FAIL: tenant_action_message must be nullable text';
  end if;

  select data_type, is_nullable, column_default
    into v_type, v_nullable, v_default
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'tenant_support_cases'
     and column_name = 'status_version';
  if v_type is distinct from 'integer' or v_nullable is distinct from 'NO' then
    raise exception 'MG-SUPPORT-003E.2A VERIFY FAIL: status_version must be integer NOT NULL';
  end if;
  if v_default is null or v_default !~ '1' then
    raise exception 'MG-SUPPORT-003E.2A VERIFY FAIL: status_version default is not 1: %', v_default;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'tenant_support_cases'
      and column_name in ('tenant_action_required', 'internal_note', 'internal_notes')
  ) then
    raise exception 'MG-SUPPORT-003E.2A VERIFY FAIL: unexpected tenant_action_required/internal_note column';
  end if;

  -- 5–7. length + waiting invariant
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenant_support_cases'::regclass
      and conname = 'tenant_support_cases_customer_resolution_len_check'
      and pg_get_constraintdef(oid) ilike '%400%'
  ) then
    raise exception 'MG-SUPPORT-003E.2A VERIFY FAIL: customer_resolution length CHECK missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenant_support_cases'::regclass
      and conname = 'tenant_support_cases_tenant_action_message_len_check'
      and pg_get_constraintdef(oid) ilike '%400%'
  ) then
    raise exception 'MG-SUPPORT-003E.2A VERIFY FAIL: tenant_action_message length CHECK missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenant_support_cases'::regclass
      and conname = 'tenant_support_cases_waiting_action_message_check'
      and pg_get_constraintdef(oid) ilike '%waiting_on_customer%'
  ) then
    raise exception 'MG-SUPPORT-003E.2A VERIFY FAIL: waiting action-message invariant missing';
  end if;

  -- 8–10. existing rows remain open/resolved, version 1, new texts null
  select
    count(*) filter (where status = 'open'),
    count(*) filter (where status = 'resolved'),
    count(*) filter (where status not in ('open', 'resolved')),
    count(*) filter (where status_version is distinct from 1),
    count(*) filter (where customer_resolution is not null),
    count(*) filter (where tenant_action_message is not null)
    into v_open, v_resolved, v_other, v_bad_version, v_filled_resolution, v_filled_action
    from public.tenant_support_cases;

  if v_other > 0 then
    raise exception 'MG-SUPPORT-003E.2A VERIFY FAIL: unexpected case status after migration';
  end if;
  if v_bad_version > 0 then
    raise exception 'MG-SUPPORT-003E.2A VERIFY FAIL: existing rows must have status_version = 1';
  end if;
  if v_filled_resolution > 0 or v_filled_action > 0 then
    raise exception 'MG-SUPPORT-003E.2A VERIFY FAIL: snapshot text columns were populated';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'tenant_support_cases'
      and indexname = 'tenant_support_cases_tenant_status_created_idx'
  ) then
    raise exception 'MG-SUPPORT-003E.2A VERIFY FAIL: existing tenant/status/created index missing';
  end if;

  -- 11–16. outbox table
  if to_regclass('public.tenant_support_notification_outbox') is null then
    raise exception 'MG-SUPPORT-003E.2A VERIFY FAIL: outbox table missing';
  end if;

  if exists (
    select 1
    from (
      values
        ('id', 'uuid', 'NO'),
        ('tenant_id', 'uuid', 'NO'),
        ('case_id', 'uuid', 'NO'),
        ('event_type', 'text', 'NO'),
        ('from_status', 'text', 'NO'),
        ('to_status', 'text', 'NO'),
        ('case_status_version', 'integer', 'NO'),
        ('payload_version', 'integer', 'NO'),
        ('delivery_status', 'text', 'NO'),
        ('attempt_count', 'integer', 'NO'),
        ('result_code', 'text', 'YES'),
        ('created_at', 'timestamp with time zone', 'NO'),
        ('claimed_at', 'timestamp with time zone', 'YES'),
        ('processed_at', 'timestamp with time zone', 'YES')
    ) as expected(column_name, data_type, is_nullable)
    left join information_schema.columns c
      on c.table_schema = 'public'
     and c.table_name = 'tenant_support_notification_outbox'
     and c.column_name = expected.column_name
    where c.column_name is null
       or c.data_type is distinct from expected.data_type
       or c.is_nullable is distinct from expected.is_nullable
  ) then
    raise exception 'MG-SUPPORT-003E.2A VERIFY FAIL: outbox column type or nullability mismatch';
  end if;

  select pg_get_constraintdef(oid)
    into v_def
    from pg_constraint
   where conrelid = 'public.tenant_support_notification_outbox'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%event_type%'
     and pg_get_constraintdef(oid) ilike '%case_in_review%'
   limit 1;
  if v_def is null
     or v_def !~* 'case_waiting_on_customer'
     or v_def !~* 'case_resolved'
     or v_def !~* 'case_reopened' then
    raise exception 'MG-SUPPORT-003E.2A VERIFY FAIL: outbox event_type CHECK missing or incomplete';
  end if;

  select pg_get_constraintdef(oid)
    into v_def
    from pg_constraint
   where conrelid = 'public.tenant_support_notification_outbox'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%delivery_status%'
     and pg_get_constraintdef(oid) ilike '%bridge_accepted%'
   limit 1;
  if v_def is null
     or v_def !~* 'pending'
     or v_def !~* 'claimed'
     or v_def !~* 'submission_unknown'
     or v_def !~* 'failed' then
    raise exception 'MG-SUPPORT-003E.2A VERIFY FAIL: outbox delivery_status CHECK missing or incomplete';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenant_support_notification_outbox'::regclass
      and contype = 'u'
      and conname = 'tenant_support_notification_outbox_case_version_event_key'
  ) then
    raise exception 'MG-SUPPORT-003E.2A VERIFY FAIL: unique (case_id, case_status_version, event_type) missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenant_support_notification_outbox'::regclass
      and contype = 'f'
      and pg_get_constraintdef(oid) ilike '%tenants%'
      and pg_get_constraintdef(oid) ilike '%on delete restrict%'
  ) then
    raise exception 'MG-SUPPORT-003E.2A VERIFY FAIL: tenant FK ON DELETE RESTRICT missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenant_support_notification_outbox'::regclass
      and contype = 'f'
      and pg_get_constraintdef(oid) ilike '%tenant_support_cases%'
      and pg_get_constraintdef(oid) ilike '%on delete restrict%'
  ) then
    raise exception 'MG-SUPPORT-003E.2A VERIFY FAIL: case FK ON DELETE RESTRICT missing';
  end if;

  -- 17–20. RLS / grants
  select relrowsecurity into v_ok
    from pg_class
   where oid = 'public.tenant_support_notification_outbox'::regclass;
  if v_ok is not true then
    raise exception 'MG-SUPPORT-003E.2A VERIFY FAIL: outbox RLS not enabled';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'tenant_support_notification_outbox'
      and grantee in ('anon', 'authenticated', 'public')
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'SELECT', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
  ) then
    raise exception 'MG-SUPPORT-003E.2A VERIFY FAIL: public/anon/authenticated have outbox privileges';
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'tenant_support_notification_outbox'
      and roles && array['anon', 'authenticated']::name[]
  ) then
    raise exception 'MG-SUPPORT-003E.2A VERIFY FAIL: client-facing outbox RLS policy present';
  end if;

  select count(*) into v_svc_priv
    from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name = 'tenant_support_notification_outbox'
     and grantee = 'service_role'
     and privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE');
  if v_svc_priv < 4 then
    raise exception 'MG-SUPPORT-003E.2A VERIFY FAIL: service_role access missing';
  end if;

  -- 21–22. no recipient/email body
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'tenant_support_notification_outbox'
      and column_name in (
        'owner_email', 'recipient_email', 'recipient', 'email', 'session_e',
        'customer_email', 'subject', 'email_body', 'html_body', 'prompt',
        'ai_response', 'diagnostic_payload', 'amount', 'balance_due',
        'internal_note', 'internal_notes'
      )
  ) then
    raise exception 'MG-SUPPORT-003E.2A VERIFY FAIL: forbidden email/PII/money/note column present';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'tenant_support_notification_outbox'
      and indexname = 'tenant_support_notification_outbox_tenant_created_idx'
  ) then
    raise exception 'MG-SUPPORT-003E.2A VERIFY FAIL: tenant/created outbox index missing';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'tenant_support_notification_outbox'
      and indexname = 'tenant_support_notification_outbox_delivery_created_idx'
  ) then
    raise exception 'MG-SUPPORT-003E.2A VERIFY FAIL: delivery/created outbox index missing';
  end if;

  -- 23. no outbox rows and no unexpected case mutation
  select count(*) into v_outbox from public.tenant_support_notification_outbox;
  if v_outbox <> 0 then
    raise exception 'MG-SUPPORT-003E.2A VERIFY FAIL: outbox is not empty (% rows)', v_outbox;
  end if;

  raise notice 'MG-SUPPORT-003E.2A VERIFY PASS: lifecycle CHECK, snapshot columns, empty outbox, RLS; open=% resolved=%',
    v_open, v_resolved;
end
$$;
