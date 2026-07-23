# Customer search + order history — design

**Date:** 2026-07-23
**Surface:** Merchant dashboard → Customers tab (`merchant/CustomersView.tsx`)

## Problem

The Customers tab is a read-only table (NAME, WHATSAPP, ORDERS, LAST ORDER).
Merchants want two things it can't do:

1. **Search** — find a customer by name or WhatsApp when the list is long.
2. **Order history** — open a customer and see the orders they placed at this
   shop, and drill into any one for full order detail.

## Constraints / context

- `fetchMerchantCustomers(merchantId)` (`store.ts`) already fetches **every**
  order for the shop client-side, then aggregates by customer. The raw orders
  are in hand and currently discarded — so search and order history need **no
  backend change**.
- Customer lists are small (bounded by a single shop's order volume, already
  fully loaded for the table). Search and history stay **client-side**; no
  server-side search or pagination.
- The full order-detail view already exists as a `<Sheet>` inside
  `OrdersView.tsx` (lines ~235–443, ~210 lines) with editable note / tracking /
  status. It must be reused, not duplicated.

## Design

### 1. Extract `OrderDetailSheet` (shared component)

Pull the order-detail `<Sheet>` out of `OrdersView.tsx` into
`merchant/OrderDetailSheet.tsx` as a self-contained module. This is a targeted
improvement of code we're working in: OrdersView is 446 lines and the sheet is
half of it; extraction shrinks OrdersView and lets both tabs render the identical
detail with zero duplication.

**Props:**

```
{
  order: Order | null        // open when non-null
  onClose: () => void
  onOrderUpdated: (o: Order) => void   // status/note/tracking saves bubble up
  readOnly?: boolean
}
```

**Owns internally** (moved verbatim from OrdersView, behaviour unchanged):
- note / courier / awb draft state + the re-seed-on-`order.id`-change logic
  (adjust-state-during-render, keyed on id)
- `handleStatusChange` / `handleNoteSave` / `handleTrackingSave` — each calls the
  same `store.ts` mutation, then calls `onOrderUpdated(updated)`
- all rendering: items, totals, fulfilment, tracking, note, status controls, the
  `formatMoney` / `StatusBadge` / `fulfilmentLabel` / `formatCalendarDate` /
  `formatAddress` / `formatTaxRate` helpers it already uses

`readOnly` keeps its current meaning (suspended shop view): hides tracking/note
editors and status control.

**`OrdersView.tsx` after extraction:**
- keeps the DataTable + `orders` state + `selected` state
- `patchOrder` becomes the `onOrderUpdated` handler passed down
- renders `<OrderDetailSheet order={selected} onClose={() => setSelected(null)}
  onOrderUpdated={patchOrder} readOnly={readOnly} />`
- the `drawerFor` re-seed state moves **into** the sheet (it was only there to
  drive the drafts, which now live in the sheet)

### 2. `store.ts` — keep each customer's orders

`fetchMerchantCustomers` gains `orders: Order[]` (newest-first) per aggregated
customer, plus a stable `key` (the existing map key: `wa || name || '—'`) for
React keys and selection identity.

```
{ key, name, wa, orderCount, lastOrder, orders }
```

Same single `fetchMerchantOrders` call; the loop now pushes each order into the
customer's `orders` array instead of only counting. Sort each `orders` array
newest-first before returning (the aggregate loop already tracks `created_at`).

### 3. `CustomersView.tsx`

**Search input** above the table:
- controlled `query` state
- filter: `name` contains query OR `wa` (digits-only) contains query
  (digits-only) — case-insensitive on name
- empty-match state: "No customers match '<query>'." (distinct from the existing
  "No customers yet." zero-data state)

**Clickable rows** → open a **customer `<Sheet side="right">`**:
- header: customer name, WhatsApp link (`wa.me`, digits-normalized), order count
- order-history list, newest-first. Each line:
  `order_number` · date (`fmtDate`) · `StatusBadge` · total (`formatMoney`,
  `order.currency ?? merchant.currency`)
- the WhatsApp `<a>` in the **table row** calls `stopPropagation` so the existing
  wa.me link still works without opening the drawer

**Click an order line** → open `OrderDetailSheet` **stacked on top** of the
customer drawer (Radix supports nested sheets). Closing the order sheet (X / esc /
click-away) returns to the customer drawer underneath.
- CustomersView holds `selectedCustomer` and `selectedOrder` state
- `onOrderUpdated`: patch that order inside `selectedCustomer.orders` (and the
  master `customers` list) so a status change reflects immediately
- `readOnly`: **not passed** — CustomersView renders only in the live Dashboard,
  never in `SuspendedScreen` (which mounts `OrdersView readOnly` but not this
  tab). So the order detail here is always the full editable view.

## Non-goals (YAGNI)

- No server-side search / pagination — lists are small and already fully loaded.
- No new backend endpoint — all data is already fetched.
- No email/order-number search — name + WhatsApp only (per product decision).

## Testing

Per CLAUDE.md, UI is verified by running the app (run-and-verify via the `verify`
skill), not component tests. Manual checks:
- search narrows the list by name and by WhatsApp digits; clearing restores all
- clicking a customer opens the drawer with the right orders, newest-first
- clicking an order opens full detail stacked; editing status there updates the
  line in the customer drawer and closing returns to the customer drawer
- OrdersView detail sheet still behaves identically after extraction (status,
  note, tracking saves; readOnly suspended view)

## Files touched

- `apps/frontend/src/merchant/OrderDetailSheet.tsx` — **new**, extracted
- `apps/frontend/src/merchant/OrdersView.tsx` — render extracted sheet
- `apps/frontend/src/merchant/CustomersView.tsx` — search + drawer + detail
- `apps/frontend/src/store.ts` — `fetchMerchantCustomers` returns `orders`
