-- supabase/migrations/20260917120100_order_events_fulfil_time.sql
--
-- The order log gains `fulfil_time_changed`: a merchant moved the slot an order is for. Same
-- shape as 20260904150000_order_events_fulfil_date.sql — the constraint is dropped by its name
-- and re-added with the new member, so the next kind does the same thing. Adding a kind means
-- this constraint, `packages/shared/src/orderEvents.ts`, and the drawer's sentence table.
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
    'fulfil_time_changed',
    'voucher_released',
    'voucher_restored'
  ));
