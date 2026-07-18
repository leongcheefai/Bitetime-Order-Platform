-- Phase B terminal step: every browser write (and read, per Phase A) now goes through the
-- backend API's service-role client. The browser holds ZERO direct table grants after this.
-- RLS policies and the guard_merchant_status / guard_profile_privileges triggers are NOT
-- dropped here — they remain in place as defense-in-depth per CLAUDE.md -> Backend ("RLS
-- remains in force for the browser's anon/authenticated path and is the backstop"). Postgres
-- checks table-level privileges before RLS, so this REVOKE is what actually closes the door;
-- RLS is the belt for anything that ever reopens a grant by accident.
--
-- Verified against the running local DB with:
--   psql "$DB_URL" -c "\dp public.*"
--   select table_schema, table_name, grantee, privilege_type
--     from information_schema.role_table_grants
--    where grantee in ('anon','authenticated') and table_schema='public';
-- Every table in the public schema (`\dt public.*`) still held some grant for anon and/or
-- authenticated — including `referral_rewards`, which the plan's draft list omitted (authenticated
-- still held SELECT on it; reads of it already moved to the backend in Phase A). `orders` had
-- already lost INSERT (backend-only intake, 20260714100000) and `merchant_billing` had already
-- lost SELECT (20260718120000) — REVOKE ALL on both is a harmless no-op for those privileges and
-- cleans up the remaining structural grants (REFERENCES/TRIGGER/TRUNCATE/etc).
--
-- supabase.auth (GoTrue, schema `auth`) and Storage (schema `storage`) grants are untouched —
-- those back supabase-js auth/storage calls, which stay browser-side, and were never in scope.
REVOKE ALL ON public.merchants FROM anon, authenticated;
REVOKE ALL ON public.merchant_secrets FROM anon, authenticated;
REVOKE ALL ON public.merchant_billing FROM anon, authenticated;
REVOKE ALL ON public.profiles FROM anon, authenticated;
REVOKE ALL ON public.products FROM anon, authenticated;
REVOKE ALL ON public.orders FROM anon, authenticated;
REVOKE ALL ON public.order_counters FROM anon, authenticated;
REVOKE ALL ON public.vouchers FROM anon, authenticated;
REVOKE ALL ON public.settings FROM anon, authenticated;
REVOKE ALL ON public.referral_rewards FROM anon, authenticated;
