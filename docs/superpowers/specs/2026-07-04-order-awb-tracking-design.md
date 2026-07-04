# Order AWB Tracking

**Date:** 2026-07-04
**Surfaces:** merchant order drawer (`apps/frontend/src/merchant/OrdersView.tsx`), new customer track page (`apps/frontend/src/store/TrackOrder.tsx`), backend migration + RPC.

## Problem

Delivery orders have an `awb` column but no way to capture a courier, no
customer-facing surface to view it, and no tracking link. A merchant who ships
a parcel has nowhere to record the tracking number, and the customer has no way
to follow their order.

## Goal

Let a merchant record **courier + AWB** on a delivery order, and let the
customer look their order up on a public page and deep-link to the courier's
own tracking site.

## Non-goals

- No courier API integration / live status polling — we deep-link to each
  courier's public tracking page only.
- No customer accounts or order history — the track page is an anonymous
  lookup by order number.
- AWB entry is offered for `mode === 'delivery'` only; `pickup`/`sameday` are
  unaffected.

## Security note (order-number-only lookup)

The track page authenticates on order number alone (product decision). Order
numbers are semi-guessable (`<PREFIX>-YYMMDD-NNNN`, daily counter from 50), so
enumeration can expose an order's shipping state. Mitigation: the lookup RPC
returns **only non-PII fields** — `status`, `mode`, `courier`, `awb`,
`created_at`. It never returns customer name, phone, address, items, or totals.
Exposure is limited to parcel-tracking state, no personal data.

## Design

### 1. Schema (backend migration)

Add a nullable `courier` column to `orders` (the `awb` column already exists):

```sql
alter table public.orders add column if not exists courier text;
```

`courier` holds a short code (`jnt`, `poslaju`, `ninja`, `citylink`, `spx`,
`flash`, `other`) or null. Run `db:migrate` after adding the file.

### 2. Courier catalog (`apps/frontend/src/couriers.ts`, pure)

A single source of truth for courier codes, display names, and tracking-URL
templates.

```ts
export interface Courier { code: string; name: string; track: ((awb: string) => string) | null }
export const COURIERS: Courier[] = [ /* jnt, poslaju, ninja, citylink, spx, flash, other */ ]
export function courierName(code: string | null | undefined): string   // '' when unknown/null
export function trackingUrl(code: string | null | undefined, awb: string | null | undefined): string | null
```

- Each courier maps to its **public** tracking URL, AWB URL-encoded into the
  template. `other` (and unknown codes) has `track: null`.
- `trackingUrl` returns null when courier is `other`/unknown or `awb` is blank.
- **The URL templates must be verified against each courier's live site during
  implementation** — a wrong template silently sends customers to a dead page.
  Initial set to verify: J&T MY, Pos Laju, Ninja Van MY, City-Link, SPX
  (Shopee), Flash Express MY.
- Pure module → unit-tested (`couriers.test.ts`): `trackingUrl` builds the
  expected URL for a known courier, returns null for `other`/blank AWB, and
  `courierName` round-trips codes.

### 3. Store functions (`apps/frontend/src/store.ts`)

```ts
// Merchant: persist courier + awb together on one order; returns the updated row.
export async function setOrderTracking(orderId: string, courier: string | null, awb: string): Promise<Order>
// Customer: public lookup by order number within a merchant.
export async function fetchOrderTracking(merchantId: string, orderNumber: string):
  Promise<{ status: string; mode: string; courier: string | null; awb: string | null; created_at: string } | null>
```

- `setOrderTracking` updates `{ courier, awb: awb.trim() || null }` via the
  existing `orders_update_merchant` RLS policy (same path as `setOrderStatus`).
- `fetchOrderTracking` calls the `track_order` RPC (below) and returns the
  single row or null when not found.

### 4. Lookup RPC (backend migration, security-definer)

Mirrors the `redeem_voucher` / `next_order_number` pattern (security definer,
`search_path = public`, granted to `anon, authenticated`). Guests cannot read
`orders` directly (RLS is merchant-scoped), so the read goes through this RPC,
which returns only the non-PII columns:

