-- Soft-hide projects from Project Control Center (does not delete rows or affect invoices/payments).

alter table public.tenant_projects
  add column if not exists hidden_from_project_control boolean not null default false,
  add column if not exists project_control_archived_at timestamptz null;

create index if not exists tenant_projects_pcc_visible_idx
  on public.tenant_projects (tenant_id, status)
  where hidden_from_project_control = false;

comment on column public.tenant_projects.hidden_from_project_control is
  'When true, project is hidden from Project Control lists only; production history, invoices, and payments remain intact.';

comment on column public.tenant_projects.project_control_archived_at is
  'Timestamp when owner removed project from Project Control (soft archive).';
