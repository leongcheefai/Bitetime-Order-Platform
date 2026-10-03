-- supabase/migrations/20261002140000_hitpay_duitnow_qr.sql
--
-- Dynamic DuitNow QR through each merchant's OWN HitPay account (spec:
-- docs/superpowers/specs/2026-10-02-hitpay-duitnow-qr-design.md). TinyOrder never holds money.
--
-- 1. The merchant's HitPay key and the webhook TinyOrder registered with it. merchant_secrets has
--    no browser grants (20260718130000_revoke_all_browser_grants.sql); only the backend reads it.
alter table public.merchant_secrets
  add column if not exists hitpay_api_key       text,
  add column if not exists hitpay_webhook_id    text,
  add column if not exists hitpay_webhook_token text;

create unique index if not exists merchant_secrets_hitpay_webhook_token_key
  on public.merchant_secrets (hitpay_webhook_token) where hitpay_webhook_token is not null;

-- 2. What the storefront reads to choose the dynamic QR. Written by the backend only, at connect
--    and disconnect; deliberately NOT in the merchant config write allowlist (writes.ts).
alter table public.merchants
  add column if not exists hitpay_connected boolean not null default false;

-- 2b. The one-time stamp for the merchant alert that a HitPay order HOLDS until payment. When the
--     customer cannot get a QR (HitPay down, no platform config, the shop disconnected), the
--     backend releases the held alert once, with a warning, and this stamp is what makes it once.
alter table public.orders
  add column if not exists hitpay_fallback_alerted_at timestamptz;

-- 3. One row for each HitPay payment request. Many rows for one order over time (a QR expires and
--    the customer asks for a new one); at most ONE pending row, which the partial index enforces
--    against two concurrent requests.
create table if not exists public.order_payments (
  id                 uuid primary key default gen_random_uuid(),
  order_id           uuid not null references public.orders (id) on delete cascade,
  merchant_id        uuid not null references public.merchants (id) on delete cascade,
  gateway            text not null check (gateway in ('hitpay')),
  gateway_request_id text not null unique,
  qr_payload         text not null,
  amount             numeric(12,2) not null,
  currency           text not null,
  status             text not null check (status in ('pending', 'completed', 'expired', 'failed')),
  expires_at         timestamptz not null,
  paid_at            timestamptz,
  created_at         timestamptz not null default now()
);

create unique index if not exists order_payments_one_pending
  on public.order_payments (order_id) where status = 'pending';
create index if not exists order_payments_order_created
  on public.order_payments (order_id, created_at desc);

alter table public.order_payments enable row level security;
revoke all on public.order_payments from anon, authenticated;
-- The service-role REST client is granted what a test or an admin read needs. The backend's own
-- writer is db.ts, which connects as the database owner and is bound by no grant.
grant select, insert, update on public.order_payments to service_role;

-- 4. Two order log kinds. Same shape as 20260917120100_order_events_fulfil_time.sql: drop the
--    constraint by name and re-add it with the new members.
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
    'voucher_restored',
    'payment_confirmed',
    'payment_after_cancel'
  ));
