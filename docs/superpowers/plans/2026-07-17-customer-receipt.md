# Printable Customer Receipt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in customer can open any order in their history and print or save a receipt for it.

**Architecture:** One new component, `ReceiptDialog`, rendered from data already in memory on the order-history screen — no route, no fetch, no backend call, no migration. It renders the order as a page-shaped document; a `Print` button calls `window.print()` and a `@media print` block in the global stylesheet drops the rest of the app so only the document reaches the paper. The customer's own browser does the print-to-PDF.

**Tech Stack:** React 19, TypeScript, Vite, Tailwind v4, Base UI dialog primitive (`@base-ui/react/dialog` via `src/components/ui/dialog.tsx`), Vitest (node environment — no jsdom, so no component tests).

**Spec:** `docs/superpowers/specs/2026-07-17-customer-receipt-design.md`

## Global Constraints

- **Currency is the order's, never the shop's current one.** Every money value on the receipt renders through `formatMoney(value, order.currency ?? merchant.currency)`. A receipt re-denominated by a later settings change is a forgery (`OrderHistory.tsx:143-145`).
- **Never key or dedupe order items by product id.** A split promo writes two lines sharing one id (`packages/shared/src/pricing.ts:136-155`). Key by array index; sum every entry.
- **`item.promo` may be absent** on rows written before that feature. Missing reads as `false` — `item.promo &&` handles this for free. Never crash on it.
- **Every string is bilingual:** `t(englishString, chineseString)`, from `useSession()`. No i18n library.
- **The expanded order-history row's existing behaviour does not change.** This work adds a surface; it does not modify the breakdown already rendered at `OrderHistory.tsx:170-213`.
- **Status and courier/AWB never appear on the receipt.** A printed page is a snapshot; status goes stale the moment it leaves the printer.
- **Frontend Vitest runs in `environment: 'node'`** (`apps/frontend/vitest.config.ts`). Tests here cover pure functions only. UI is verified by running the app (CLAUDE.md).
- Run all commands from the repo root. Frontend tests: `pnpm --filter @bitetime/frontend test`.

## Corrections to the spec

Three things surfaced while mapping the files. The plan below implements the corrected version; the spec's wording is superseded on these points.

1. **The spec's print rule `body > * { display: none }` would hide the receipt.** `DialogContent` renders through `DialogPortal` (`src/components/ui/dialog.tsx:19-21`), which mounts the dialog as a **direct child of `body`** — the selector would match the receipt itself. Task 5 uses the visibility technique instead (`body * { visibility: hidden }` + `[data-receipt], [data-receipt] * { visibility: visible }`), which is portal-agnostic because `visibility` inherits and a visible descendant still paints inside a hidden ancestor.
2. **The promo badge would print as invisible text.** It is `bg-oxblood` with `text-white` (`OrderHistory.tsx:184`); browsers drop backgrounds when printing, leaving white on white. Task 5 restyles it for print as a bordered chip with dark text.
3. **`formatOrderDate` is date-only and is shared with the guest `/track` screen** (`src/orderDate.ts`), so it cannot simply grow a time. Task 2 adds a sibling `formatOrderDateTime` in the same module, which is that module's stated purpose — one rule per order-date question, so the screens cannot drift.

## File Structure

| File | Responsibility |
|---|---|
| `apps/frontend/src/receipt.ts` (create) | Pure: sum an order's item lines into a subtotal |
| `apps/frontend/src/receipt.test.ts` (create) | Tests for the above |
| `apps/frontend/src/orderDate.ts` (modify) | Gains `formatOrderDateTime` beside `formatOrderDate` |
| `apps/frontend/src/orderDate.test.ts` (create) | Tests for the above |
| `apps/frontend/src/store/MoneyLine.tsx` (create) | The `Line` label/value row, shared by the row and the receipt |
| `apps/frontend/src/store/ReceiptDialog.tsx` (create) | The receipt document + its print button |
| `apps/frontend/src/store/OrderHistory.tsx` (modify) | Drops its private `Line`; gains the `Receipt` action + `receiptId` state |
| `apps/frontend/src/index.css` (modify) | The `@media print` block |

