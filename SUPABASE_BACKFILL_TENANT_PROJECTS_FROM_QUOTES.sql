-- Backfill public.tenant_projects from public.quotes for signed / accepted work
-- that never received a row (e.g. signed before Sales "Firmar" wired upsert-tenant-project,
-- or public "accepted" path which does not call upsert-tenant-project today).
--
-- Preconditions:
--   * public.tenant_projects and public.quotes exist with FK quote_id -> quotes(id).
--   * Run in Supabase SQL editor (or psql) after reviewing the WHERE clause for your data.
--
-- Idempotent: only inserts when no tenant_projects row exists for the same quote_id
-- (unique index tenant_projects_tenant_quote_uidx recommended).

begin;

insert into public.tenant_projects (
  tenant_id,
  quote_id,
  project_name,
  client_name,
  client_email,
  status,
  signed_at,
  deposit_paid,
  estimated_days,
  labor_budget,
  sale_price,
  recommended_price,
  minimum_price,
  due_date,
  notes,
  created_at,
  updated_at
)
select
  q.tenant_id,
  q.id as quote_id,
  coalesce(nullif(trim(q.project_name), ''), nullif(trim(q.title), ''), 'Project') as project_name,
  coalesce(nullif(trim(q.client_name), ''), '') as client_name,
  coalesce(nullif(trim(q.client_email), ''), '') as client_email,
  case
    when lower(trim(coalesce(q.status, ''))) in ('completed') then 'completed'
    when lower(trim(coalesce(q.status, ''))) in ('cancelled', 'declined') then 'cancelled'
    when lower(trim(coalesce(q.status, ''))) in ('deposit_paid', 'assigned', 'in_progress') then lower(trim(q.status))
    when lower(trim(coalesce(q.status, ''))) in ('accepted', 'sold', 'signed') then 'signed'
    when q.accepted_at is not null then 'signed'
    else 'signed'
  end::text as status,
  coalesce(q.accepted_at, q.updated_at, q.created_at, now()) as signed_at,
  false as deposit_paid,
  0::numeric as estimated_days,
  0::numeric as labor_budget,
  coalesce(q.total, 0)::numeric as sale_price,
  coalesce(q.total, 0)::numeric as recommended_price,
  coalesce(q.total, 0)::numeric as minimum_price,
  null::date as due_date,
  coalesce(q.notes, '') as notes,
  now() as created_at,
  now() as updated_at
from public.quotes q
where q.tenant_id is not null
  and q.id is not null
  and not exists (
    select 1
    from public.tenant_projects tp
    where tp.quote_id = q.id
  )
  and lower(trim(coalesce(q.status, ''))) <> 'declined'
  and (
    q.accepted_at is not null
    or lower(trim(coalesce(q.status, ''))) in (
      'accepted',
      'sold',
      'signed',
      'deposit_paid',
      'assigned',
      'in_progress',
      'completed'
    )
  );

-- Preview (optional): run as SELECT instead of INSERT to review rows first.
-- Example:
-- select q.id, q.tenant_id, q.status, q.accepted_at, q.total
-- from public.quotes q
-- where ... same filters as above ...

commit;
