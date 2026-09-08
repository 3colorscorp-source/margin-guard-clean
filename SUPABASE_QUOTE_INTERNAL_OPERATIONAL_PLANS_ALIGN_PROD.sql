-- DO NOT APPLY.
-- Production align is deferred until
-- SUPABASE_QUOTE_INTERNAL_OPERATIONAL_PLANS_INSPECT.sql has been run
-- and the live overloads, defaults, table shape, grants, and RLS are known.
--
-- CREATE TABLE IF NOT EXISTS cannot repair an existing incomplete table.
-- Do not DROP every overload of mg_confirm_quote_operational_plan in advance.
-- After inspect, write a minimal script aimed only at the confirmed signatures.
--
-- This file is a placeholder so the previous generic DROP/replace script is
-- not treated as authorized.

select 'align_deferred_until_inspect' as status;
