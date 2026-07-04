# Merchant Orders DataTable + Detail Sheet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `OrdersView` stacked-card list with a sortable/searchable `DataTable` whose rows open a right-hand detail `Sheet` where status is edited.

**Architecture:** Add an optional `onRowClick` to the shared `DataTable` primitive (Task 1). Rewrite `OrdersView.tsx` to feed orders through `DataTable` with module-level column defs (handlers/`t`/currency on `table.options.meta`, matching `ProductsManager`), and render a `Sheet` for the selected order with the editable status control (Task 2). Reuse the existing status maps and store functions verbatim.

**Tech Stack:** React 19, TypeScript, `@tanstack/react-table` v8, shadcn/base-ui `Sheet`, Tailwind.

## Global Constraints

- TypeScript, `strict: true`. Frontend uses `moduleResolution: bundler` — extensionless relative imports.
- Every user-facing string goes through `t(en, zh)` from `useSession()`.
- UI is verified by **run-and-verify** (run the app), not component tests — per `CLAUDE.md`. No new UI component tests.
- Reuse the existing `STATUS_LABELS`, `STATUS_BADGE`, `ORDER_STATUSES`, `LBL`, `SELECT_CLS`, `CHEVRON_SVG`, `itemsSummary`, `fmtTime` — do not restyle or rename them.
- Store functions are fixed: `fetchMerchantOrders(merchantId)` → `Order[]` (`select('*')`); `setOrderStatus(orderId, status)` → the updated row. No new store functions.
- Preserve the `readOnly?: boolean` prop and both call sites (`Dashboard.tsx`, `SuspendedScreen.tsx readOnly`).
- Money: `formatMoney(amount, currency)` from `../currency`; per-order currency is `order.currency ?? merchant?.currency`.

---

### Task 1: Add optional `onRowClick` to the `DataTable` primitive

**Files:**
- Modify: `apps/frontend/src/components/ui/data-table.tsx`

**Interfaces:**
- Produces: `DataTable` gains an optional prop `onRowClick?: (row: TData) => void`. When set, each `<TableRow>` calls it with `row.original` on click and gets `cursor-pointer` + hover styling. Optional → existing consumers (`ProductsManager`, `AdminMerchants`) are unaffected.

- [ ] **Step 1: Add the prop to the interface**

In `DataTableProps<TData, TValue>` add:

```tsx
  /** When set, clicking a row calls this with the row's original data. */
  onRowClick?: (row: TData) => void
```

- [ ] **Step 2: Destructure it in the function signature**

Add `onRowClick,` to the destructured props of `export function DataTable(...)` (next to `meta,`).

- [ ] **Step 3: Wire it onto the body `TableRow`**

Replace the populated-rows `TableRow` (the one inside `table.getRowModel().rows.map(...)`) with:

```tsx
              <TableRow
                key={row.id}
                onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                className={onRowClick ? 'cursor-pointer' : undefined}
              >
```

(The `<TableRow>` primitive already applies a hover background via its own styles, so `cursor-pointer` is the only affordance to add.)

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @bitetime/frontend typecheck`
Expected: PASS (no errors). Confirms the optional prop compiles and existing consumers still typecheck.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/components/ui/data-table.tsx
git commit -m "feat(ui): add optional onRowClick to DataTable"
```

---

### Task 2: Rewrite `OrdersView` as a DataTable with a detail Sheet

**Files:**
- Modify (full rewrite): `apps/frontend/src/merchant/OrdersView.tsx`

**Interfaces:**
- Consumes: `DataTable` + `onRowClick` (Task 1); `SortableHeader` from the same module; `Sheet`/`SheetContent`/`SheetHeader`/`SheetTitle` from `../components/ui/sheet`; `Badge`; `fetchMerchantOrders`, `setOrderStatus`; `formatMoney`; `useSession`.
- Produces: default-export `OrdersView({ readOnly }: { readOnly?: boolean })` — unchanged public shape, so both call sites keep working.

- [ ] **Step 1: Replace the file contents**

Overwrite `apps/frontend/src/merchant/OrdersView.tsx` with:

