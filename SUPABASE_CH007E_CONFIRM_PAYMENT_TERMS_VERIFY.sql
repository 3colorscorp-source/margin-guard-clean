-- =============================================================================
-- Margin Guard | CH-007E verification — READ ONLY
-- =============================================================================
-- STATUS: SELECT only. Run after authorized apply. Do not INSERT/UPDATE/DELETE
-- /RPC. Do not use a real project. Do not Confirm.
-- Confirm slice is extracted with position() of the BEGIN/END markers.
-- =============================================================================

SELECT
  (
    count(*) OVER () = 1
    AND oidvectortypes(p.proargtypes)
      = 'uuid, uuid, uuid, numeric, text, boolean, jsonb, timestamp with time zone'
    AND pg_get_userbyid(p.proowner) = 'postgres'
  ) AS signature_ok,
  (
    position('CH-007E' in slice.src) > 0
    AND position('CH-007E-CONFIRM-BEGIN' in slice.src) > 0
    AND position('CH-007E-CONFIRM-END' in slice.src)
      > position('CH-007E-CONFIRM-BEGIN' in slice.src)
  ) AS marker_ok,
  (
    slice.confirm_slice IS NOT NULL
    AND position('p_items' in slice.confirm_slice) = 0
    AND position('jsonb_array_elements' in slice.confirm_slice) = 0
    AND position('MG_ERR:invalid_items' in slice.confirm_slice) = 0
    AND position('items_required' in slice.confirm_slice) = 0
    AND position(
          'delete from public.project_contract_payment_schedule_items'
          in slice.confirm_slice
        ) = 0
    AND position(
          'insert into public.project_contract_payment_schedule_items'
          in slice.confirm_slice
        ) = 0
    AND position('CH-007E-CONFIRM-BEGIN' in slice.src)
      < position(
          'delete from public.project_contract_payment_schedule_items' in slice.src
        )
  ) AS confirm_no_item_mutation,
  (
    slice.confirm_slice IS NOT NULL
    AND position('items_required' in slice.confirm_slice) = 0
    AND position('schedule_total_mismatch' in slice.confirm_slice) = 0
  ) AS confirm_no_sum_gate,
  (
    position('MG_ERR:invalid_items' in slice.confirm_slice) = 0
    AND position('MG_ERR:invalid_items' in slice.after_confirm) > 0
    AND position('CH-007D-INFRA-001: missing/blank item_role' in slice.after_confirm) > 0
    AND position(
          'delete from public.project_contract_payment_schedule_items'
          in slice.after_confirm
        ) > 0
    AND position(
          'insert into public.project_contract_payment_schedule_items'
          in slice.after_confirm
        ) > 0
    AND position('jsonb_array_elements' in slice.after_confirm) > 0
    AND position('MG_ERR:items_required' in slice.after_confirm) > 0
    AND position('MG_ERR:schedule_total_mismatch' in slice.after_confirm) > 0
  ) AS draft_keeps_ch007d,
  (p.prosecdef IS TRUE) AS security_definer_ok,
  (
    array_to_string(coalesce(p.proconfig, array[]::text[]), ' ')
    LIKE '%search_path%pg_catalog%public%'
  ) AS search_path_ok,
  (
    EXISTS (
      SELECT 1
      FROM information_schema.routine_privileges rp
      WHERE rp.specific_schema = 'public'
        AND rp.routine_name = 'replace_project_contract_payment_schedule'
        AND rp.privilege_type = 'EXECUTE'
        AND rp.grantee = 'service_role'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM information_schema.routine_privileges rp
      WHERE rp.specific_schema = 'public'
        AND rp.routine_name = 'replace_project_contract_payment_schedule'
        AND rp.privilege_type = 'EXECUTE'
        AND rp.grantee IN ('PUBLIC', 'anon', 'authenticated')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM information_schema.routine_privileges rp
      WHERE rp.specific_schema = 'public'
        AND rp.routine_name = 'replace_project_contract_payment_schedule'
        AND rp.privilege_type = 'EXECUTE'
        AND rp.grantee NOT IN ('service_role', 'postgres')
    )
  ) AS execute_grants_ok,
  (
    count(*) OVER () = 1
    AND oidvectortypes(p.proargtypes)
      = 'uuid, uuid, uuid, numeric, text, boolean, jsonb, timestamp with time zone'
    AND position('CH-007E' in slice.src) > 0
    AND position('CH-007E-CONFIRM-BEGIN' in slice.src) > 0
    AND position('CH-007E-CONFIRM-END' in slice.src)
      > position('CH-007E-CONFIRM-BEGIN' in slice.src)
    AND slice.confirm_slice IS NOT NULL
    AND position('p_items' in slice.confirm_slice) = 0
    AND position('jsonb_array_elements' in slice.confirm_slice) = 0
    AND position('MG_ERR:invalid_items' in slice.confirm_slice) = 0
    AND position('items_required' in slice.confirm_slice) = 0
    AND position('schedule_total_mismatch' in slice.confirm_slice) = 0
    AND position(
          'delete from public.project_contract_payment_schedule_items'
          in slice.confirm_slice
        ) = 0
    AND position(
          'insert into public.project_contract_payment_schedule_items'
          in slice.confirm_slice
        ) = 0
    AND position('CH-007E-CONFIRM-BEGIN' in slice.src)
      < position(
          'delete from public.project_contract_payment_schedule_items' in slice.src
        )
    AND position('MG_ERR:invalid_items' in slice.after_confirm) > 0
    AND position('CH-007D-INFRA-001: missing/blank item_role' in slice.after_confirm) > 0
    AND position(
          'delete from public.project_contract_payment_schedule_items'
          in slice.after_confirm
        ) > 0
    AND position(
          'insert into public.project_contract_payment_schedule_items'
          in slice.after_confirm
        ) > 0
    AND position('jsonb_array_elements' in slice.after_confirm) > 0
    AND p.prosecdef IS TRUE
    AND pg_get_userbyid(p.proowner) = 'postgres'
    AND array_to_string(coalesce(p.proconfig, array[]::text[]), ' ')
      LIKE '%search_path%pg_catalog%public%'
    AND EXISTS (
      SELECT 1
      FROM information_schema.routine_privileges rp
      WHERE rp.specific_schema = 'public'
        AND rp.routine_name = 'replace_project_contract_payment_schedule'
        AND rp.privilege_type = 'EXECUTE'
        AND rp.grantee = 'service_role'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM information_schema.routine_privileges rp
      WHERE rp.specific_schema = 'public'
        AND rp.routine_name = 'replace_project_contract_payment_schedule'
        AND rp.privilege_type = 'EXECUTE'
        AND rp.grantee IN ('PUBLIC', 'anon', 'authenticated')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM information_schema.routine_privileges rp
      WHERE rp.specific_schema = 'public'
        AND rp.routine_name = 'replace_project_contract_payment_schedule'
        AND rp.privilege_type = 'EXECUTE'
        AND rp.grantee NOT IN ('service_role', 'postgres')
    )
  ) AS ch007e_verify_pass
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN LATERAL (
  SELECT pg_get_functiondef(p.oid) AS src
) AS raw
CROSS JOIN LATERAL (
  SELECT
    raw.src,
    CASE
      WHEN position('CH-007E-CONFIRM-BEGIN' in raw.src) > 0
       AND position('CH-007E-CONFIRM-END' in raw.src)
           > position('CH-007E-CONFIRM-BEGIN' in raw.src)
      THEN substring(
        raw.src
        from position('CH-007E-CONFIRM-BEGIN' in raw.src)
        for (
          position('CH-007E-CONFIRM-END' in raw.src)
          + char_length('CH-007E-CONFIRM-END')
          - position('CH-007E-CONFIRM-BEGIN' in raw.src)
        )
      )
      ELSE NULL
    END AS confirm_slice,
    CASE
      WHEN position('CH-007E-CONFIRM-END' in raw.src) > 0
      THEN substring(
        raw.src
        from position('CH-007E-CONFIRM-END' in raw.src)
      )
      ELSE ''
    END AS after_confirm
) AS slice
WHERE n.nspname = 'public'
  AND p.proname = 'replace_project_contract_payment_schedule';
