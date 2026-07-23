# Customer Search + Order History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add name/WhatsApp search to the merchant Customers tab and a per-customer order-history drawer that drills into full order detail.

**Architecture:** No backend change — `fetchMerchantCustomers` already loads every order client-side, so it keeps each customer's orders. The order-detail `<Sheet>` is extracted out of `OrdersView` into a shared `OrderDetailSheet` component so both Orders and Customers render the identical detail. Search + drawer are client-side in `CustomersView`.

**Tech Stack:** React 19, Vite, TypeScript, Tailwind, shadcn `Sheet`/`Input`, Vitest.

## Global Constraints

- Frontend is TypeScript, `moduleResolution: bundler` → extensionless relative imports. shadcn UI imported via `@/components/ui/*`.
- Every user-facing string is `t(en, zh)` — `t` from `useSession()`. No i18n library.
- Money is `formatMoney(amount, order.currency ?? merchant.currency)` from `../currency`. Never hardcode `RM`.
- UI is verified by **running the app** (run-and-verify via the `verify` skill), not component tests (per CLAUDE.md). Only pure logic / `store.ts` functions get Vitest unit tests.
- Frontend tests: `pnpm --filter @bitetime/frontend test`. Typecheck: `pnpm typecheck`. Lint: `pnpm lint`.

---

### Task 1: `fetchMerchantCustomers` keeps each customer's orders

Add `orders: Order[]` (newest-first) and a stable `key` to each aggregated customer. Same single fetch; the loop pushes orders instead of only counting.

**Files:**
- Modify: `apps/frontend/src/store.ts:773-784`
- Test: `apps/frontend/src/store.test.ts:1049-1093` (extend existing `describe`)

**Interfaces:**
- Consumes: `fetchMerchantOrders(merchantId)` (unchanged).
- Produces: `fetchMerchantCustomers(merchantId): Promise<Array<{ key: string; name: string; wa: string | null; orderCount: number; lastOrder: string; orders: Order[] }>>` — each `orders` newest-first. `key` = `wa || name || '—'`.

- [ ] **Step 1: Write the failing test**

Add inside the existing `describe('fetchMerchantCustomers', …)` block in `apps/frontend/src/store.test.ts` (after the last `it`, before the closing `})` at line 1093):

```ts
  it('keeps each customer\'s orders newest-first and a stable key', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const orders = [
      { id: 'o1', customer_name: 'Alice', customer_wa: '601', created_at: '2025-01-01' },
      { id: 'o3', customer_name: 'Alice', customer_wa: '601', created_at: '2025-01-03' },
      { id: 'o2', customer_name: 'Bob',   customer_wa: '602', created_at: '2025-01-02' },
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => orders }))

    const result = await fetchMerchantCustomers('m1')

    const alice = result.find(c => c.wa === '601')!
    expect(alice.key).toBe('601')
    expect(alice.orders.map((o: any) => o.id)).toEqual(['o3', 'o1']) // newest-first
    const bob = result.find(c => c.wa === '602')!
    expect(bob.orders.map((o: any) => o.id)).toEqual(['o2'])
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bitetime/frontend test -- store.test.ts -t "keeps each customer"`
Expected: FAIL — `alice.key` is `undefined` and `alice.orders` is `undefined`.

- [ ] **Step 3: Implement**

Replace `apps/frontend/src/store.ts:773-784` with:

```ts
export async function fetchMerchantCustomers(merchantId: string) {
  const orders = await fetchMerchantOrders(merchantId)
  const byWa = new Map()
  for (const o of orders) {
    const key = o.customer_wa || o.customer_name || '—'
    const cur = byWa.get(key) || { key, name: o.customer_name, wa: o.customer_wa, orderCount: 0, lastOrder: o.created_at, orders: [] }
    cur.orderCount += 1
    cur.orders.push(o)
    if (o.created_at > cur.lastOrder) cur.lastOrder = o.created_at
    byWa.set(key, cur)
  }
  // Newest-first within each customer — the drawer lists them top-down.
  for (const c of byWa.values()) {
    c.orders.sort((a: any, b: any) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
  }
  return [...byWa.values()]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @bitetime/frontend test -- store.test.ts -t "fetchMerchantCustomers"`
