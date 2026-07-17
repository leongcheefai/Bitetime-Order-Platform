# Printable customer receipt in order history

**Date:** 2026-07-17
**Status:** Approved, not yet implemented

## Problem

A customer signed in at a shop can open `/s/:slug/orders` and expand any order to see its
itemized breakdown. What they cannot do is keep a copy. There is no print action, and the
expanded row is not a document: it carries no shop identity, no customer name, no delivery
address, and no subtotal — it is a list row that happens to reconcile.

"View their invoice" here means an **order receipt**: a per-order document the customer can
print or save as a PDF. Not a tax invoice — no SST number, no invoice serial distinct from the
order number, no tax breakdown. Those need data merchants do not supply today and legal fields
nobody has asked for.

## What already exists

`apps/frontend/src/store/OrderHistory.tsx:170-213` renders, inside the expanded row: item lines
with a promo badge, delivery fee (when > 0), voucher line with its code (when a discount
applied), the total, the fulfillment mode, and courier/AWB. It formats money in the currency the
order was **paid** in (`o.currency ?? merchant.currency`, line 145) rather than the shop's
current one.

This design does not replace any of that. The expanded row keeps its current job.

## Constraints discovered

- **`merchants` has no address, phone, or business registration.** Columns are `name`, `slug`,
  `order_prefix`, `status`, `payment_qr/bank/note`, `tg_*`, `shipping`, `config`, `slug_locked`,
  `owner_id`, `created_at`. The receipt's shop identity block is therefore the shop **name
  only**. Adding contact fields is a separate piece of work (migration + dashboard settings UI +
  merchant data entry) and is explicitly out of scope. Reusing `payment_bank` / `payment_note` —
  fields written to instruct *pre*-payment — as a *post*-payment receipt footer was considered
  and rejected.
- **Subtotal is not persisted.** `orders` stores `items` (jsonb), `shipping_fee`, `discount`,
  `total`. Subtotal is derived.
- **Rounding reconciles.** `packages/shared/src/pricing.ts:159-164`:
  `subtotal = round2(Σ lineTotal)` and `total = round2(subtotal + shipping − discount)`.
  So a subtotal summed back from the stored item lines agrees with the stored total by
  construction. No need to back-derive subtotal as `total − shipping + discount`.
- **A split promo writes two lines sharing one product id** (pricing.ts:136-155 — the cap binds
  per unit, so a cart of 10 against 3 remaining promo units is a 3-line plus a 7-line). Anything
  iterating `o.items` must key by index, and anything summing them must not dedupe by id.

## Design

### Component

One new file: `apps/frontend/src/store/ReceiptDialog.tsx`.

```
OrderHistory row
  ├─ [expand] itemized breakdown (unchanged)
  └─ [Receipt] → <ReceiptDialog order merchant products onClose />

ReceiptDialog.tsx
  ├─ screen: modal overlay + Print button
  └─ @media print: dialog fills the page, everything else display:none
```

No new route. No new fetch. No backend. No migration. Everything the document states is already
in memory on this screen.

`ReceiptDialog` owns the document layout and does **not** reuse the expanded row's markup. The
row is list-shaped (truncation, hover, badges, a tap target); the receipt is page-shaped. One
component serving both would satisfy neither. The shared `Line` helper (currently
`OrderHistory.tsx:233`) moves into a small module both import.

### Trigger and state

Each expanded row gains a `Receipt` action beside the total. `OrderHistory` holds
`receiptId: string | null` alongside the existing `expandedId`; the dialog renders for the order
whose row id matches. Closing sets it back to `null`.

### Document body

| Block | Source |
|---|---|
| Shop name | `merchant.name` |
| Order number | `o.order_number` |
| Placed at | `o.created_at` — date **and time**, unlike the list row's date-only |
| Customer | `o.customer_name`, `o.customer_wa` |
| Delivery address | `o.address` jsonb (`line1`, `postcode`, `city`, `state`) — rendered only when `o.mode === 'delivery'` |
| Item lines | `o.items`, keyed by index; names resolved through the existing `itemName()` language lookup; promo badge from `item.promo` |
| Subtotal | `Σ (item.price × item.qty)` over the item lines |
| Delivery fee | `o.shipping_fee`, printed only when > 0 |
| Voucher | `o.discount` with `o.voucher_code` appended when present, printed only when > 0 |
| Total | `o.total` |

Money is formatted with `formatMoney(value, o.currency ?? merchant.currency)` — the currency the
order was paid in. Re-denominating a receipt by a later settings change would be a forgery; this
is the rule `OrderHistory.tsx:143-145` already states.

**Status and courier/AWB are deliberately absent.** A printed receipt is a snapshot; status goes
stale the moment it leaves the printer. Live status stays on the row, where it can change.

The subtotal line is what makes the printed arithmetic self-contained: `subtotal + fee −
voucher = total`, every term on the page.

### Print

The `Print` button calls `window.print()`. A `@media print` block hides the rest of the page
(`body > * { display: none }`) and promotes the dialog out of its overlay into static full-page
flow: black on white, no shadow, no backdrop, no overlay chrome, and the Print and Close buttons
themselves hidden. The customer's browser handles print-to-PDF; nothing is rendered or stored
server-side.

### Guest orders

Out of scope. Order history is a signed-in surface, and guest orders carry no `user_id` — they
are orphaned at placement and never appear here. `/track` remains the guest path and gains
nothing from this work.

## Testing

Per CLAUDE.md, UI is verified by running the app, not by component tests. Run-and-verify: place
a storefront order signed in, open history, open the receipt, check print preview.

One pure unit test earns its place — subtotal summed from `items`, including the split-promo
case where two lines share a product id and must both count.

## Out of scope

- Tax invoice fields (SST number, invoice serial, tax breakdown)
- Merchant address / phone columns and the dashboard UI to fill them
- Server-side PDF generation or storage
- A per-order route (`/s/:slug/orders/:orderNumber`)
- Receipts for guest orders
- Emailing the receipt
