-- The order log (#268, ADR 0025): one row per thing that happened to one order.
--
-- APPEND-ONLY. An event is inserted in the same transaction as the write it records and is never
-- updated or deleted — a log that can be edited is not a log. `service_role` is granted select
-- and insert only; the browser roles hold nothing, matching every table since
-- 20260718130000_revoke_all_browser_grants.sql. The backend's own writer is db.ts, which connects
-- as the database owner and is bound by no grant — so on that path "never updated" is a rule
-- orderEventsDb.ts keeps (it has no update or delete statement), not one Postgres enforces.
--
-- `merchant_id` is denormalised from the order. The merchant read proves tenancy through the
-- order (requireOwnsChild), so the column is not what guards it; it exists so a per-shop read
-- (a superadmin dispute view, a shop-wide export) needs no join. `actor_id` is null for a guest
-- and for the system; `actor_kind` is what tells those two apart on screen.
--
-- `kind` is CHECKed against the closed list `packages/shared/src/orderEvents.ts` also holds, so
-- a kind the drawer has not been taught cannot be written. Adding a kind means both places.
--
-- `id` is an identity bigint, not a uuid, and that is the log's ORDER. Every event one
-- transaction writes shares one `now()`, so `created_at` cannot order the two events a payment
-- proof produces (the upload, then the status it moved) — a random uuid tiebreak showed them
-- either way round. An identity column is monotonic within the connection that inserts.
--
-- No backfill. An order placed before this migration has no events, and the drawer reads
-- "placed" off the order's own created_at — the one fact the row already holds. A backfilled
-- status history would be a guess written as a record.
create table if not exists public.order_events (
  id          bigint generated always as identity primary key,
  order_id    uuid not null references public.orders (id) on delete cascade,
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  kind        text not null check (kind in (
                'created',
                'payment_proof_uploaded',
                'merchant_payment_proof_uploaded',
                'status_changed',
                'note_changed',
                'courier_changed',
                'awb_changed',
                'voucher_released',
                'voucher_restored'
              )),
  actor_kind  text not null check (actor_kind in ('merchant', 'customer', 'system')),
  actor_id    uuid,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists order_events_order_id_idx
  on public.order_events (order_id, id);

alter table public.order_events enable row level security;
revoke all on public.order_events from anon, authenticated;
grant select, insert on public.order_events to service_role;
