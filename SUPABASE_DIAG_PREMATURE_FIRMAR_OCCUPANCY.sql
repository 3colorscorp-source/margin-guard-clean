-- =============================================================================
-- READ ONLY diagnostic — premature Firmar occupancy
-- =============================================================================
-- STATUS: DO NOT RUN WRITES. Do not UPDATE/DELETE. Do not apply remediations
-- until an explicit SQL snippet is authorized for a confirmed row.
--
-- Goal: find active tenant_projects that occupy the crew calendar and look like
-- they were created by Sales "Firmar" before public client acceptance.
--
-- Calendar occupancy statuses (do not change): signed, deposit_paid, assigned,
-- in_progress.
--
-- Premature signals (any one is a candidate, not proof):
--   * operational snapshot source = 'mark_sold'
--   * quote status is not accepted/approved
--   * quote.accepted_at is null
-- Public-accept evidence:
--   * snapshot source = 'quote_accept'
--   * quote.status in ('accepted','approved') AND accepted_at set
--     AND snapshot source is quote_accept (strongest)
-- =============================================================================

select
  tp.id as tenant_project_id,
  tp.tenant_id,
  tp.project_name,
  tp.client_name,
  tp.quote_id,
  q.status as quote_status,
  q.accepted_at as quote_accepted_at,
  tp.status as project_status,
  (tp.signed_at at time zone 'utc')::date as start_date,
  tp.due_date,
  tp.signed_at,
  tp.created_at as project_created_at,
  snap.source as snapshot_source,
  snap.commitment_date as snapshot_commitment_date,
  snap.locked_at as snapshot_locked_at,
  (select count(*) from public.tenant_project_reports r where r.project_id = tp.id) as report_count,
  (select count(*) from public.tenant_project_migration_baselines b where b.project_id = tp.id) as baseline_count,
  case
    when snap.source = 'quote_accept'
      and lower(coalesce(q.status, '')) in ('accepted', 'approved')
      and q.accepted_at is not null
      then 'likely_public_accept'
    when snap.source = 'mark_sold'
      then 'likely_premature_firmar'
    when lower(coalesce(q.status, '')) not in ('accepted', 'approved')
      then 'active_project_quote_not_accepted'
    when q.accepted_at is null
      then 'active_project_missing_accepted_at'
    else 'needs_manual_review'
  end as classification
from public.tenant_projects tp
left join public.quotes q
  on q.id = tp.quote_id
 and q.tenant_id = tp.tenant_id
left join public.tenant_project_operational_snapshots snap
  on snap.project_id = tp.id
 and snap.tenant_id = tp.tenant_id
where tp.status in ('signed', 'deposit_paid', 'assigned', 'in_progress')
order by tp.created_at desc;

-- Proposed remediation for a CONFIRMED premature row (DO NOT RUN until authorized):
-- Preserve history by moving occupancy off the calendar without deleting the row.
-- Replace :project_id and :tenant_id.
--
-- update public.tenant_projects
-- set status = 'cancelled',
--     notes = trim(both from coalesce(notes, '') || ' | occupancy released: premature Firmar before public accept'),
--     updated_at = timezone('utc', now())
-- where id = :project_id
--   and tenant_id = :tenant_id
--   and status = 'signed';
--
-- Do not change quote.status / accepted_at / snapshots / reports in the same step
-- unless a separate authorized plan says so.
