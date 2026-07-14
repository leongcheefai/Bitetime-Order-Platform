-- The referred-shops lookup now lives in the backend (GET /api/referrals/shops), so the
-- SECURITY DEFINER function it replaced can go.
--
-- What that function was doing, and what the endpoint must keep doing: a referrer's shops
-- are by definition NOT their own tenant, so reading them means reading across tenants.
-- my_referred_shops was allowed to do that because it derived the filter — the caller's
-- referral code — from auth.uid(), which the caller could not choose. The endpoint derives
-- it from the verified JWT for exactly the same reason. Accept the code from the request
-- instead and either version becomes a cross-tenant read of anybody's referrals.
--
-- Dropping a function drops its grants with it, so the `grant execute ... to authenticated`
-- in the referral_capture migration needs no separate revoke.

drop function if exists public.my_referred_shops();
