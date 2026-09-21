-- =============================================================================
-- Margin Guard | CH-012H verification — READ ONLY
-- =============================================================================
-- STATUS: SELECT only. Run after authorized apply. Do not INSERT/UPDATE/DELETE
-- /RPC. Do not use a real project. Do not Confirm.
-- =============================================================================

SELECT
  (
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'project_contract_setups'
        AND column_name = 'schedule_confirmed_at'
        AND data_type = 'timestamp with time zone'
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'project_contract_setups'
        AND column_name = 'schedule_confirmed_start_date'
        AND data_type = 'date'
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'project_contract_setups'
        AND column_name = 'schedule_confirmed_due_date'
        AND data_type = 'date'
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'project_contract_setups'
        AND column_name = 'schedule_confirmed_by'
        AND udt_name = 'uuid'
    )
  ) AS columns_ok,
  EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'project_contract_setups_schedule_confirmed_by_fkey'
  ) AS fk_ok,
  EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'project_contract_setups_schedule_confirm_consistency'
  ) AS consistency_check_ok,
  (
    position(
      'CH-012H-CONFIRM-BEGIN'
      in pg_get_functiondef(
        'public.confirm_project_estimated_schedule(uuid,uuid,uuid,uuid)'::regprocedure
      )
    ) > 0
    AND position(
      'quotes.start_date'
      in pg_get_functiondef(
        'public.confirm_project_estimated_schedule(uuid,uuid,uuid,uuid)'::regprocedure
      )
    ) > 0
    AND position(
      'p_start_date'
      in pg_get_functiondef(
        'public.confirm_project_estimated_schedule(uuid,uuid,uuid,uuid)'::regprocedure
      )
    ) = 0
  ) AS confirm_copies_quote_dates,
  (
    position(
      'CH-012H-INVALIDATE-BEGIN'
      in pg_get_functiondef(
        'public.apply_quote_schedule_date_change(uuid,uuid,date,date,boolean,boolean)'::regprocedure
      )
    ) > 0
    AND position(
      'schedule_confirmed_at = null'
      in pg_get_functiondef(
        'public.apply_quote_schedule_date_change(uuid,uuid,date,date,boolean,boolean)'::regprocedure
      )
    ) > 0
    AND position(
      'tenant_id = p_tenant_id'
      in pg_get_functiondef(
        'public.apply_quote_schedule_date_change(uuid,uuid,date,date,boolean,boolean)'::regprocedure
      )
    ) > 0
  ) AS invalidate_is_isolated,
  EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'quotes'
      AND t.tgname = 'trg_quotes_invalidate_estimated_schedule'
      AND t.tgenabled <> 'D'
  ) AS quote_date_trigger_ok,
  (
    EXISTS (
      SELECT 1
      FROM information_schema.routine_privileges rp
      WHERE rp.specific_schema = 'public'
        AND rp.routine_name = 'confirm_project_estimated_schedule'
        AND rp.privilege_type = 'EXECUTE'
        AND rp.grantee = 'service_role'
    )
    AND EXISTS (
      SELECT 1
      FROM information_schema.routine_privileges rp
      WHERE rp.specific_schema = 'public'
        AND rp.routine_name = 'apply_quote_schedule_date_change'
        AND rp.privilege_type = 'EXECUTE'
        AND rp.grantee = 'service_role'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM information_schema.routine_privileges rp
      WHERE rp.specific_schema = 'public'
        AND rp.routine_name IN (
          'confirm_project_estimated_schedule',
          'apply_quote_schedule_date_change',
          'invalidate_estimated_schedule_on_quote_date_change'
        )
        AND rp.privilege_type = 'EXECUTE'
        AND rp.grantee IN ('PUBLIC', 'anon', 'authenticated')
    )
  ) AS execute_grants_ok,
  (
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'project_contract_setups'
        AND column_name = 'schedule_confirmed_at'
        AND data_type = 'timestamp with time zone'
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'project_contract_setups'
        AND column_name = 'schedule_confirmed_start_date'
        AND data_type = 'date'
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'project_contract_setups'
        AND column_name = 'schedule_confirmed_due_date'
        AND data_type = 'date'
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'project_contract_setups'
        AND column_name = 'schedule_confirmed_by'
        AND udt_name = 'uuid'
    )
    AND EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'project_contract_setups_schedule_confirmed_by_fkey'
    )
    AND EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'project_contract_setups_schedule_confirm_consistency'
    )
    AND position(
      'CH-012H-CONFIRM-BEGIN'
      in pg_get_functiondef(
        'public.confirm_project_estimated_schedule(uuid,uuid,uuid,uuid)'::regprocedure
      )
    ) > 0
    AND position(
      'CH-012H-INVALIDATE-BEGIN'
      in pg_get_functiondef(
        'public.apply_quote_schedule_date_change(uuid,uuid,date,date,boolean,boolean)'::regprocedure
      )
    ) > 0
    AND position(
      'CH-012H-TRIGGER-BEGIN'
      in pg_get_functiondef(
        'public.invalidate_estimated_schedule_on_quote_date_change()'::regprocedure
      )
    ) > 0
    AND EXISTS (
      SELECT 1
      FROM information_schema.routine_privileges rp
      WHERE rp.specific_schema = 'public'
        AND rp.routine_name = 'confirm_project_estimated_schedule'
        AND rp.privilege_type = 'EXECUTE'
        AND rp.grantee = 'service_role'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM information_schema.routine_privileges rp
      WHERE rp.specific_schema = 'public'
        AND rp.routine_name IN (
          'confirm_project_estimated_schedule',
          'apply_quote_schedule_date_change',
          'invalidate_estimated_schedule_on_quote_date_change'
        )
        AND rp.privilege_type = 'EXECUTE'
        AND rp.grantee IN ('PUBLIC', 'anon', 'authenticated')
    )
    AND EXISTS (
      SELECT 1
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = 'quotes'
        AND t.tgname = 'trg_quotes_invalidate_estimated_schedule'
        AND t.tgenabled <> 'D'
    )
  ) AS ch012h_verify_pass;
