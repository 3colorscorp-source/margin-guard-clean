-- =============================================================================
-- READ ONLY verify | mg_accept_quote_reserving_schedule JS occupancy parity
-- =============================================================================
-- STATUS: DO NOT RUN WRITES. SELECT/CTE only.
-- Do not INSERT/UPDATE/DELETE/RPC/CREATE/ALTER.
-- Do not Approve estimates. Do not use public tokens.
-- Safe before or after authorized apply.
-- =============================================================================

WITH def AS (
  SELECT pg_get_functiondef(
    'public.mg_accept_quote_reserving_schedule(uuid, uuid, date, date, timestamptz, jsonb)'::regprocedure
  ) AS src
),
privs AS (
  SELECT
    coalesce(
      array_agg(rp.grantee::text order by rp.grantee::text)
        filter (where rp.privilege_type = 'EXECUTE'),
      array[]::text[]
    ) AS execute_grantees
  FROM information_schema.routine_privileges rp
  WHERE rp.specific_schema = 'public'
    AND rp.routine_name = 'mg_accept_quote_reserving_schedule'
)
SELECT
  'function_surface'::text AS check_kind,
  to_regclass('public.tenant_projects') IS NOT NULL AS has_tenant_projects,
  to_regclass('public.quotes') IS NOT NULL AS has_quotes,
  to_regclass('public.tenant_project_operational_snapshots') IS NOT NULL AS has_snapshots,
  to_regclass('public.tenant_project_day_progress') IS NOT NULL AS has_day_progress,
  to_regclass('public.tenant_project_reports') IS NOT NULL AS has_reports,
  to_regclass('public.tenant_project_migration_baselines') IS NOT NULL AS has_migration_baselines,
  def.src ~ 'pg_advisory_xact_lock' AS has_advisory_lock,
  def.src ~ 'commitment_date' AS uses_commitment_date,
  def.src ~ 'tenant_project_day_progress' AS uses_day_progress,
  def.src ~ 'tenant_project_reports' AS uses_reports,
  def.src ~ 'completed_days >= o.estimated_days' AS has_complete_execution_release,
  def.src ~ 'delayed_count = 0' AND def.src ~ 'completed_count = 0' AS has_incomplete_reporting_release,
  def.src ~ 'tenant_project_migration_baselines' AS mentions_migration_baselines,
  privs.execute_grantees
FROM def
CROSS JOIN privs;

-- Occupancy simulation (new predicate). No names, emails, or tokens.
WITH target_quote AS (
  SELECT q.id AS quote_id, q.tenant_id
  FROM public.quotes q
  WHERE q.quote_number_display = '2026-0161'
),
params AS (
  SELECT
    (timezone('utc', now()))::date AS today_utc,
    DATE '2026-09-30' AS occupy_day
),
day_progress_agg AS (
  SELECT
    dp.tenant_id,
    dp.project_id,
    count(*) FILTER (WHERE lower(dp.status) = 'completed') AS completed_count,
    count(*) FILTER (WHERE lower(dp.status) = 'delayed') AS delayed_count,
    count(*) AS progress_row_count
  FROM public.tenant_project_day_progress dp
  JOIN target_quote tq
    ON tq.tenant_id = dp.tenant_id
  GROUP BY dp.tenant_id, dp.project_id
),
report_agg AS (
  SELECT
    r.tenant_id,
    r.project_id,
    coalesce(sum(r.days), 0) AS report_days
  FROM public.tenant_project_reports r
  JOIN target_quote tq
    ON tq.tenant_id = r.tenant_id
  GROUP BY r.tenant_id, r.project_id
),
projects AS (
  SELECT
    tp.id AS project_id,
    tp.status,
    (tp.signed_at AT TIME ZONE 'utc')::date AS signed_date,
    tp.due_date,
    coalesce(snap.commitment_date, tp.due_date) AS finish_date,
    coalesce(
      nullif(snap.estimated_days, 0),
      nullif(tp.estimated_days, 0),
      0
    ) AS estimated_days,
    case
      when coalesce(dpa.progress_row_count, 0) > 0
        then coalesce(dpa.completed_count, 0)
      else coalesce(ra.report_days, 0)
    end AS completed_days,
    coalesce(dpa.completed_count, 0) AS completed_count,
    coalesce(dpa.delayed_count, 0) AS delayed_count,
    (
      (
        coalesce(nullif(snap.estimated_days, 0), nullif(tp.estimated_days, 0), 0) > 0
        AND (
          CASE
            WHEN coalesce(dpa.progress_row_count, 0) > 0
              THEN coalesce(dpa.completed_count, 0)
            ELSE coalesce(ra.report_days, 0)
          END
        ) >= coalesce(nullif(snap.estimated_days, 0), nullif(tp.estimated_days, 0), 0)
      )
      OR (
        coalesce(snap.commitment_date, tp.due_date) < p.today_utc
        AND coalesce(dpa.delayed_count, 0) = 0
        AND coalesce(dpa.completed_count, 0) = 0
      )
    ) AS released,
    coalesce(
      (tp.signed_at AT TIME ZONE 'utc')::date,
      coalesce(snap.commitment_date, tp.due_date)
    ) AS occupy_start,
    coalesce(
      coalesce(snap.commitment_date, tp.due_date),
      (tp.signed_at AT TIME ZONE 'utc')::date
    ) AS occupy_end,
    p.occupy_day
  FROM public.tenant_projects tp
  JOIN target_quote tq
    ON tq.tenant_id = tp.tenant_id
  CROSS JOIN params p
  LEFT JOIN public.tenant_project_operational_snapshots snap
    ON snap.tenant_id = tp.tenant_id
   AND snap.project_id = tp.id
  LEFT JOIN day_progress_agg dpa
    ON dpa.tenant_id = tp.tenant_id
   AND dpa.project_id = tp.id
  LEFT JOIN report_agg ra
    ON ra.tenant_id = tp.tenant_id
   AND ra.project_id = tp.id
  WHERE tp.status IN ('signed', 'deposit_paid', 'assigned', 'in_progress')
    AND tp.quote_id IS DISTINCT FROM tq.quote_id
),
scored AS (
  SELECT
    pr.*,
    (
      NOT pr.released
      AND pr.occupy_start IS NOT NULL
      AND pr.occupy_end IS NOT NULL
      AND pr.occupy_end >= pr.occupy_start
      AND daterange(pr.occupy_start, pr.occupy_end, '[]')
        && daterange(pr.occupy_day, pr.occupy_day, '[]')
    ) AS overlaps_2026_09_30_under_rpc
  FROM projects pr
),
stats AS (
  SELECT
    count(*)::int AS active_count,
    count(*) FILTER (WHERE overlaps_2026_09_30_under_rpc)::int AS rpc_conflict_count,
    count(*) FILTER (
      WHERE released AND overlaps_2026_09_30_under_rpc
    )::int AS js_released_but_rpc_blocks_count
  FROM scored
)
SELECT
  sc.project_id,
  sc.status,
  sc.signed_date,
  sc.due_date,
  sc.finish_date AS commitment_date,
  sc.released AS released_by_js,
  sc.overlaps_2026_09_30_under_rpc,
  NULL::int AS active_count,
  NULL::int AS rpc_conflict_count,
  NULL::int AS js_released_but_rpc_blocks_count
FROM scored sc
UNION ALL
SELECT
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  st.active_count,
  st.rpc_conflict_count,
  st.js_released_but_rpc_blocks_count
FROM stats st
ORDER BY project_id NULLS LAST;
