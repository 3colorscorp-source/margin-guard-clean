-- READ ONLY. Do not apply schema changes from this file.
-- Production inspect for public.mg_confirm_quote_operational_plan.
-- Paste into the Supabase SQL editor and run. No INSERT/UPDATE/DELETE/RPC calls.

-- 1) Overloads, identity args, and default expressions
select
  p.oid,
  n.nspname as schema_name,
  p.proname as function_name,
  p.pronargs,
  p.pronargdefaults,
  pg_get_function_identity_arguments(p.oid) as identity_args,
  pg_get_function_arguments(p.oid) as args_with_defaults,
  pg_get_expr(p.proargdefaults, 0) as proargdefaults_expr,
  p.proargnames,
  p.prosecdef as security_definer,
  p.prokind
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'mg_confirm_quote_operational_plan'
order by p.oid;

-- 2) Argument-by-argument names, types, and defaults
select
  p.oid,
  args.ordinality as position,
  args.name as argument_name,
  pg_catalog.format_type(args.typ, null) as argument_type,
  pg_catalog.pg_get_function_arg_default(p.oid, args.ordinality::int) as default_expr
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join lateral unnest(p.proargnames, p.proargtypes)
  with ordinality as args(name, typ, ordinality)
where n.nspname = 'public'
  and p.proname = 'mg_confirm_quote_operational_plan'
order by p.oid, args.ordinality;

-- 3) Dedicated table present?
select
  to_regclass('public.quote_internal_operational_plans') as table_regclass,
  (
    select c.relrowsecurity
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'quote_internal_operational_plans'
  ) as rls_enabled;

-- 4) Execute grants on every overload
select
  p.oid,
  pg_get_function_identity_arguments(p.oid) as identity_args,
  r.rolname as grantee,
  has_function_privilege(r.oid, p.oid, 'EXECUTE') as can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join pg_roles r
where n.nspname = 'public'
  and p.proname = 'mg_confirm_quote_operational_plan'
  and r.rolname in ('anon', 'authenticated', 'service_role', 'postgres')
order by p.oid, r.rolname;
