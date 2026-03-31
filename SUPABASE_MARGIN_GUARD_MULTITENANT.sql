create extension if not exists pgcrypto;

create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  stripe_customer_id text unique,
  owner_email text default '',
  plan_status text default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  email text not null,
  role text not null default 'owner',
  full_name text default '',
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, email)
);

create table if not exists public.tenant_snapshots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  snapshot_version integer not null default 1,
  source text not null default 'margin-guard-web',
  payload jsonb not null default '{}'::jsonb,
  created_by_email text default '',
  created_at timestamptz not null default now()
);

create index if not exists tenants_slug_idx on public.tenants(slug);
create index if not exists tenants_customer_idx on public.tenants(stripe_customer_id);
create index if not exists profiles_tenant_email_idx on public.profiles(tenant_id, email);
create index if not exists tenant_snapshots_tenant_created_idx on public.tenant_snapshots(tenant_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_tenants_updated_at on public.tenants;
create trigger trg_tenants_updated_at
before update on public.tenants
for each row
execute function public.set_updated_at();

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at
before update on public.profiles
for each row
execute function public.set_updated_at();

alter table public.tenants enable row level security;
alter table public.profiles enable row level security;
alter table public.tenant_snapshots enable row level security;

drop policy if exists "service role full access tenants" on public.tenants;
create policy "service role full access tenants"
on public.tenants
for all
to service_role
using (true)
with check (true);

drop policy if exists "service role full access profiles" on public.profiles;
create policy "service role full access profiles"
on public.profiles
for all
to service_role
using (true)
with check (true);

drop policy if exists "service role full access snapshots" on public.tenant_snapshots;
create policy "service role full access snapshots"
on public.tenant_snapshots
for all
to service_role
using (true)
with check (true);
