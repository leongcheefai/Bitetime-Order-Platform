-- Drop two SECURITY DEFINER functions nothing calls any more.
--
-- Both were written for the single-tenant order form, which has since been deleted:
--   * product_sales()  fed the promo quantity limit (fetchProductSales)
--   * is_new_customer() gated the referral discount (isNewCustomer)
-- Neither wrapper survives in the frontend, and the multi-tenant Storefront never
-- called either. They are reachable by `anon` and read across every merchant's
-- orders, so leaving them granted is a standing cross-tenant read on dead code.
--
-- Dropping a function drops its grants with it (the ACL lives in pg_proc.proacl and
-- dies with the row), so the `grant execute ... to anon, authenticated` lines in the
-- init migration need no separate revoke.

drop function if exists public.product_sales();
drop function if exists public.is_new_customer(text, text);
