# Merchant Orders — DataTable + Detail Sheet

**Date:** 2026-07-04
**Component:** `apps/frontend/src/merchant/OrdersView.tsx`

## Problem

The merchant orders screen renders each order as a large stacked card
(order #, customer, items, total, mode, address, status select). It scans
poorly once a shop has more than a handful of orders — no sort, no search,
no pagination, and every field is always visible whether or not the merchant
cares about it.

## Goal

Replace the card list with a scannable `DataTable` (sort, search, paginate).
Clicking a row opens a right-hand `Sheet` with the full order detail, where
the merchant can also change the order status. Keep the existing `readOnly`
behaviour for suspended shops.

## Non-goals

- No change to the status vocabulary, badge styling, or `STATUS_LABELS` /
  `STATUS_BADGE` / `ORDER_STATUSES` maps — reuse them verbatim.
- No new store functions. `fetchMerchantOrders` (`select('*')`) and
  `setOrderStatus` (returns the updated row) already cover the data needs.
- No bulk actions, no server-side paging, no export.

## Existing patterns to follow

- `src/merchant/ProductsManager.tsx` — reference `DataTable` consumer:
  module-level `ColumnDef<any>[]`, handlers + `t` + `currency` passed via
  `table.options.meta`, `SortableHeader` for sortable columns.
- `src/components/ui/data-table.tsx` — `DataTable` (global search, client
  pagination, sortable) and `SortableHeader`.
- `src/components/ui/sheet.tsx` — `Sheet`, `SheetContent`, `SheetHeader`,
  `SheetTitle`, `SheetDescription`.

## Design

### Table

`DataTable` columns (left → right):

| Column   | Source          | Notes |
|----------|-----------------|-------|
| Order #  | `order_number`  | sortable (`SortableHeader`), oxblood heading font |
| Time     | `created_at`    | sortable; `fmtTime` (existing short date+time). Sort on the raw ISO via `accessorFn`, not the formatted string |
| Customer | `customer_name` | plain text (no WA link here — avoids nested-click conflict) |
| Total    | `total`         | sortable, right-aligned, `formatMoney(total, currency)` |
| Mode     | `mode`          | plain text |
| Status   | `status`        | read-only `Badge` from `STATUS_BADGE` / `STATUS_LABELS` |

- Global search box via `searchPlaceholder` (e.g. "Search orders…").
- Client pagination, `pageSize={15}`.
- Whole row opens the detail Sheet. Add an optional
  `onRowClick?: (row: TData) => void` prop to the shared `DataTable`
  primitive and attach it to `TableRow` (with `cursor-pointer` + hover). This
  is a small, reusable addition to `data-table.tsx` — cleaner than per-cell
  `onClick` hacks, and leaves other consumers untouched (prop is optional).
  `OrdersView` passes `onRowClick={setSelected}`.

### Detail Sheet

Opens with the selected order; `open` bound to `selected !== null`,
`onOpenChange` clears `selected`.

Content, top → bottom (each row shown only when its value is present):

- **Header:** `order_number` · `fmtTime(created_at)` · status `Badge`.
- **Customer:** `customer_name`; `customer_wa` as a `wa.me/<digits>` link
  (existing link styling).
- **Items:** full list, one line per item, `qty × name` and per-line price.
- **Totals:** `total` (bold); `shipping_fee` when set.
- **Meta:** `mode`, `region`, `address`, `preferred_date`, `note`, `awb`.
- **Status control:** the existing `<select>` (label + chevron styling),
  `value={selected.status}`. On change → `setOrderStatus(id, status)`, then
  patch that order in local `orders` state with the returned row so the badge,
  table cell, and sheet all update without a refetch. Hidden when `readOnly`.

### States

- **Loading** (`orders === null`): keep the existing `SkeletonText` block.
- **Empty** (`orders.length === 0`): rely on `DataTable`'s `emptyText`
  ("No orders yet.") — drop the current bespoke empty `<div>`.

### Component shape

Single `OrdersView.tsx`:

- Module level: `columns`, `itemsSummary`, `fmtTime`, the status maps, and an
  `OrderTableMeta` type (`{ t, currency, onSelect }`).
- Inside the component: `orders` state, `selected` state, `reload` /
  `handleStatusChange`, the `meta` object, `<DataTable>`, and the `<Sheet>`.
- Preserve the `readOnly` prop and both call sites (`Dashboard.tsx`,
  `SuspendedScreen.tsx`).

## Testing

Run-and-verify per repo convention (UI is not component-tested): load the
merchant dashboard against the seeded `demo-bakery` orders and confirm sort,
search, pagination, row → Sheet, and a status change persisting after reload.
Any extracted pure helper (e.g. a total/line formatter) can get a small unit
test alongside the existing `src/*.test.ts`, but no new pure logic is required.
