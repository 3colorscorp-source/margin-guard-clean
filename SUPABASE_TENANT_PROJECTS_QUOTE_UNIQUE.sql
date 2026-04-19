-- Enables upsert on (tenant_id, quote_id) for tenant_projects via PostgREST on_conflict.
-- Run after public.tenant_projects exists.

create unique index if not exists tenant_projects_tenant_quote_uidx
  on public.tenant_projects (tenant_id, quote_id)
  where quote_id is not null;
