-- READ ONLY. Do not apply schema changes from this file.
-- Production inspect for public.mg_confirm_quote_operational_plan
-- and public.quote_internal_operational_plans.
-- Paste into the Supabase SQL editor. Catalog SELECTs only.
-- Capture this output before any production align script is written.

-- 1) Overloads: identity, defaults, security, owner, ACL, full body
select
  p.oid,
  n.nspname as schema_name,
  p.proname as function_name,
  pg_get_userbyid(p.proowner) as function_owner,
  p.pronargs,
  p.pronargdefaults,
  pg_get_function_identity_arguments(p.oid) as identity_args,
  pg_get_function_arguments(p.oid) as args_with_defaults,
  pg_get_expr(p.proargdefaults, 0) as proargdefaults_expr,
  p.proargnames,
  p.proargtypes::oid[] as proargtypes_oids,
  p.proargmodes,
  case when p.prosecdef then 'SECURITY DEFINER' else 'SECURITY INVOKER' end as security_model,
  p.prosecdef as is_security_definer,
  p.provolatile,
  p.prokind,
  p.proconfig,
  p.proacl,
  pg_get_functiondef(p.oid) as function_def
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'mg_confirm_quote_operational_plan'
order by p.oid;

-- 2) Argument names/types from proargtypes::oid[], plus which trailing args have defaults
select
  p.oid,
  t.ord as position,
  p.proargnames[t.ord] as argument_name,
  format_type(t.typoid, null) as argument_type,
  (t.ord > (p.pronargs - p.pronargdefaults)) as has_default
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join lateral unnest(p.proargtypes::oid[]) with ordinality as t(typoid, ord)
where n.nspname = 'public'
  and p.proname = 'mg_confirm_quote_operational_plan'
order by p.oid, t.ord;

-- 3) Function ACL exploded (NULL grantee is PUBLIC)
select
  p.oid,
  pg_get_function_identity_arguments(p.oid) as identity_args,
  acl.grantor,
  pg_get_userbyid(acl.grantor) as grantor_name,
  acl.grantee,
  case
    when acl.grantee = 0 then 'PUBLIC'
    else pg_get_userbyid(acl.grantee)
  end as grantee_name,
  acl.privilege_type,
  acl.is_grantable
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as acl
where n.nspname = 'public'
  and p.proname = 'mg_confirm_quote_operational_plan'
order by p.oid, grantee_name, acl.privilege_type;

-- 4) What each overload depends on
select
  p.oid as function_oid,
  pg_get_function_identity_arguments(p.oid) as identity_args,
  pg_describe_object(d.classid, d.objid, d.objsubid) as dependent_object,
  pg_describe_object(d.refclassid, d.refobjid, d.refobjsubid) as referenced_object,
  d.deptype
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join pg_depend d
  on d.classid = 'pg_proc'::regclass
 and d.objid = p.oid
where n.nspname = 'public'
  and p.proname = 'mg_confirm_quote_operational_plan'
order by p.oid, d.deptype, referenced_object;

-- 5) What depends on each overload
select
  p.oid as function_oid,
  pg_get_function_identity_arguments(p.oid) as identity_args,
  pg_describe_object(d.classid, d.objid, d.objsubid) as dependent_object,
  pg_describe_object(d.refclassid, d.refobjid, d.refobjsubid) as referenced_object,
  d.deptype
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join pg_depend d
  on d.refclassid = 'pg_proc'::regclass
 and d.refobjid = p.oid
where n.nspname = 'public'
  and p.proname = 'mg_confirm_quote_operational_plan'
  and d.deptype <> 'i'
order by p.oid, d.deptype, dependent_object;

-- 6) Table presence, owner, RLS, FORCE RLS, ACL
select
  n.nspname as schema_name,
  c.relname as table_name,
  c.oid as table_oid,
  pg_get_userbyid(c.relowner) as table_owner,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as rls_forced,
  c.relkind,
  c.relacl,
  to_regclass('public.quote_internal_operational_plans') as table_regclass
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'quote_internal_operational_plans'
  and c.relkind = 'r';

-- 7) Columns, types, nullability, defaults
select
  a.attnum as position,
  a.attname as column_name,
  format_type(a.atttypid, a.atttypmod) as column_type,
  not a.attnotnull as is_nullable,
  pg_get_expr(ad.adbin, ad.adrelid) as column_default,
  a.attidentity,
  a.attgenerated
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
join pg_attribute a on a.attrelid = c.oid
left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
where n.nspname = 'public'
  and c.relname = 'quote_internal_operational_plans'
  and c.relkind = 'r'
  and a.attnum > 0
  and not a.attisdropped
order by a.attnum;

-- 8) Constraints
select
  con.conname as constraint_name,
  con.contype as constraint_type,
  pg_get_constraintdef(con.oid) as constraint_def
from pg_constraint con
join pg_class c on c.oid = con.conrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'quote_internal_operational_plans'
order by con.contype, con.conname;

-- 9) Indexes
select
  ic.relname as index_name,
  idx.indisunique as is_unique,
  idx.indisprimary as is_primary,
  pg_get_indexdef(idx.indexrelid) as index_def
from pg_index idx
join pg_class c on c.oid = idx.indrelid
join pg_class ic on ic.oid = idx.indexrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'quote_internal_operational_plans'
order by ic.relname;

-- 10) Policies
select
  pol.polname as policy_name,
  pol.polcmd as command,
  pol.polpermissive as permissive,
  (
    select coalesce(
      array_agg(
        case
          when u.oid = 0 then 'PUBLIC'::name
          else r.rolname
        end
        order by
          case
            when u.oid = 0 then 'PUBLIC'::name
            else r.rolname
          end
      ),
      array[]::name[]
    )
    from unnest(pol.polroles) as u(oid)
    left join pg_roles r on r.oid = u.oid
  ) as roles,
  pg_get_expr(pol.polqual, pol.polrelid) as using_expr,
  pg_get_expr(pol.polwithcheck, pol.polrelid) as with_check_expr
from pg_policy pol
join pg_class c on c.oid = pol.polrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'quote_internal_operational_plans'
order by pol.polname;

-- 11) Table ACL exploded (NULL/0 grantee is PUBLIC)
select
  acl.grantor,
  pg_get_userbyid(acl.grantor) as grantor_name,
  acl.grantee,
  case
    when acl.grantee = 0 then 'PUBLIC'
    else pg_get_userbyid(acl.grantee)
  end as grantee_name,
  acl.privilege_type,
  acl.is_grantable
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) as acl
where n.nspname = 'public'
  and c.relname = 'quote_internal_operational_plans'
  and c.relkind = 'r'
order by grantee_name, acl.privilege_type;

-- 12) Triggers on the table, or whose function is this RPC
select
  t.oid as trigger_oid,
  t.tgname as trigger_name,
  c.relname as table_name,
  p.proname as trigger_function,
  t.tgfoid as trigger_function_oid,
  t.tgenabled as enabled,
  t.tgisinternal as is_internal,
  pg_get_triggerdef(t.oid) as trigger_def
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
left join pg_proc p on p.oid = t.tgfoid
where (
    n.nspname = 'public'
    and c.relname = 'quote_internal_operational_plans'
  )
  or p.proname = 'mg_confirm_quote_operational_plan'
order by c.relname, t.tgname;