```tsx
import { useEffect, useState } from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { useSession } from '../SessionContext'
import { fetchMerchantOrders, setOrderStatus } from '../store'
import { formatMoney } from '../currency'
import { SkeletonText } from '../components/Loaders'
import { Badge } from '@/components/ui/badge'
import { DataTable, SortableHeader } from '@/components/ui/data-table'
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from '@/components/ui/sheet'

const ORDER_STATUSES = ['new', 'preparing', 'ready', 'completed', 'cancelled']

const STATUS_LABELS: Record<string, { en: string; zh: string }> = {
  new:       { en: 'New',       zh: '新订单' },
  preparing: { en: 'Preparing', zh: '备料中' },
  ready:     { en: 'Ready',     zh: '已备好' },
  completed: { en: 'Completed', zh: '已完成' },
  cancelled: { en: 'Cancelled', zh: '已取消' },
}

// Status → Badge config (unchanged from the card version).
type BadgeConfig = { variant?: 'infoBlue' | 'danger'; className?: string }
const STATUS_BADGE: Record<string, BadgeConfig> = {
  new:       { variant: 'infoBlue' },
  preparing: { className: 'bg-warn-bg-alt text-warn-fg-alt border-transparent' },
  ready:     { className: 'bg-success-bg-soft text-success-deep border-transparent' },
  completed: { className: 'bg-prep-bg-alt text-prep-fg-alt border-transparent' },
  cancelled: { className: 'bg-danger-bg text-danger-fg border-transparent' },
}

// 11px semibold uppercase rose-muted label.
const LBL = 'text-[11px] font-semibold uppercase tracking-[0.06em] text-rose-muted shrink-0'

// Self-contained select classes (pixel-match of .admin-field-select).
const SELECT_CLS =
  'w-full py-[7px] pl-[10px] pr-[32px] border border-clay-border rounded-sm text-[13px] ' +
  'bg-cream text-ink font-sans appearance-none bg-no-repeat cursor-pointer min-w-[140px] ' +
  'focus:outline-none focus:border-oxblood focus:shadow-[0_0_0_2px_rgba(122,16,40,0.1)]'

const CHEVRON_SVG = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%237A4F55' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E")`

function itemsSummary(items: any[] | null | undefined) {
  if (!items || !items.length) return '—'
  return items.map((i: any) => `${i.qty}× ${i.name}`).join(', ')
}

function fmtTime(iso: string | null | undefined) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString('en-MY', { dateStyle: 'short', timeStyle: 'short' })
}

function StatusBadge({ status, t }: { status: string; t: (en: string, zh: string) => string }) {
  const badge = STATUS_BADGE[status] ?? { variant: 'infoBlue' as const }
  return (
    <Badge variant={badge.variant} className={badge.className}>
      {t(STATUS_LABELS[status]?.en ?? status, STATUS_LABELS[status]?.zh ?? status)}
    </Badge>
  )
}

// Handlers + language + currency ride on table.options.meta so the column defs
// stay stable (defined once) and never reset sorting when the data refetches.
interface OrderTableMeta {
  t: (en: string, zh: string) => string
  currency?: string
  onSelect: (o: any) => void
}

const columns: ColumnDef<any>[] = [
  {
    accessorKey: 'order_number',
    header: ({ column, table }) => (
      <SortableHeader column={column} label={(table.options.meta as OrderTableMeta).t('Order #', '订单号')} />
    ),
    cell: ({ row }) => (
      <span className="font-heading text-[14px] font-medium text-oxblood whitespace-nowrap">
        {row.original.order_number || '—'}
      </span>
    ),
  },
  {
    accessorKey: 'created_at',
    header: ({ column, table }) => (
      <SortableHeader column={column} label={(table.options.meta as OrderTableMeta).t('Time', '时间')} />
    ),
    cell: ({ row }) => (
      <span className="whitespace-nowrap text-text-tertiary">{fmtTime(row.original.created_at)}</span>
    ),
  },
  {
    accessorKey: 'customer_name',
    header: ({ table }) => (
      <span>{(table.options.meta as OrderTableMeta).t('Customer', '顾客')}</span>
    ),
    cell: ({ row }) => <span>{row.original.customer_name || '—'}</span>,
  },
  {
    accessorKey: 'total',
    header: ({ column, table }) => (
      <div className="text-right">
        <SortableHeader column={column} label={(table.options.meta as OrderTableMeta).t('Total', '总计')} />
      </div>
    ),
    cell: ({ row, table }) => {
      const meta = table.options.meta as OrderTableMeta
      return (
        <div className="text-right whitespace-nowrap font-medium">
          {formatMoney(row.original.total, row.original.currency ?? meta.currency)}
        </div>
      )
    },
  },
  {
    accessorKey: 'mode',
    header: ({ table }) => (
      <span>{(table.options.meta as OrderTableMeta).t('Mode', '方式')}</span>
    ),
    cell: ({ row }) => <span>{row.original.mode || '—'}</span>,
  },
  {
    accessorKey: 'status',
    enableSorting: false,
    header: ({ table }) => (
      <span>{(table.options.meta as OrderTableMeta).t('Status', '状态')}</span>
    ),
    cell: ({ row, table }) => (
      <StatusBadge status={row.original.status || 'new'} t={(table.options.meta as OrderTableMeta).t} />
    ),
  },
]

