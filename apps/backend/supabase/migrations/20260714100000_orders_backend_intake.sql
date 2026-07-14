-- Order intake moves to the backend (#65, #61). Three changes that MUST land together.
--
-- Each one is safe only in the presence of the others, which is why this is one migration and
-- not three. Split them and you ship either a live spoofing hole or a dead checkout.

-- ── 1. The browser stops inserting orders ────────────────────────────────────
-- This is what makes step 2 safe, so it comes first and cannot be separated from it. After
-- this, the ONLY thing that can insert an order is the backend, which reaches Postgres as the
-- database owner through db.ts.
--
-- The orders_insert_guest_or_customer policy is deliberately left in place. It no longer has
-- anyone to apply to, and that is precisely why it stays: it is the backstop if INSERT is ever
-- granted back by accident, and tests/rls keeps proving the door is shut.
revoke insert on public.orders from anon, authenticated;

-- ── 2. The trigger stops overwriting an explicitly-supplied user_id ──────────
-- `new.user_id := auth.uid()` was unconditional, and there is NO auth.uid() on a direct
-- Postgres connection — so without this carve-out every backend-inserted order would land with
-- user_id = NULL, silently and permanently destroying the order history of every signed-in
-- customer (guest orders are never reclaimed retroactively, by design). The migration that
-- wrote this trigger predicted exactly this: "if order intake ever moves to the backend this
-- trigger needs a carve-out."
--
-- COALESCE reopens the spoofing hole the unconditional assignment was written to close — a
-- client that can both set user_id and reach this trigger can push an order into a stranger's
-- history. The revoke above is what shuts it, BY CONSTRUCTION rather than by policy: anything
-- reaching this trigger with a settable user_id is the backend, because nothing else has
-- INSERT any more. The backend takes user_id from the verified JWT and never from the request
-- body (see src/orders.ts). Grant INSERT back to a client role and this hole is open again.
create or replace function public.orders_set_user_id()
returns trigger
language plpgsql
as $$
begin
  new.user_id := coalesce(new.user_id, auth.uid());
  return new;
end;
$$;

-- ── 3. The two SQL rules the backend now owns ────────────────────────────────
-- Their logic lives in src/orders.ts, inside one transaction: the counter's atomic upsert and
-- the voucher's SELECT … FOR UPDATE are ported statement for statement, which is why the
-- backend needed a real driver at all. Dropping them drops their anon/authenticated grants
-- with them — leaving next_order_number executable would let anyone burn a shop's counter.
drop function if exists public.next_order_number(uuid);
drop function if exists public.redeem_voucher(uuid, text, text);
