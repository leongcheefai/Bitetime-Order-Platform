# Fulfilment date selection

Issue: [#91](https://github.com/leongcheefai/Bitetime-Order-Platform/issues/91) — customers have no way to say *when* they want their order.

## Problem

The storefront collects items, a fulfilment mode (pickup or delivery), and contact details. It never asks for a date. Merchants find out when the customer wants the order only by chasing them on WhatsApp after the fact, and there is nothing in the order record or the Telegram alert to schedule against.

## Scope

Customers pick a **calendar date** — not a time, not a slot. The date is **required** on every new order, and the same rules apply to pickup and delivery. Merchants control which dates are offered.

Explicitly out of scope: time slots, per-mode rules, capacity limits per day, one-off blackout dates (public holidays). Weekly closed days cover the common case; one-off dates can follow if merchants ask for them.

## Design

### 1. The rule lives in `@bitetime/shared`

Which dates a customer may pick must be decided identically in the browser (to build the picker) and on the backend (to reject a forged request). That is precisely the criterion for `packages/shared`: a rule that must hold on both sides of the wire.

New `packages/shared/src/fulfilment.ts`:

```ts
export type FulfilmentConfig = {
  lead_days: number        // 0 = same-day allowed
  window_days: number      // how far ahead the picker reaches
  closed_weekdays: number[] // 0 = Sunday … 6 = Saturday
}

export const DEFAULT_FULFILMENT: FulfilmentConfig = {
  lead_days: 0,
  window_days: 14,
  closed_weekdays: [],
}

export function todayInZone(tz: string, now: Date): string
export function isDateSelectable(date: string, cfg: FulfilmentConfig, tz: string, now: Date): boolean
export function selectableDates(cfg: FulfilmentConfig, tz: string, now: Date): string[]
```

Dates are plain `YYYY-MM-DD` strings everywhere — in the picker's state, in the request body, in the column, in the Telegram message. A `Date` object is never used to carry a calendar date. This is not stylistic: constructing a `Date` from a date string and reading it back in another timezone can shift the order by a day, and that day is what the merchant cooks on.

`todayInZone` derives the shop's current date via `Intl.DateTimeFormat` with an explicit `timeZone`, so "today" means today *where the shop is*, not where the customer's laptop is.

`now` is a parameter, never `Date.now()` read inside. Tests pin it.

### 2. Data model

One migration:

- `merchants.timezone text not null default 'Asia/Kuala_Lumpur'` — a first-class shop property, read by backend validation. A column rather than a config key because the backend must read it on every order intake and it is not optional.
- `orders.fulfil_date date` — nullable.
- Drop `orders.preferred_date`. It exists in the init schema, is referenced by no code, and its name would read as a soft preference next to a hard commitment.

`fulfil_date` is nullable in Postgres because every order placed before this ships has no date and never will. *Required* is enforced at intake for new orders, not by the column. Nothing backfills history with a guess.

Merchant config goes in the existing `merchants.config` jsonb under key `fulfilment`, shaped as `FulfilmentConfig`. A merchant who has never opened the new settings tab has no key, which reads as `DEFAULT_FULFILMENT` — so the feature works for every existing shop on day one with no merchant action, offering today through two weeks out with no closed days.

### 3. Enforcement

`apps/backend/src/orders.ts` re-validates inside the existing transaction. `assertOrderableMerchant` already runs the active-status gate and returns the merchant row, so it widens its select to include `config` and `timezone`, and `placeOrder` calls `isDateSelectable` against them. `placeOrder` already takes `now` as a parameter, so tests pin the clock without touching the signature. A missing or unselectable date throws before `nextCounterValue` runs, so no counter is bumped and nothing commits.

This is not belt-and-braces. `db.ts` is RLS-exempt and the request body is customer-controlled; the browser's picker is a convenience, and the backend is the authority — the same stance the codebase already takes on order attribution, where `user_id` comes from the JWT and never from the body.

The storefront surfaces the rejection the same way it surfaces a stale voucher: an inline message asking the customer to pick another date, with the picker refreshed from current config. The realistic trigger is a customer with a checkout page left open across midnight, not an attacker.

### 4. Surfaces

**Storefront** (`store/Storefront.tsx`) — a month grid between the FULFILMENT selector and YOUR DETAILS. Days outside the window and days on closed weekdays render disabled, not hidden, so the customer can see *why* a date is unavailable rather than wondering where it went. Month navigation is bounded by the window. Identical for pickup and delivery.

**Merchant dashboard** (`merchant/ShopSettings.tsx`) — a new **Fulfilment** tab beside shipping / payment / notifications: lead days, window days, closed weekday checkboxes, timezone select.

**Telegram** (`apps/backend/src/notify.ts`) — `buildOrderMessage()` prints the fulfilment date. The merchant reading that message on their phone is the person who needs the date most.

**Order lists** (merchant dashboard, customer order history) — show the date; a `null` renders as `—`.

Both the customer-facing picker and the merchant-facing labels are bilingual via the existing `t(en, zh)` convention. Weekday and month names come from the existing `orderDate.ts` locale helpers rather than a second formatting path.

## Testing

- **Unit** (`packages/shared/src/fulfilment.test.ts`): lead-day and window boundaries (first and last selectable date, and the days just outside them); closed weekdays removed from `selectableDates`; `todayInZone` across a timezone boundary — a `now` that is already tomorrow in UTC but still today in `Asia/Kuala_Lumpur`; empty result when every weekday in the window is closed.
- **Backend API** (`apps/backend/tests/api/`): an order body carrying a date outside the window is rejected, and no order row or counter bump survives; a valid date is stored on the order.
- **UI**: run-and-verify per CLAUDE.md — place a real order through the storefront against local Supabase and confirm the date reaches the merchant dashboard and the Telegram message.

## Migration note

Adding the migration file does not apply it. `pnpm --filter @bitetime/backend db:migrate` must run locally, or queries fail against a stale PostgREST schema cache.