---

### Task 1: Subtotal from an order's item lines

The receipt states a subtotal; the `orders` table does not store one. It is summed back from the stored `items`, which reconciles with the stored `total` by construction — `pricing.ts:159-164` computes `subtotal = round2(Σ lineTotal)` then `total = round2(subtotal + shipping − discount)`.

**Files:**
- Create: `apps/frontend/src/receipt.ts`
- Test: `apps/frontend/src/receipt.test.ts`

**Interfaces:**
- Consumes: `OrderItem` from `src/types.ts` — `{ id: string; name?: string; qty: number; price?: number; promo?: boolean }`
- Produces: `receiptSubtotal(items: OrderItem[] | null | undefined): number`

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/receipt.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { receiptSubtotal } from './receipt'
import type { OrderItem } from './types'

const item = (over: Partial<OrderItem>): OrderItem => ({ id: 'p1', qty: 1, price: 0, ...over })

describe('receiptSubtotal', () => {
  it('is 0 for an order with no items', () => {
    expect(receiptSubtotal([])).toBe(0)
    expect(receiptSubtotal(null)).toBe(0)
    expect(receiptSubtotal(undefined)).toBe(0)
  })

  it('multiplies price by qty on a single line', () => {
    expect(receiptSubtotal([item({ price: 12.5, qty: 2 })])).toBe(25)
  })

  it('sums every line', () => {
    expect(receiptSubtotal([
      item({ id: 'a', price: 10, qty: 1 }),
      item({ id: 'b', price: 4.25, qty: 2 }),
    ])).toBe(18.5)
  })

  // A split promo writes TWO lines sharing one product id — 3 units at the promo
  // price plus 7 at the base price. Deduping by id here would undercharge the
  // printed subtotal against the stored total.
  it('counts both halves of a split promo separately', () => {
    expect(receiptSubtotal([
      item({ id: 'same', price: 5, qty: 3, promo: true }),
      item({ id: 'same', price: 8, qty: 7, promo: false }),
    ])).toBe(71)
  })

  it('treats a missing price or qty as zero rather than NaN', () => {
    expect(receiptSubtotal([item({ price: undefined, qty: 2 })])).toBe(0)
    expect(receiptSubtotal([{ id: 'p1' } as unknown as OrderItem])).toBe(0)
  })

  it('rounds to cents so the sum never shows float dust', () => {
    expect(receiptSubtotal([
      item({ id: 'a', price: 0.1, qty: 1 }),
      item({ id: 'b', price: 0.2, qty: 1 }),
    ])).toBe(0.3)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @bitetime/frontend test -- receipt.test.ts
```

Expected: FAIL — `Failed to resolve import "./receipt"`.

- [ ] **Step 3: Write the minimal implementation**

Create `apps/frontend/src/receipt.ts`:

```ts
import type { OrderItem } from './types'

// Cents, not float dust. A local twin of pricing.ts's private `round2` rather than an
// export from @bitetime/shared: that package holds rules that must hold identically on
// BOTH sides of the wire, and what a receipt prints is a display concern the browser
// alone answers.
const round2 = (n: number) => parseFloat(n.toFixed(2))

/**
 * An order's subtotal, summed back from its stored lines.
 *
 * `orders` persists `items`, `shipping_fee`, `discount` and `total` — never a subtotal. Summing
 * the lines is what makes the printed arithmetic close: `pricing.ts` builds the total FROM this
 * same sum (`subtotal = round2(Σ lineTotal)`, `total = round2(subtotal + shipping − discount)`),
 * so subtotal + fee − voucher = total on the page, by construction.
 *
 * Deriving it the other way — `total − shipping + discount` — would always reconcile with the
 * total while silently disagreeing with the lines printed directly above it. This way a data bug
 * shows up on the receipt instead of hiding inside it.
 *
 * Every entry counts: a split promo writes two lines under one product id.
 */
export function receiptSubtotal(items: OrderItem[] | null | undefined): number {
  if (!items) return 0
  return round2(items.reduce((sum, it) => sum + (it.price ?? 0) * (it.qty ?? 0), 0))
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @bitetime/frontend test -- receipt.test.ts
```

Expected: PASS — 6 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/receipt.ts apps/frontend/src/receipt.test.ts
git commit -m "feat(receipt): sum an order's subtotal back from its stored lines"
```

---

### Task 2: Order date with a time on it

The list row shows a date (`formatOrderDate`). A receipt states when the order was placed, to the minute. `formatOrderDate` is shared with the guest `/track` screen and must keep its current output, so this is a sibling in the same module — that module exists precisely so two screens cannot answer the same date question differently.

**Files:**
- Modify: `apps/frontend/src/orderDate.ts`
- Test: `apps/frontend/src/orderDate.test.ts` (create — the module has no tests today)

**Interfaces:**
- Consumes: `Lang` from `src/types.ts` (`'en' | 'zh'`)
- Produces: `formatOrderDateTime(iso: string | null | undefined, lang: Lang): string`

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/orderDate.test.ts`.

Note the assertions deliberately avoid pinning an exact string: `toLocaleString` renders in the machine's timezone, and a test that hard-codes `14:30` passes in Kuala Lumpur and fails in CI. What matters — that a time is present at all, and that bad input yields nothing rather than "Invalid Date" — is timezone-independent.

```ts
import { describe, it, expect } from 'vitest'
import { formatOrderDate, formatOrderDateTime } from './orderDate'

describe('formatOrderDateTime', () => {
  it('is empty for missing input', () => {
    expect(formatOrderDateTime(null, 'en')).toBe('')
    expect(formatOrderDateTime(undefined, 'en')).toBe('')
    expect(formatOrderDateTime('', 'en')).toBe('')
  })

  // "Invalid Date" on a receipt is worse than a blank — it looks like a system fault
  // where a blank just says nothing.
  it('is empty for an unparseable string', () => {
    expect(formatOrderDateTime('not-a-date', 'en')).toBe('')
  })

  it('carries the year and a wall-clock time', () => {
    const out = formatOrderDateTime('2026-07-14T06:30:00Z', 'en')
    expect(out).toContain('2026')
    expect(out).toMatch(/\d{1,2}:\d{2}/)
  })

  it('renders in Chinese when the language is zh', () => {
    const out = formatOrderDateTime('2026-07-14T06:30:00Z', 'zh')
    expect(out).toMatch(/[一-鿿]/)
  })

  // The date-only twin is unchanged and still time-free — /track and the history row
  // both depend on that.
  it('leaves formatOrderDate without a time', () => {
    expect(formatOrderDate('2026-07-14T06:30:00Z', 'en')).not.toMatch(/\d{1,2}:\d{2}/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @bitetime/frontend test -- orderDate.test.ts
```

Expected: FAIL — `formatOrderDateTime is not a function` (the `formatOrderDate` case passes).

- [ ] **Step 3: Write the minimal implementation**

Append to `apps/frontend/src/orderDate.ts`:

```ts
/**
 * The same fact, to the minute — what a receipt states and a list row does not.
 *
 * A sibling rather than an option on `formatOrderDate`, because that function's output is pinned
 * by two screens (order history and /track) that must keep showing a bare date.
 */
export function formatOrderDateTime(iso: string | null | undefined, lang: Lang): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @bitetime/frontend test -- orderDate.test.ts
```

Expected: PASS — 5 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/orderDate.ts apps/frontend/src/orderDate.test.ts
git commit -m "feat(receipt): add a to-the-minute order timestamp beside the date-only one"
```

---

### Task 3: Share the money-line row

`Line` is private to `OrderHistory.tsx` today. The receipt renders the same label-left/value-right money row, so it moves out. This task is a pure move — no behaviour changes, and the expanded row must render exactly as it did before.

**Files:**
- Create: `apps/frontend/src/store/MoneyLine.tsx`
- Modify: `apps/frontend/src/store/OrderHistory.tsx` (delete the local `Line` at lines 233-240; import instead)

**Interfaces:**
- Produces: `MoneyLine({ label, value }: { label: ReactNode; value: string })` — default export

- [ ] **Step 1: Create the shared component**

Create `apps/frontend/src/store/MoneyLine.tsx`:

```tsx
import type { ReactNode } from 'react'

/**
 * One money row: label left, value right. The order-history row and the printed receipt both
 * state the same facts (a line item, a delivery fee, a voucher), and they must state them in
 * the same shape — a receipt whose fee row is laid out unlike the screen's reads as a different
 * document about a different order.
 */
export default function MoneyLine({ label, value }: { label: ReactNode; value: string }) {
  return (
    <div className="flex justify-between items-start gap-2 text-sm text-rose-muted py-[3px]">
      <span className="shrink-0">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  )
}
```

- [ ] **Step 2: Delete the private `Line` from `OrderHistory.tsx`**

Remove this block entirely (currently lines 233-240):

```tsx
function Line({ label, value }: { label: ReactNode; value: string }) {
  return (
    <div className="flex justify-between items-start gap-2 text-sm text-rose-muted py-[3px]">
      <span className="shrink-0">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  )
}
```

- [ ] **Step 3: Import the shared one and rename its three call sites**

In `OrderHistory.tsx`, add the import beside the existing `AuthPanel` import (line 11):

```tsx
import MoneyLine from './MoneyLine'
```

`ReactNode` is now only used by the `Line` that just left, so drop it from the React import on line 1:

```tsx
import { useState, useEffect } from 'react'
```

Rename all three `<Line ... />` usages to `<MoneyLine ... />` — the item line (currently line 177), the delivery fee (line 197), and the voucher (line 200). Change nothing else about them.

- [ ] **Step 4: Verify nothing broke**

```bash
pnpm typecheck && pnpm lint && pnpm --filter @bitetime/frontend test
```

Expected: all three clean. `typecheck` catches a missed `<Line>` call site (`Cannot find name 'Line'`); `lint` catches the now-unused `ReactNode` import.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/store/MoneyLine.tsx apps/frontend/src/store/OrderHistory.tsx
git commit -m "refactor(receipt): lift the money row out of OrderHistory for reuse"
```

---

### Task 4: The receipt document

The dialog renders the order as a page-shaped document. It deliberately does **not** reuse the expanded row's markup: the row is list-shaped (truncation, hover, a tap target), the receipt is page-shaped, and one component serving both would satisfy neither.

Everything it prints is already in memory on this screen — `orders` came from `fetchMyOrdersAtShop`, `products` from `fetchProducts`, `merchant` from `useMerchant()`. No fetch, no route.

**Files:**
- Create: `apps/frontend/src/store/ReceiptDialog.tsx`
- Modify: `apps/frontend/src/store/OrderHistory.tsx`

**Interfaces:**
- Consumes:
  - `receiptSubtotal(items)` from `../receipt` (Task 1)
  - `formatOrderDateTime(iso, lang)` from `../orderDate` (Task 2)
  - `MoneyLine` from `./MoneyLine` (Task 3)
  - `formatMoney(amount, code)` from `../currency`; `formatAddress(addr)` from `../address`
  - `useSession()` → `{ t, lang }`; types `Order`, `OrderItem`, `Merchant` from `../types`. Not `Product` — the menu stays with the caller, which already holds it; this component takes the resolved `itemName` callback instead.
- Produces: `ReceiptDialog({ order, merchant, itemName, onClose }: ReceiptDialogProps)` — default export

- [ ] **Step 1: Write the component**

Create `apps/frontend/src/store/ReceiptDialog.tsx`:

```tsx
import { useSession } from '../SessionContext'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { formatMoney } from '../currency'
import { formatAddress } from '../address'
import { formatOrderDateTime } from '../orderDate'
import { receiptSubtotal } from '../receipt'
import MoneyLine from './MoneyLine'
import type { Merchant, Order, OrderItem } from '../types'

interface ReceiptDialogProps {
  order: Order
  merchant: Merchant
  /** The order's own item names, read back in the customer's language — owned by the caller,
      which already holds the menu this resolves against. */
  itemName: (item: OrderItem) => string
  onClose: () => void
}

/**
 * One order, as a document the customer can keep.
 *
 * The expanded history row already reconciles — it has stated the fee and the voucher since it
 * shipped. What it is not is a RECORD: it names no shop, no customer, no address, states no
 * subtotal, and cannot leave the screen. This can.
 *
 * Status and courier/AWB are deliberately absent. A print is a snapshot; status goes stale the
 * moment it leaves the printer, and a customer holding paper that says "preparing" about an
 * order delivered last week has been misinformed by us. Live status stays on the row, where it
 * can still change.
 *
 * `data-receipt` is the hook the print rules in index.css aim at — see the @media print block
 * there. It is load-bearing, not a test id.
 */
export default function ReceiptDialog({ order, merchant, itemName, onClose }: ReceiptDialogProps) {
  const { t, lang } = useSession()

  // The currency the order was PAID in, not the shop's current one — the same rule the history
  // row states. A receipt re-denominated by a later settings change would be a forgery.
  const currency = order.currency ?? merchant.currency
  const money = (n: number | null | undefined) => formatMoney(n, currency)

  const subtotal = receiptSubtotal(order.items)
  const shipping = order.shipping_fee ?? 0
  const discount = order.discount ?? 0
  const address = order.mode === 'delivery' ? formatAddress(order.address) : ''

  return (
    <Dialog open onOpenChange={(open: boolean) => { if (!open) onClose() }}>
      <DialogContent
        data-receipt
        showCloseButton={false}
        className="sm:max-w-md max-h-[85vh] overflow-y-auto gap-0 p-0"
      >
        <div className="p-5">
          {/* Shop name alone: `merchants` carries no address or phone, and inventing a
              header out of the payment fields — written to instruct payment BEFORE an
              order, not to identify a shop after it — would be worse than a plain name. */}
          <div className="border-b border-clay-border pb-3 mb-3">
            <h2 className="font-heading text-[18px] font-medium text-oxblood tracking-[0.3px]">
              {merchant.name}
            </h2>
            <p className="font-heading text-[12px] italic text-rose-muted mt-0.5">
              {t('Receipt', '收据')}
            </p>
          </div>

          <div className="text-[13px] text-rose-muted leading-[1.6] mb-4">
            <div className="font-mono text-ink">{order.order_number}</div>
            <div>{formatOrderDateTime(order.created_at, lang)}</div>
            {order.customer_name && <div className="mt-1.5 text-ink">{order.customer_name}</div>}
            {order.customer_wa && <div>{order.customer_wa}</div>}
            {/* Only a delivery has somewhere to go. A pickup order printing a blank
                address block would read as an order we lost the address for. */}
            {address && <div className="mt-1.5">{address}</div>}
          </div>

          <div className="border-t border-clay-border pt-3">
            {(order.items ?? []).map((item, n) => (
              // Index in the key, not the id: a split promo writes two lines sharing one
              // product id, and an id-only key would collapse them into one row while the
              // total below still charges for both.
              <MoneyLine
                key={`${item.id ?? item.name}-${n}`}
                label={
                  <span className="inline-flex items-center gap-1.5 min-w-0">
                    <span>{itemName(item)} × {item.qty}</span>
                    {/* Rows written before the promo split lack the key; undefined is falsy. */}
                    {item.promo && (
                      <span
                        data-receipt-promo
                        className="shrink-0 px-1.5 py-0.5 rounded-full bg-oxblood text-white text-[10px] leading-[14px] font-medium"
                      >
                        {t('Promo', '优惠')}
                      </span>
                    )}
                  </span>
                }
                value={money((item.price ?? 0) * (item.qty ?? 0))}
              />
            ))}
          </div>

          {/* Subtotal is stated here and nowhere else in the app: it is what closes the
              arithmetic on a page that has to stand on its own — subtotal + fee − voucher
              = total, every term printed. */}
          <div className="border-t border-clay-border mt-2 pt-2">
            <MoneyLine label={t('Subtotal', '小计')} value={money(subtotal)} />
            {shipping > 0 && (
              <MoneyLine label={t('Delivery fee', '送货费')} value={money(shipping)} />
            )}
            {discount > 0 && (
              <MoneyLine
                label={`${t('Voucher', '优惠券')}${order.voucher_code ? ` (${order.voucher_code})` : ''}`}
                value={`−${money(discount)}`}
              />
            )}
          </div>

          <div className="flex justify-between items-start gap-2 text-[15px] font-medium text-ink border-t border-rose-border mt-2 pt-2">
            <span className="shrink-0">
              {order.mode === 'delivery' ? t('Delivery', '送货') : t('Pickup', '自取')}
            </span>
            <span className="text-right">{money(order.total)}</span>
          </div>
        </div>

        {/* data-receipt-actions: the print rules hide this. Paper does not need a Print button. */}
        <div
          data-receipt-actions
          className="flex justify-end gap-2 border-t border-clay-border bg-surface-sunken p-4 rounded-b-lg"
        >
          <Button variant="outline" onClick={onClose}>
            {t('Close', '关闭')}
          </Button>
          <Button onClick={() => window.print()}>
            {t('Print', '打印')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Wire it into `OrderHistory.tsx`**

Add the import beside the others (after the `MoneyLine` import from Task 3):

```tsx
import ReceiptDialog from './ReceiptDialog'
```

Add state beside `expandedId` (currently line 39):

```tsx
const [receiptId, setReceiptId] = useState<string | null>(null)
```

Inside the expanded block, replace the total row (currently lines 205-210) with the total row plus the action — the `Receipt` action sits beside the total, where a customer's eye already is:

```tsx
<div className="flex justify-between items-start gap-2 text-[14px] font-medium text-ink border-t border-rose-border mt-2 pt-2">
  <span className="shrink-0">
    {o.mode === 'delivery' ? t('Delivery', '送货') : t('Pickup', '自取')}
  </span>
  <span className="text-right">{formatMoney(o.total, currency)}</span>
</div>
<button
  type="button"
  onClick={() => setReceiptId(id)}
  className="text-[13px] text-oxblood underline underline-offset-2 cursor-pointer mt-2"
>
  {t('View receipt', '查看收据')}
</button>
```

Then render the dialog. Put it inside the `orders.map` callback, immediately after the closing `)}` of the `{expanded && (...)}` block and before the row's closing `</div>` — it belongs to the row whose id it names:

```tsx
{receiptId === id && (
  <ReceiptDialog
    order={o}
    merchant={merchant}
    itemName={itemName}
    onClose={() => setReceiptId(null)}
  />
)}
```

- [ ] **Step 3: Verify it compiles and nothing regressed**

```bash
pnpm typecheck && pnpm lint && pnpm --filter @bitetime/frontend test
```

Expected: all clean.

- [ ] **Step 4: Verify on screen**

Per CLAUDE.md, UI is verified by running the app. Use the `verify` skill, or by hand: `pnpm dev`, sign in as a customer at a shop with at least one order, open `/s/<slug>/orders`, expand a row, click **View receipt**.

Confirm on screen:
- Shop name and `Receipt` heading
- Order number, date **with a time**
- Customer name and WhatsApp number
- Delivery address on a delivery order; **no address block at all** on a pickup order
- Every item line, promo badge included, with the subtotal beneath them
- `subtotal + delivery fee − voucher` equals the printed total
- Close and Print buttons; Close dismisses; the underlying row is untouched

Do not click Print yet — print styling is Task 5.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/store/ReceiptDialog.tsx apps/frontend/src/store/OrderHistory.tsx
git commit -m "feat(receipt): a per-order receipt document in customer order history"
```

---

### Task 5: Make it print

The document exists; now only it may reach the paper.

**Why `visibility` and not `display`:** `DialogContent` renders through `DialogPortal` (`src/components/ui/dialog.tsx:19-21`), which mounts it as a **direct child of `body`**. So `body > * { display: none }` would hide the receipt along with everything else. `visibility` inherits and a visible descendant still paints inside a hidden ancestor — which makes it portal-agnostic: it does not matter where in the tree the dialog lands.

**Files:**
- Modify: `apps/frontend/src/index.css` (append; the file ends at line 235 with the `.dark` block)

- [ ] **Step 1: Append the print rules**

Add to the end of `apps/frontend/src/index.css`:

```css
/* ─── Printing a receipt ──────────────────────────────────────────────────────
   The receipt dialog is the only thing in this app that is meant to reach paper.
   These rules exist so that when a customer prints one, they get the document and
   not the shop's order history with a modal on top of it.

   `visibility`, not `display: none`: the dialog is PORTALED to <body> by the Base UI
   primitive, so a `body > *` rule would hide the receipt itself. Visibility inherits
   and a visible descendant still paints inside a hidden ancestor, so this works no
   matter where in the tree the portal lands. */
@media print {
  body * {
    visibility: hidden;
  }

  [data-receipt],
  [data-receipt] * {
    visibility: visible;
  }

  /* Out of the modal's centred-overlay geometry and into normal page flow, or the
     receipt prints as a floating card cropped to one viewport. */
  [data-receipt] {
    position: absolute;
    top: 0;
    left: 0;
    transform: none;
    width: 100%;
    max-width: 100%;
    max-height: none;
    overflow: visible;
    border: 0;
    border-radius: 0;
    box-shadow: none;
    background: #fff;
    color: #000;
  }

  /* Paper does not need a Print button. */
  [data-receipt-actions] {
    display: none;
  }

  /* The badge is bg-oxblood + text-white on screen; browsers drop backgrounds when
     printing, which would leave white text on white paper — a promo line that silently
     loses the word "Promo" and keeps its discounted price. A bordered chip survives a
     printer that honours no colour at all. */
  [data-receipt-promo] {
    background: transparent !important;
    color: #000 !important;
    border: 1px solid #000;
  }
}
```

- [ ] **Step 2: Verify by printing**

```bash
pnpm dev
```

Open a receipt as in Task 4, click **Print**, and inspect the OS print preview:

- The page shows **only** the receipt — no order-history rows, no page header, no nav, no dark backdrop
- No Print or Close button on the page
- The `Promo` badge is legible: dark text in a bordered chip, not white-on-white
- The receipt starts at the top of the page and is not cropped
- A long order (enough items to overflow one page) flows onto page 2 rather than being cut off

Cancel the print dialog; nothing is saved.

- [ ] **Step 3: Verify the screen is unaffected**

Still in the browser, confirm the on-screen dialog looks exactly as it did at the end of Task 4 — the rules are inside `@media print` and must not touch it.

- [ ] **Step 4: Run the full check**

```bash
pnpm typecheck && pnpm lint && pnpm --filter @bitetime/frontend test && pnpm build
```

Expected: all clean.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/index.css
git commit -m "feat(receipt): print only the receipt, and print it legibly"
```

---

## Out of scope

Carried from the spec, restated so no task drifts into them: tax-invoice fields (SST number, invoice serial, tax breakdown); merchant address/phone columns and the dashboard UI to fill them; server-side PDF generation or storage; a per-order route; receipts for guest orders; emailing the receipt.