Expected: PASS — all four `fetchMerchantCustomers` tests green (the three existing + new one).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/store.ts apps/frontend/src/store.test.ts
git commit -m "feat(customers): fetchMerchantCustomers keeps per-customer orders"
```

---

### Task 2: Extract `OrderDetailSheet` from `OrdersView`

Move the order-detail `<Sheet>` (currently `OrdersView.tsx:235-443`) into a self-contained component so `CustomersView` can reuse it. Pure move — behaviour unchanged. Verified by running the Orders tab and confirming the detail sheet works exactly as before.

**Files:**
- Create: `apps/frontend/src/merchant/OrderDetailSheet.tsx`
- Modify: `apps/frontend/src/merchant/OrdersView.tsx`

**Interfaces:**
- Produces: `OrderDetailSheet(props: { order: any | null; onClose: () => void; onOrderUpdated: (o: any) => void; readOnly?: boolean }): JSX.Element` — open when `order` is non-null; owns its own note/courier/awb draft state and status/note/tracking save handlers, each calling `onOrderUpdated(updated)` after the `store.ts` mutation resolves.
- Consumes: `setOrderStatus`, `setOrderNote`, `setOrderTracking` from `../store`.

- [ ] **Step 1: Create `OrderDetailSheet.tsx`**

Create `apps/frontend/src/merchant/OrderDetailSheet.tsx`. Move into it, **verbatim from `OrdersView.tsx`**:
- the imports it needs: `useState`, `toast` (sonner), `Button`, `Textarea`, `Input`, the `Sheet`/`SheetContent`/`SheetHeader`/`SheetTitle` group, `formatMoney`, `formatAddress`, `formatCalendarDate`, `formatTaxRate`, `COURIERS`/`trackingUrl`/`courierName`, `ORDER_STATUSES`/`STATUS_LABELS`/`StatusBadge`, `fulfilmentLabel`, `useSession`, and the store mutations `setOrderStatus`/`setOrderNote`/`setOrderTracking`
- the module-level constants `LBL`, `SELECT_CLS`, `CHEVRON_SVG`, and `fmtTime` (used only by the sheet)
- the `DetailRow` and `Section` helper components (`OrdersView.tsx:127-147`)

Component shape:

```tsx
export default function OrderDetailSheet({
  order,
  onClose,
  onOrderUpdated,
  readOnly = false,
}: {
  order: any | null
  onClose: () => void
  onOrderUpdated: (o: any) => void
  readOnly?: boolean
}) {
  const { t, lang, merchant } = useSession()
  const [noteDraft, setNoteDraft] = useState('')
  const [drawerFor, setDrawerFor] = useState<string | undefined>(undefined)
  const [savingNote, setSavingNote] = useState(false)
  const [courierDraft, setCourierDraft] = useState('')
  const [awbDraft, setAwbDraft] = useState('')
  const [savingTrack, setSavingTrack] = useState(false)

  // Re-seed drafts when a different order opens (adjust-state-during-render, keyed on id).
  if (order && order.id !== drawerFor) {
    setDrawerFor(order.id)
    setNoteDraft(order.note ?? '')
    setCourierDraft(order.courier ?? '')
    setAwbDraft(order.awb ?? '')
  }

  function handleStatusChange(o: any, status: string) {
    setOrderStatus(o.id, status, merchant!.id).then(onOrderUpdated).catch(() => {
      toast.error(t('Could not update order status.', '无法更新订单状态。'))
    })
  }

  function handleNoteSave() {
    if (!order) return
    setSavingNote(true)
    setOrderNote(order.id, noteDraft, merchant!.id).then(updated => {
      onOrderUpdated(updated)
      toast.success(t('Note saved', '备注已保存'))
    }).catch(() => {
      toast.error(t('Could not save note.', '无法保存备注。'))
    }).finally(() => setSavingNote(false))
  }

  function handleTrackingSave() {
    if (!order) return
    setSavingTrack(true)
    setOrderTracking(order.id, courierDraft || null, awbDraft, merchant!.id).then(updated => {
      onOrderUpdated(updated)
      toast.success(t('Tracking saved', '物流已保存'))
    }).catch(() => {
      toast.error(t('Could not save tracking.', '无法保存物流。'))
    }).finally(() => setSavingTrack(false))
  }

  const orderCurrency = order?.currency ?? merchant?.currency
  const noteDirty = order != null && noteDraft.trim() !== (order.note ?? '')
  const trackDirty = order != null &&
    (courierDraft !== (order.courier ?? '') || awbDraft.trim() !== (order.awb ?? ''))

  return (
    <Sheet open={order !== null} onOpenChange={open => { if (!open) { onClose(); setDrawerFor(undefined) } }}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        {order && (
          <>
            {/* … MOVE the entire inner JSX from OrdersView.tsx:238-441 here … */}
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
```

For the moved inner JSX (`OrdersView.tsx:238-441`), apply exactly these renames (the only changes):
- every `selected` → `order`
- `setSelected(null)` / drawer-close is already handled by `onOpenChange` above — no other close call exists in that block

Nothing else in the JSX changes — the `readOnly` references, all helpers, and all field reads stay identical.

- [ ] **Step 2: Rewire `OrdersView.tsx`**

In `apps/frontend/src/merchant/OrdersView.tsx`:

1. Delete the now-moved code: the `Sheet` import group (lines 16-18), the `LBL`/`SELECT_CLS`/`CHEVRON_SVG` constants (24-32), `fmtTime` (34-38), `DetailRow`/`Section` (127-147), and the entire `<Sheet>…</Sheet>` block (235-443). Delete the imports that are now only used by the sheet: `Button`, `Textarea`, `Input`, `formatAddress`, `formatTaxRate`, `COURIERS`/`trackingUrl`/`courierName`, `ORDER_STATUSES`/`STATUS_LABELS`, `toast`. Keep `formatMoney`, `formatCalendarDate`, `StatusBadge`, `fulfilmentLabel` — the DataTable columns still use them.
2. Delete the now-unused drawer state: `noteDraft`, `drawerFor`, `savingNote`, `courierDraft`, `awbDraft`, `savingTrack` (lines 153-158), the re-seed block (167-172), and `handleStatusChange`/`handleNoteSave`/`handleTrackingSave` and the `noteDirty`/`trackDirty`/`orderCurrency` locals (179-211). Keep `selected`/`setSelected` and `patchOrder`.
3. Add import: `import OrderDetailSheet from './OrderDetailSheet'`.
4. Replace the deleted `<Sheet>` block with:

```tsx
      <OrderDetailSheet
        order={selected}
        onClose={() => setSelected(null)}
        onOrderUpdated={patchOrder}
        readOnly={readOnly}
      />
```

- [ ] **Step 3: Typecheck, lint, build**

Run: `pnpm typecheck && pnpm lint && pnpm --filter @bitetime/frontend build`
Expected: all pass, no unused-import errors. If lint flags an unused import in `OrdersView.tsx`, delete it (it moved to the sheet).

- [ ] **Step 4: Run-and-verify the Orders tab**

Use the `verify` skill: sign in as a merchant with orders, open the Orders tab, click an order. Confirm the detail sheet opens with items/totals/fulfilment; change status, save a note, save tracking (on a delivery order) — each persists and toasts. Confirm the suspended-shop view (`SuspendedScreen`) still shows the read-only detail (no editors).
Expected: identical behaviour to before the extraction.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/merchant/OrderDetailSheet.tsx apps/frontend/src/merchant/OrdersView.tsx
git commit -m "refactor(merchant): extract OrderDetailSheet from OrdersView"
```

---

### Task 3: Search + order-history drawer in `CustomersView`

Replace `CustomersView.tsx` with the full version below: a search input, clickable rows opening a customer drawer, an order-history list, and a stacked `OrderDetailSheet`.

**Files:**
- Modify: `apps/frontend/src/merchant/CustomersView.tsx` (full replace)

**Interfaces:**
- Consumes: `fetchMerchantCustomers` (Task 1 shape, with `key`/`orders`), `OrderDetailSheet` (Task 2), `formatMoney`, `StatusBadge`, shadcn `Input`/`Sheet`.

- [ ] **Step 1: Replace `CustomersView.tsx`**

Overwrite `apps/frontend/src/merchant/CustomersView.tsx` with:

```tsx
import { useEffect, useState } from 'react'
import { useSession } from '../SessionContext'
import { fetchMerchantCustomers } from '../store'
import { SkeletonText } from '../components/Loaders'
import { formatMoney } from '../currency'
import { StatusBadge } from '../orderStatus'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import OrderDetailSheet from './OrderDetailSheet'

function fmtDate(iso: string | null | undefined) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-MY', { dateStyle: 'medium' })
}

// Self-contained panel — pixel-match of .admin-panel
const PANEL = 'bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-5 mb-8 w-full box-border'

// Table header cell — pixel-match of .mm-customers-table th
const TH = 'text-[10px] font-semibold uppercase tracking-[0.08em] text-oxblood px-[14px] py-[10px] border-b-[1.5px] border-rose-border text-left whitespace-nowrap'

// Table data cell (base) — pixel-match of .mm-customers-table td + hover
const TD = 'px-[14px] py-[12px] border-b border-surface-warm-alt text-ink align-middle group-hover:bg-oxblood-tint'

// Count cell — pixel-match of .mm-customers-count overrides
const TD_COUNT = 'px-[14px] py-[12px] border-b border-surface-warm-alt text-oxblood font-semibold text-center align-middle group-hover:bg-oxblood-tint'

function WaLink({ wa }: { wa: string }) {
  return (
    <a
      href={`https://wa.me/${wa.replace(/\D/g, '')}`}
      target="_blank"
      rel="noopener noreferrer"
      onClick={e => e.stopPropagation()} // don't open the customer drawer
      className="text-oxblood no-underline font-medium hover:underline"
    >
      {wa}
    </a>
  )
}

export default function CustomersView() {
  const { t, merchant } = useSession()
  const [customers, setCustomers] = useState<any[] | null>(null)
  const [query, setQuery] = useState('')
  const [selectedCustomer, setSelectedCustomer] = useState<any | null>(null)
  const [selectedOrder, setSelectedOrder] = useState<any | null>(null)

  useEffect(() => {
    fetchMerchantCustomers(merchant!.id).then(setCustomers)
  }, [merchant!.id])

  // A status/note/tracking save inside the stacked order detail must reflect in the
  // drawer's list AND the master aggregate, so a re-open shows the new value.
  function handleOrderUpdated(updated: any) {
    const patch = (o: any) => (o.id === updated.id ? updated : o)
    setCustomers(prev => prev?.map(c => ({ ...c, orders: c.orders?.map(patch) })) ?? prev)
    setSelectedCustomer((cur: any) => (cur ? { ...cur, orders: cur.orders?.map(patch) } : cur))
    setSelectedOrder((cur: any) => (cur && cur.id === updated.id ? updated : cur))
  }

  if (customers === null) {
    return <div className={PANEL}><SkeletonText lines={4} /></div>
  }

  if (customers.length === 0) {
    return (
      <div className={`${PANEL} text-center text-rose-muted text-sm`}>
        <p>{t('No customers yet.', '暂无顾客。')}</p>
      </div>
    )
  }

  const q = query.trim().toLowerCase()
  const qDigits = q.replace(/\D/g, '')
  const filtered = customers.filter(c => {
    if (!q) return true
    const nameHit = (c.name || '').toLowerCase().includes(q)
    const waHit = qDigits !== '' && (c.wa || '').replace(/\D/g, '').includes(qDigits)
    return nameHit || waHit
  })

  return (
    <>
      <div className="mb-4">
        <Input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t('Search by name or WhatsApp…', '按姓名或 WhatsApp 搜索…')}
          className="max-w-sm bg-cream border-clay-border text-[13px]"
        />
      </div>

      <div className="bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-0 mb-8 w-full box-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={TH}>{t('Name', '姓名')}</th>
                <th className={TH}>{t('WhatsApp', 'WhatsApp')}</th>
                <th className={TH}>{t('Orders', '订单数')}</th>
                <th className={TH}>{t('Last Order', '最近订单')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td className={`${TD} text-center text-rose-muted`} colSpan={4}>
                    {t(`No customers match “${query.trim()}”.`, `没有顾客匹配“${query.trim()}”。`)}
                  </td>
                </tr>
              ) : (
                filtered.map((c: any, i: number) => (
                  <tr
                    key={c.key || i}
                    onClick={() => setSelectedCustomer(c)}
                    className="group cursor-pointer [&:last-child>td]:border-b-0"
                  >
                    <td className={TD}>{c.name || '—'}</td>
                    <td className={TD}>{c.wa ? <WaLink wa={c.wa} /> : '—'}</td>
                    <td className={TD_COUNT}>{c.orderCount}</td>
                    <td className={TD}>{fmtDate(c.lastOrder)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Customer drawer — order history */}
      <Sheet open={selectedCustomer !== null} onOpenChange={open => { if (!open) setSelectedCustomer(null) }}>
        <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
          {selectedCustomer && (
            <>
              <SheetHeader className="border-b border-surface-sunken">
                <SheetTitle className="text-[15px]">{selectedCustomer.name || '—'}</SheetTitle>
                {selectedCustomer.wa && (
                  <span className="text-[13px]"><WaLink wa={selectedCustomer.wa} /></span>
                )}
                <span className="text-[12px] text-text-tertiary">
                  {t(`${selectedCustomer.orderCount} order${selectedCustomer.orderCount === 1 ? '' : 's'}`,
                     `${selectedCustomer.orderCount} 个订单`)}
                </span>
              </SheetHeader>

              <div className="flex flex-col gap-2 px-4 pb-4 pt-4">
                {selectedCustomer.orders.map((o: any) => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => setSelectedOrder(o)}
                    className="flex flex-col gap-1 w-full text-left rounded-lg border border-rose-border bg-cream px-3 py-2.5 hover:bg-oxblood-tint transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-heading text-[14px] font-medium text-oxblood">{o.order_number || '—'}</span>
                      <span className="tabular-nums text-[13px] font-medium text-ink">
                        {formatMoney(o.total, o.currency ?? merchant?.currency)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] text-text-tertiary">{fmtDate(o.created_at)}</span>
                      <StatusBadge status={o.status || 'new'} t={t} />
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Full order detail — stacked on top of the customer drawer */}
      <OrderDetailSheet
        order={selectedOrder}
        onClose={() => setSelectedOrder(null)}
        onOrderUpdated={handleOrderUpdated}
      />
    </>
  )
}
```

- [ ] **Step 2: Typecheck, lint, build**

Run: `pnpm typecheck && pnpm lint && pnpm --filter @bitetime/frontend build`
Expected: all pass.

- [ ] **Step 3: Run-and-verify the Customers tab**

Use the `verify` skill. Seed a shop with ≥2 customers, one with multiple orders. In the Customers tab:
- type part of a name → list narrows; clear → restores. Type WhatsApp digits (with and without separators) → matches. Type nonsense → "No customers match …" row.
- click a customer → drawer opens with their orders, newest-first, each showing number/date/status/total.
- click the WhatsApp link in a row → opens wa.me, does **not** open the drawer.
- click an order in the drawer → full order detail stacks on top. Change its status → the drawer's line reflects the new status. Close the detail → back to the customer drawer. Close that → back to the table.

Expected: all behaviours as described.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/merchant/CustomersView.tsx
git commit -m "feat(customers): search + order-history drawer with full order detail"
```

---

## Self-Review

- **Spec coverage:** search name+wa → Task 3 filter; order-history drawer → Task 3; full order detail reuse → Task 2 extraction + Task 3 stacked sheet; `orders` in aggregate → Task 1; stacked sheets → Task 3; no backend change → confirmed (no backend task). All spec sections mapped.
- **Type consistency:** `OrderDetailSheet` props `{ order, onClose, onOrderUpdated, readOnly? }` identical in Task 2 (produce), Task 2 OrdersView wiring, and Task 3 CustomersView. `fetchMerchantCustomers` `key`/`orders` from Task 1 consumed in Task 3. `onOrderUpdated`/`handleOrderUpdated` signatures match.
- **Placeholder scan:** Task 2 Step 1 references "MOVE the inner JSX from OrdersView.tsx:238-441" — this is an exact line range of existing repo code with explicit rename rules, not a placeholder. All new code shown in full.
- **readOnly:** `CustomersView` never passes `readOnly` (renders only in live Dashboard, not `SuspendedScreen`) — matches spec.
