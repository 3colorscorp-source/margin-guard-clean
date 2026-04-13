-- Branding por tenant (Stripe customer -> tenants.id). Usado por PDFs y get-tenant-branding.
-- Ejecutar en Supabase SQL editor despues de SUPABASE_MARGIN_GUARD_MULTITENANT.sql

create table if not exists public.tenant_branding (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  business_name text not null default '',
  logo_url text not null default '',
  business_email text not null default '',
  business_phone text not null default '',
  business_address text not null default '',
  updated_at timestamptz not null default now()
);

create index if not exists tenant_branding_updated_idx on public.tenant_branding(updated_at desc);

drop trigger if exists trg_tenant_branding_updated_at on public.tenant_branding;
create trigger trg_tenant_branding_updated_at
before update on public.tenant_branding
for each row
execute function public.set_updated_at();

alter table public.tenant_branding enable row level security;

drop policy if exists "service role full access tenant_branding" on public.tenant_branding;
create policy "service role full access tenant_branding"
on public.tenant_branding
for all
to service_role
using (true)
with check (true);
