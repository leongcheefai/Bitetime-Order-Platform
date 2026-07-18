-- Reads of merchant_billing now go through the backend (GET /api/billing and
-- /api/merchants/:id/billing, on the service-role client). The browser no longer needs
-- direct SELECT, and it never had INSERT/UPDATE/DELETE here. Revoke it so a direct
-- PostgREST read cannot reach billing at all. RLS policies stay in place as the backstop.
REVOKE SELECT ON public.merchant_billing FROM anon, authenticated;
