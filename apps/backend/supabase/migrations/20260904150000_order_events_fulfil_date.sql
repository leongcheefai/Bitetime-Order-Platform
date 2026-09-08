-- The order log gains `fulfil_date_changed`: a merchant moved the day an order is for.
--
-- `kind` is CHECKed against the closed list `packages/shared/src/orderEvents.ts` also holds, so
-- a kind the drawer has not been taught cannot be written. The constraint was declared inline
-- on the column in `20260904120000_order_events.sql`, which Postgres names
-- `<table>_<column>_check`; it is dropped by that name and re-added with the new member, under
-- the same name so the next kind does the same thing. Adding a kind means both places — the
-- list and this constraint — and the drawer's sentence table, whose exhaustiveness test fails
-- until the new kind has words.
alter table public.order_events drop constraint if exists order_events_kind_check;

alter table public.order_events
  add constraint order_events_kind_check check (kind in (
    'created',
    'payment_proof_uploaded',
    'merchant_payment_proof_uploaded',
    'status_changed',
    'note_changed',
    'courier_changed',
    'awb_changed',
    'fulfil_date_changed',
    'voucher_released',
    'voucher_restored'
  ));
