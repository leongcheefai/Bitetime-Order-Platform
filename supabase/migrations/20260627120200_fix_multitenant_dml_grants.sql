-- Grant DML privileges on all public tables to the API roles.
-- PostgREST (via the authenticator role) switches to anon/authenticated/service_role
-- depending on the JWT; those roles need explicit SELECT/INSERT/UPDATE/DELETE to
-- operate. Without these the service-role integration tests and any future REST
-- calls against these tables will get "permission denied".

grant select, insert, update, delete on table public.merchants       to anon, authenticated, service_role;
grant select, insert, update, delete on table public.products        to anon, authenticated, service_role;
grant select, insert, update, delete on table public.vouchers        to anon, authenticated, service_role;
grant select, insert, update, delete on table public.order_counters  to anon, authenticated, service_role;
grant select, insert, update, delete on table public.merchant_secrets to anon, authenticated, service_role;

-- Also backfill the original single-tenant tables that were missing grants.
grant select, insert, update, delete on table public.orders   to anon, authenticated, service_role;
grant select, insert, update, delete on table public.profiles to anon, authenticated, service_role;
grant select, insert, update, delete on table public.settings to anon, authenticated, service_role;
