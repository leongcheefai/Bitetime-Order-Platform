-- Who an order belongs to is decided by the DATABASE, never by the client.
--
-- `orders.user_id` existed and the select policy already honoured it, but nothing
-- ever set it — and the insert policy was `with check (true)`, so any holder of
-- the anon key (it ships in every browser) could insert an order carrying a
-- *stranger's* user_id and push it into their history.

-- ── Stamp the ordering user from the JWT ─────────────────────────────────────
-- Whatever the client sends in user_id is discarded. Signed in => their id.
-- Guest (no JWT) => NULL. Spoofing is impossible by construction, not by policy.
--
-- Unconditional on purpose. A service-role insert is RLS-exempt but NOT
-- trigger-exempt and carries no auth.uid(), so it would land NULL — nothing
-- inserts orders server-side today, but if order intake ever moves to the
-- backend this trigger needs a carve-out.
create or replace function public.orders_set_user_id()
returns trigger
language plpgsql
as $$
begin
  new.user_id := auth.uid();
  return new;
end;
$$;

drop trigger if exists orders_set_user_id on public.orders;
create trigger orders_set_user_id
  before insert on public.orders
  for each row execute function public.orders_set_user_id();

-- ── Replace the blanket insert policy ────────────────────────────────────────
-- Guests still check out, but only into a shop that is actually open, and only
-- as a brand-new order (you could previously insert one already 'completed').
--
-- The EXISTS resolves under RLS only because merchants_select_public is
-- `using (true)`. If that is ever tightened this check breaks SILENTLY — move it
-- into a security-definer helper then.
--
-- Postgres applies WITH CHECK to the row *after* BEFORE INSERT triggers run, so
-- the trigger above and this policy do not fight.
drop policy if exists orders_insert_any on public.orders;
create policy orders_insert_guest_or_customer on public.orders
  for insert with check (
    status = 'new'
    and exists (
      select 1 from public.merchants m
      where m.id = merchant_id and m.status = 'active'
    )
  );

-- ── Serves the per-shop order history query ──────────────────────────────────
create index if not exists orders_user_merchant_created_idx
  on public.orders (user_id, merchant_id, created_at desc)
  where user_id is not null;

-- No backfill: existing orders keep user_id NULL. Guest orders are never
-- claimed retroactively — that is what makes the guest warning true, and it
-- closes the takeover surface that matching on an unverified WhatsApp number
-- would open.
