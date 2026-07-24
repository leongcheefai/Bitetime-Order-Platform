-- One confirmation email per order, enforced by an atomic conditional stamp.
--
-- After an order commits, POST /api/notify/order fans out to two recipients: the merchant's
-- Telegram (unchanged) and — new — the signed-in customer's confirmation email. Nothing marks
-- the merchant Telegram as sent (a repeat there is harmless noise), but the customer must get
-- EXACTLY ONE email: a duplicate reads as "something went wrong".
--
-- This column is the one-shot guard. The send path claims the row with
--   update orders set confirmation_emailed_at = now() where id = $1 and confirmation_emailed_at is null returning id
-- and only the caller that flips NULL→now() sends. Concurrent or repeated calls (retry, refresh,
-- an enumerator hitting the anonymous endpoint) update zero rows and send nothing.
--
-- NULL means "not yet emailed", which is also every order placed before this migration and every
-- guest order (guests have no account and are never emailed at all).
alter table public.orders
  add column if not exists confirmation_emailed_at timestamptz;