```sql
create or replace function public.track_order(p_merchant uuid, p_order_number text)
returns table (status text, mode text, courier text, awb text, created_at timestamptz)
language sql security definer set search_path = public
as $$
  select o.status, o.mode, o.courier, o.awb, o.created_at
  from public.orders o
  where o.merchant_id = p_merchant
    and o.order_number = p_order_number
  limit 1;
$$;
grant execute on function public.track_order(uuid, text) to anon, authenticated;
```

Order number is trimmed/uppercased on the client before the call to match the
stored format.

### 5. Merchant entry (drawer — `OrdersView.tsx`)

In the detail Sheet, when `selected.mode === 'delivery'` and not `readOnly`,
render a **Delivery tracking** section:

- Courier `<select>` (options from `COURIERS`, plus a blank "Select courier…").
- AWB text `<input>`.
- **Save** button, disabled until courier or awb differs from the stored row
  (same draft + adjust-state-during-render pattern as the note, keyed on
  order id). On save → `setOrderTracking` → optimistic `patchOrder` + toast.
- When both courier and awb are set, show a small "Track link" preview anchor
  (`trackingUrl`), so the merchant can confirm the deep-link works.

For `readOnly` or non-delivery orders, keep the existing read-only AWB row in
the Fulfilment section (also show courier name when present).

### 6. Customer track page (`apps/frontend/src/store/TrackOrder.tsx`)

New nested route `track` under the storefront. In `AppRouter.tsx`, the
`StorefrontShell` (after the `status === 'active'` gate) renders nested routes:

```tsx
<Routes>
  <Route index element={<Storefront />} />
  <Route path="track" element={<TrackOrder />} />
</Routes>
```

`TrackOrder` (merchant available via `useMerchant`, `t`/`lang` via
`useSession`):

- Form: **Order number** input → **Track** button. Calls
  `fetchOrderTracking(merchant.id, orderNumber)`.
- Result: order number, status badge (reuse the merchant status badge/labels —
  extract the shared `STATUS_LABELS`/`STATUS_BADGE` into a small shared module
  if cleanly reusable, otherwise duplicate the minimal label+badge locally),
  courier name, AWB, and a **Track parcel →** link when `trackingUrl` is
  non-null. If the courier has no template, show the AWB with a note to search
  the courier's site.
- Not found / blank: friendly localised message ("No order found with that
  number.").
- Styling follows the storefront's existing card/token system.

### 7. Entry points

- **Order-confirmation screen** (in `Storefront.tsx`): alongside the confirmed
  order number, add a "Track your order" link to `/s/:slug/track`. (AWB does
  not exist yet at placement time — the link lets the customer return later.)
- **Storefront** (`Storefront.tsx`): a small "Track order" link (header or
  footer) to `/s/:slug/track`.

## File structure

- Create: `apps/backend/supabase/migrations/<ts>_order_courier_and_track.sql`
  (courier column + `track_order` RPC in one migration).
- Create: `apps/frontend/src/couriers.ts`, `apps/frontend/src/couriers.test.ts`.
- Create: `apps/frontend/src/store/TrackOrder.tsx`.
- Modify: `apps/frontend/src/store.ts` (two functions).
- Modify: `apps/frontend/src/merchant/OrdersView.tsx` (tracking section).
- Modify: `apps/frontend/src/AppRouter.tsx` (nested track route).
- Modify: `apps/frontend/src/store/Storefront.tsx` (confirmation + storefront links).

## Testing

- `couriers.test.ts` — pure unit tests for `trackingUrl` / `courierName`.
- Migration applied locally via `db:migrate`; verify `courier` column and
  `track_order` RPC exist and the RPC returns only the five non-PII columns.
- Run-and-verify (UI, per repo convention):
  - Merchant: open a delivery order, set courier + AWB, Save → persists after
    reload; the Track-link preview points at the courier site.
  - Customer: `/s/:slug/track`, enter the order number → status + courier +
    AWB + working Track-parcel link; wrong number → friendly not-found.
  - Confirmation screen and storefront show the track link.