// A labelled key/value line in the detail sheet — value hidden when empty.
function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 flex-wrap text-[13px] text-ink">
      <span className={LBL}>{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  )
}

export default function OrdersView({ readOnly = false }: { readOnly?: boolean } = {}) {
  const { t, merchant } = useSession()
  const [orders, setOrders] = useState<any[] | null>(null)
  const [selected, setSelected] = useState<any | null>(null)

  useEffect(() => {
    fetchMerchantOrders(merchant!.id).then(setOrders)
  }, [merchant!.id])

  function handleStatusChange(order: any, status: string) {
    setOrderStatus(order.id, status).then(updated => {
      setOrders(prev => (prev ? prev.map(o => (o.id === updated.id ? updated : o)) : prev))
      setSelected(cur => (cur && cur.id === updated.id ? updated : cur))
    })
  }

  const meta: OrderTableMeta = { t, currency: merchant?.currency, onSelect: setSelected }

  if (orders === null) {
    return (
      <div className="bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-5 mb-8 w-full box-border">
        <SkeletonText lines={4} />
      </div>
    )
  }

  return (
    <div className="bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-5 mb-8 w-full box-border">
      <DataTable
        columns={columns}
        data={orders}
        meta={meta}
        onRowClick={setSelected}
        pageSize={15}
        searchPlaceholder={t('Search orders…', '搜索订单…')}
        emptyText={t('No orders yet.', '暂无订单。')}
        prevLabel={t('Previous', '上一页')}
        nextLabel={t('Next', '下一页')}
      />

      <Sheet open={selected !== null} onOpenChange={open => { if (!open) setSelected(null) }}>
        <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
          {selected && (
            <>
              <SheetHeader className="border-b border-surface-sunken">
                <div className="flex items-center gap-[10px] flex-wrap">
                  <SheetTitle className="text-[15px]">{selected.order_number || '—'}</SheetTitle>
                  <StatusBadge status={selected.status || 'new'} t={t} />
                </div>
                <span className="text-[12px] text-text-tertiary">{fmtTime(selected.created_at)}</span>
              </SheetHeader>

              <div className="flex flex-col gap-[10px] px-4 pb-4">
                <DetailRow label={t('Customer', '顾客')}>
                  {selected.customer_name || '—'}
                  {selected.customer_wa && (
                    <>
                      {'  '}
                      <a
                        href={`https://wa.me/${selected.customer_wa.replace(/\D/g, '')}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-oxblood no-underline font-medium hover:underline"
                      >
                        {selected.customer_wa}
                      </a>
                    </>
                  )}
                </DetailRow>

                <DetailRow label={t('Items', '商品')}>{itemsSummary(selected.items)}</DetailRow>

                <DetailRow label={t('Total', '总计')}>
                  <strong>{formatMoney(selected.total, selected.currency ?? merchant?.currency)}</strong>
                </DetailRow>

                {selected.shipping_fee != null && (
                  <DetailRow label={t('Shipping', '运费')}>
                    {formatMoney(selected.shipping_fee, selected.currency ?? merchant?.currency)}
                  </DetailRow>
                )}

                <DetailRow label={t('Mode', '方式')}>{selected.mode || '—'}</DetailRow>
                {selected.region && <DetailRow label={t('Region', '地区')}>{selected.region}</DetailRow>}
                {selected.address && <DetailRow label={t('Address', '地址')}>{selected.address}</DetailRow>}
                {selected.preferred_date && (
                  <DetailRow label={t('Preferred date', '首选日期')}>{selected.preferred_date}</DetailRow>
                )}
                {selected.note && <DetailRow label={t('Note', '备注')}>{selected.note}</DetailRow>}
                {selected.awb && <DetailRow label={t('AWB', '运单号')}>{selected.awb}</DetailRow>}

                {!readOnly && (
                  <div className="flex flex-col gap-1 pt-[10px] border-t border-surface-sunken">
                    <label className={LBL} htmlFor={`status-${selected.id}`}>{t('Status', '状态')}</label>
                    <select
                      id={`status-${selected.id}`}
                      className={SELECT_CLS}
                      style={{ backgroundImage: CHEVRON_SVG, backgroundPosition: 'right 10px center' }}
                      value={selected.status || 'new'}
                      onChange={e => handleStatusChange(selected, e.target.value)}
                    >
                      {ORDER_STATUSES.map(s => (
                        <option key={s} value={s}>{t(STATUS_LABELS[s].en, STATUS_LABELS[s].zh)}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @bitetime/frontend typecheck`
Expected: PASS. (If `React.ReactNode` errors as undefined, add `import type { ReactNode } from 'react'` and use `ReactNode` in `DetailRow` — the plan uses the `React.` namespace which requires React types in scope; `@tanstack/react-table` already pulls them, but prefer the explicit `ReactNode` import if the checker complains.)

- [ ] **Step 3: Lint**

Run: `pnpm --filter @bitetime/frontend lint`
Expected: PASS (no new lint errors in `OrdersView.tsx`).

- [ ] **Step 4: Run-and-verify against seeded data**

Ensure sample orders exist (from `apps/backend/scripts/seed-sample-orders.sh`, merchant `demo-bakery`), then:

Run: `pnpm dev` (frontend :5173), log in as the `demo-bakery` merchant, open the Orders section.

Confirm:
1. Orders render in a table with columns Order # / Time / Customer / Total / Mode / Status; status shows as a coloured badge.
2. Clicking a column header (Order #, Time, Total) sorts; the search box filters (e.g. type a customer name).
3. With >15 orders the pager appears; ≤15 it does not.
4. Clicking a row opens the right-hand Sheet with full detail (customer + WA link, items, totals, mode/region/address/note/awb as present).
5. Changing Status in the Sheet updates the badge in both the Sheet and the table row immediately; reloading the page shows the new status persisted.
6. Empty case: a merchant with no orders shows "No orders yet." in the table body.

- [ ] **Step 5: Verify the read-only (suspended) path**

Confirm `SuspendedScreen` still renders (`<OrdersView readOnly />`): the table shows, the row opens the Sheet, and the Sheet shows **no** Status `<select>`.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/merchant/OrdersView.tsx
git commit -m "feat(merchant): orders DataTable with detail Sheet"
```

---

## Self-Review

**Spec coverage:**
- Table columns (Order #, Time, Customer, Total, Mode, Status) — Task 2 `columns`. ✓
- Global search, client pagination, sortable — `DataTable` props in Task 2 + `SortableHeader`. ✓
- Read-only status badge in table cell — `StatusBadge` in the `status` column. ✓
- Row click → Sheet — Task 1 `onRowClick` + Task 2 `onRowClick={setSelected}`. ✓
- Detail Sheet fields (customer/WA, items, totals, mode/region/address/preferred_date/note/awb) — Task 2 Sheet body, each guarded by presence. ✓
- Editable status in Sheet, patches local state, hidden when `readOnly` — `handleStatusChange` + `!readOnly` guard. ✓
- Loading skeleton kept; bespoke empty div dropped for `emptyText` — Task 2 render. ✓
- `readOnly` prop + both consumers preserved — signature unchanged. ✓
- Reuse status maps/store fns, no new store fns — imports unchanged. ✓

**Placeholder scan:** No TBD/TODO; all code is concrete.

**Type consistency:** `OrderTableMeta { t, currency, onSelect }` defined once and read via `table.options.meta as OrderTableMeta` in every column; `onRowClick(row: TData)` in Task 1 matches `onRowClick={setSelected}` (`setSelected: (o: any) => void`) in Task 2. `StatusBadge`/`DetailRow` defined before use. Store `setOrderStatus` returns the updated row → consumed as `updated` in `handleStatusChange`.
