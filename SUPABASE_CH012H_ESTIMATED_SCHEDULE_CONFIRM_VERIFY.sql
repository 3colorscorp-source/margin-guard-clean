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
      AND pg_get_constraintdef(oid) ILIKE '%ON DELETE RESTRICT%'
  ) AS fk_restrict_ok,
  (
    EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'project_contract_setups_schedule_confirm_consistency'
    )
    AND EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'project_contract_setups_schedule_confirm_consistency'
        AND pg_get_constraintdef(oid) ILIKE '%schedule_confirmed_at is not null%'
        AND pg_get_constraintdef(oid) ILIKE '%schedule_confirmed_start_date is not null%'
        AND pg_get_constraintdef(oid) ILIKE '%schedule_confirmed_due_date is not null%'
        AND pg_get_constraintdef(oid) ILIKE '%schedule_confirmed_by is not null%'
    )
  ) AS consistency_all_or_none_ok,
  (
    position(
      'CH-012H-CONFIRM-BEGIN'
      in pg_get_functiondef(
        'public.confirm_project_estimated_schedule(uuid,uuid,uuid,uuid)'::regprocedure
      )
    ) > 0
    AND position(
      'v_start := v_quote.start_date'
      in pg_get_functiondef(
        'public.confirm_project_estimated_schedule(uuid,uuid,uuid,uuid)'::regprocedure
      )
    ) > 0
    AND position(
      'v_due := v_quote.due_date'
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
    AND position(
      'p_due_date'
      in pg_get_functiondef(
        'public.confirm_project_estimated_schedule(uuid,uuid,uuid,uuid)'::regprocedure
      )
    ) = 0
    AND position(
      'MG_ERR:schedule_completion_missing'
      in pg_get_functiondef(
        'public.confirm_project_estimated_schedule(uuid,uuid,uuid,uuid)'::regprocedure
      )
    ) > 0
  ) AS confirm_copies_quote_dates,
  (
    position(
      $q$p.id = p_confirmed_by$q$
      in pg_get_functiondef(
        'public.confirm_project_estimated_schedule(uuid,uuid,uuid,uuid)'::regprocedure
      )
    ) > 0
    AND position(
      $q$p.tenant_id = p_tenant_id$q$
      in pg_get_functiondef(
        'public.confirm_project_estimated_schedule(uuid,uuid,uuid,uuid)'::regprocedure
      )
    ) > 0
    AND position(
      $q$p.status = 'active'$q$
      in pg_get_functiondef(
        'public.confirm_project_estimated_schedule(uuid,uuid,uuid,uuid)'::regprocedure
      )
    ) > 0
    AND position(
      $q$p.role in ('owner', 'admin')$q$
      in pg_get_functiondef(
        'public.confirm_project_estimated_schedule(uuid,uuid,uuid,uuid)'::regprocedure
      )
    ) > 0
  ) AS confirm_validates_owner_admin,
  (
    EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = 'confirm_project_estimated_schedule'
        AND p.prosecdef IS TRUE
        AND array_to_string(coalesce(p.proconfig, array[]::text[]), ' ')
          LIKE '%search_path%pg_catalog%public%'
    )
    AND EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = 'invalidate_estimated_schedule_on_quote_date_change'
        AND p.prosecdef IS TRUE
        AND array_to_string(coalesce(p.proconfig, array[]::text[]), ' ')
          LIKE '%search_path%pg_catalog%public%'
    )
  ) AS security_definer_search_path_ok,
  (
    EXISTS (
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
        AND rp.routine_name = 'confirm_project_estimated_schedule'
        AND rp.privilege_type = 'EXECUTE'
        AND rp.grantee IN ('PUBLIC', 'anon', 'authenticated')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM information_schema.routine_privileges rp
      WHERE rp.specific_schema = 'public'
        AND rp.routine_name = 'confirm_project_estimated_schedule'
        AND rp.privilege_type = 'EXECUTE'
        AND rp.grantee NOT IN ('service_role', 'postgres')
    )
  ) AS confirm_execute_service_role_only,
  (
    NOT EXISTS (
      SELECT 1
      FROM information_schema.routine_privileges rp
      WHERE rp.specific_schema = 'public'
        AND rp.routine_name = 'invalidate_estimated_schedule_on_quote_date_change'
        AND rp.privilege_type = 'EXECUTE'
        AND rp.grantee IN ('PUBLIC', 'anon', 'authenticated')
    )
  ) AS trigger_fn_no_client_execute,
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
    NOT EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = 'apply_quote_schedule_date_change'
    )
  ) AS unused_rpc_absent,
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
        AND pg_get_constraintdef(oid) ILIKE '%ON DELETE RESTRICT%'
    )
    AND EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'project_contract_setups_schedule_confirm_consistency'
        AND pg_get_constraintdef(oid) ILIKE '%schedule_confirmed_at is not null%'
        AND pg_get_constraintdef(oid) ILIKE '%schedule_confirmed_start_date is not null%'
        AND pg_get_constraintdef(oid) ILIKE '%schedule_confirmed_due_date is not null%'
        AND pg_get_constraintdef(oid) ILIKE '%schedule_confirmed_by is not null%'
    )
    AND position(
      'CH-012H-CONFIRM-BEGIN'
      in pg_get_functiondef(
        'public.confirm_project_estimated_schedule(uuid,uuid,uuid,uuid)'::regprocedure
      )
    ) > 0
    AND position(
      'MG_ERR:schedule_completion_missing'
      in pg_get_functiondef(
        'public.confirm_project_estimated_schedule(uuid,uuid,uuid,uuid)'::regprocedure
      )
    ) > 0
    AND position(
      $q$p.id = p_confirmed_by$q$
      in pg_get_functiondef(
        'public.confirm_project_estimated_schedule(uuid,uuid,uuid,uuid)'::regprocedure
      )
    ) > 0
    AND position(
      $q$p.tenant_id = p_tenant_id$q$
      in pg_get_functiondef(
        'public.confirm_project_estimated_schedule(uuid,uuid,uuid,uuid)'::regprocedure
      )
    ) > 0
    AND position(
      $q$p.status = 'active'$q$
      in pg_get_functiondef(
        'public.confirm_project_estimated_schedule(uuid,uuid,uuid,uuid)'::regprocedure
      )
    ) > 0
    AND position(
      $q$p.role in ('owner', 'admin')$q$
      in pg_get_functiondef(
        'public.confirm_project_estimated_schedule(uuid,uuid,uuid,uuid)'::regprocedure
      )
    ) > 0
    AND EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = 'confirm_project_estimated_schedule'
        AND p.prosecdef IS TRUE
        AND array_to_string(coalesce(p.proconfig, array[]::text[]), ' ')
          LIKE '%search_path%pg_catalog%public%'
    )
    AND EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = 'invalidate_estimated_schedule_on_quote_date_change'
        AND p.prosecdef IS TRUE
        AND array_to_string(coalesce(p.proconfig, array[]::text[]), ' ')
          LIKE '%search_path%pg_catalog%public%'
    )
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
        AND rp.routine_name = 'confirm_project_estimated_schedule'
        AND rp.privilege_type = 'EXECUTE'
        AND rp.grantee IN ('PUBLIC', 'anon', 'authenticated')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM information_schema.routine_privileges rp
      WHERE rp.specific_schema = 'public'
        AND rp.routine_name = 'confirm_project_estimated_schedule'
        AND rp.privilege_type = 'EXECUTE'
        AND rp.grantee NOT IN ('service_role', 'postgres')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM information_schema.routine_privileges rp
      WHERE rp.specific_schema = 'public'
        AND rp.routine_name = 'invalidate_estimated_schedule_on_quote_date_change'
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
    AND NOT EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = 'apply_quote_schedule_date_change'
    )
  ) AS ch012h_verify_pass;
