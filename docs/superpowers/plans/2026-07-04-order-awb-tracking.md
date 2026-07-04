# Order AWB Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a merchant record courier + AWB on a delivery order, and let the customer look the order up on a public page and deep-link to the courier's tracking site.

**Architecture:** Add a `courier` column to `orders` (the `awb` column exists). A pure `couriers.ts` catalog maps courier codes → tracking-URL builders. The merchant enters courier+AWB in the order drawer (persisted via `setOrderTracking`). Customers read a non-PII subset through a security-definer `track_order` RPC (guests can't read `orders` directly), surfaced on a new public `/s/:slug/track` page. Shared status label/badge is extracted so both the merchant table and the track page reuse it.

**Tech Stack:** React 19 + TypeScript, `@tanstack/react-table` (unaffected), Supabase Postgres + RLS + security-definer RPC, Vitest, Tailwind.

## Global Constraints

- Frontend: TypeScript strict, `moduleResolution: bundler` (extensionless relative imports). Backend migrations: SQL under `apps/backend/supabase/migrations/`.
- Every user-facing string goes through `t(en, zh)` from `useSession()`.
- UI verified by run-and-verify (running the app), not component tests. Pure modules DO get Vitest unit tests (`src/**/*.test.{ts,tsx}`, `environment: node`).
- Adding a migration file does not apply it — run `pnpm --filter @bitetime/backend db:migrate` (local) so PostgREST sees new columns/functions.
- RPCs follow the house pattern: `security definer`, `set search_path = public`, `grant execute ... to anon, authenticated` (see `redeem_voucher`, `next_order_number`).
- The `track_order` RPC returns ONLY non-PII columns: `status, mode, courier, awb, created_at`. Never name/phone/address/items/total.
- AWB entry is offered for `mode === 'delivery'` only; `pickup`/`sameday` unaffected.
- Courier tracking-URL templates MUST be verified against each courier's live site during Task 2.
- Merchant writes use the existing `orders_update_merchant` RLS policy (same path as `setOrderStatus`). No new store functions beyond those named here.

---

### Task 1: Migration — `courier` column + `track_order` RPC

**Files:**
- Create: `apps/backend/supabase/migrations/20260704140000_order_courier_and_track.sql`

**Interfaces:**
- Produces: `orders.courier text` (nullable); RPC `public.track_order(p_merchant uuid, p_order_number text)` returning `table(status text, mode text, courier text, awb text, created_at timestamptz)`, executable by `anon, authenticated`.

- [ ] **Step 1: Write the migration**

Create the file with:

```sql
-- Order courier + public tracking lookup.
-- `courier` holds a short code (jnt/poslaju/ninja/citylink/spx/flash/other) or null;
-- `awb` already exists. Guests cannot read `orders` (RLS is merchant-scoped), so the
-- customer-facing track page reads a non-PII subset through this security-definer RPC.
alter table public.orders add column if not exists courier text;

create or replace function public.track_order(p_merchant uuid, p_order_number text)
returns table (status text, mode text, courier text, awb text, created_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select o.status, o.mode, o.courier, o.awb, o.created_at
  from public.orders o
  where o.merchant_id = p_merchant
    and o.order_number = p_order_number
  limit 1;
$$;

grant execute on function public.track_order(uuid, text) to anon, authenticated;
```

- [ ] **Step 2: Apply it locally**

Run: `pnpm --filter @bitetime/backend db:migrate`
Expected: applies the new migration with no error.

- [ ] **Step 3: Verify the column and RPC exist**

Run:
```bash
docker exec -i supabase_db_bitetime-app psql -U postgres -d postgres -c "select column_name from information_schema.columns where table_name='orders' and column_name='courier';"
docker exec -i supabase_db_bitetime-app psql -U postgres -d postgres -c "select proname from pg_proc where proname='track_order';"
```
Expected: one row `courier`; one row `track_order`.

- [ ] **Step 4: Verify the RPC returns only non-PII columns for a seeded order**

Run (uses the seeded demo-bakery order DE-...-0053):
```bash
docker exec -i supabase_db_bitetime-app psql -U postgres -d postgres -c "select * from public.track_order((select id from public.merchants where slug='demo-bakery'), (select order_number from public.orders o join public.merchants m on m.id=o.merchant_id where m.slug='demo-bakery' limit 1));"
```
Expected: a single row with exactly the columns `status, mode, courier, awb, created_at` (no name/phone/address).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/supabase/migrations/20260704140000_order_courier_and_track.sql
git commit -m "feat(db): orders.courier column + track_order RPC"
```

---

### Task 2: Courier catalog (`couriers.ts`, pure + tested)

**Files:**
- Create: `apps/frontend/src/couriers.ts`
- Create: `apps/frontend/src/couriers.test.ts`

**Interfaces:**
- Produces:
  - `interface Courier { code: string; name: string; track: ((awb: string) => string) | null }`
  - `const COURIERS: Courier[]`
  - `function courierName(code: string | null | undefined): string` — `''` when unknown/null.
  - `function trackingUrl(code: string | null | undefined, awb: string | null | undefined): string | null` — null when courier is `other`/unknown or awb is blank.

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/couriers.test.ts`. Assertions are behavioural (not exact URL strings) so verified templates can be tuned without breaking tests:

```ts
import { describe, it, expect } from 'vitest'
import { COURIERS, courierName, trackingUrl } from './couriers'

describe('couriers', () => {
  it('has an "other" fallback with no tracking URL', () => {
    const other = COURIERS.find(c => c.code === 'other')
    expect(other).toBeTruthy()
    expect(other!.track).toBeNull()
  })

  it('trackingUrl builds an https link containing the AWB for a known courier', () => {
    const url = trackingUrl('ninja', 'ABC123456')
    expect(url).not.toBeNull()
    expect(url!.startsWith('https://')).toBe(true)
    expect(url!).toContain('ABC123456')
  })

  it('trackingUrl url-encodes the AWB', () => {
    const url = trackingUrl('ninja', 'A B/C')
    expect(url!).toContain(encodeURIComponent('A B/C'))
  })

  it('trackingUrl returns null for other/unknown courier or blank awb', () => {
    expect(trackingUrl('other', 'ABC')).toBeNull()
    expect(trackingUrl('nope', 'ABC')).toBeNull()
    expect(trackingUrl(null, 'ABC')).toBeNull()
    expect(trackingUrl('ninja', '')).toBeNull()
    expect(trackingUrl('ninja', '   ')).toBeNull()
    expect(trackingUrl('ninja', null)).toBeNull()
  })

  it('courierName round-trips known codes and is empty for unknown/null', () => {
    expect(courierName('ninja')).toBe('Ninja Van')
    expect(courierName('other')).toBeTruthy()
    expect(courierName('nope')).toBe('')
    expect(courierName(null)).toBe('')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @bitetime/frontend test -- couriers`
Expected: FAIL — cannot resolve `./couriers`.

- [ ] **Step 3: Verify each courier tracking URL against its live site**

Before writing templates, confirm each courier's public tracking URL format by loading it (WebFetch or a browser) with a sample AWB. Adjust the templates in Step 4 to whatever actually resolves to a tracking page. If a courier's site cannot be confirmed, set its `track` to a best-effort template and note it in the report — do NOT invent a nonexistent path silently. Couriers to confirm: J&T MY, Pos Laju, Ninja Van MY, City-Link, SPX (Shopee), Flash Express MY.

- [ ] **Step 4: Write the implementation**

Create `apps/frontend/src/couriers.ts`. The templates below are starting points — replace any that Step 3 shows are wrong:

```ts
// Courier catalog: display name + public tracking-URL builder per courier code.
// The stored `orders.courier` holds one of these codes (or null). `other` covers
// couriers without a supported deep-link — the customer sees the AWB but no link.
export interface Courier {
  code: string
  name: string
  track: ((awb: string) => string) | null
}

export const COURIERS: Courier[] = [
  { code: 'jnt',      name: 'J&T Express',   track: (awb) => `https://www.jtexpress.my/index/query/gzquery.html?bills=${encodeURIComponent(awb)}` },
  { code: 'poslaju',  name: 'Pos Laju',      track: (awb) => `https://track.pos.com.my/postal/quick-tracking?trackingNo=${encodeURIComponent(awb)}` },
  { code: 'ninja',    name: 'Ninja Van',     track: (awb) => `https://www.ninjavan.co/en-my/tracking?id=${encodeURIComponent(awb)}` },
  { code: 'citylink', name: 'City-Link',     track: (awb) => `https://www.citylinkexpress.com/tracking-result/?track=${encodeURIComponent(awb)}` },
  { code: 'spx',      name: 'Shopee Express', track: (awb) => `https://spx.com.my/track?tracking_number=${encodeURIComponent(awb)}` },
  { code: 'flash',    name: 'Flash Express', track: (awb) => `https://www.flashexpress.my/fle/tracking?se=${encodeURIComponent(awb)}` },
  { code: 'other',    name: 'Other',         track: null },
]

const BY_CODE = new Map(COURIERS.map(c => [c.code, c]))

export function courierName(code: string | null | undefined): string {
  if (!code) return ''
  return BY_CODE.get(code)?.name ?? ''
}

export function trackingUrl(code: string | null | undefined, awb: string | null | undefined): string | null {
  if (!code || !awb || !awb.trim()) return null
  const courier = BY_CODE.get(code)
  if (!courier || !courier.track) return null
  return courier.track(awb.trim())
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @bitetime/frontend test -- couriers`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/couriers.ts apps/frontend/src/couriers.test.ts
git commit -m "feat(frontend): courier catalog with tracking-URL builders"
```

---

### Task 3: Store functions — `setOrderTracking` + `fetchOrderTracking`

**Files:**
- Modify: `apps/frontend/src/store.ts` (after `setOrderNote`, ~line 476)

**Interfaces:**
- Consumes: the `track_order` RPC (Task 1); the `supabase` client already imported in `store.ts`.
- Produces:
  - `setOrderTracking(orderId: string, courier: string | null, awb: string): Promise<any>` — returns the updated order row.
  - `fetchOrderTracking(merchantId: string, orderNumber: string): Promise<{ status: string; mode: string; courier: string | null; awb: string | null; created_at: string } | null>`

- [ ] **Step 1: Add both functions**

Insert directly after the existing `setOrderNote` function in `apps/frontend/src/store.ts`:

```ts
export async function setOrderTracking(orderId: string, courier: string | null, awb: string) {
  const trimmed = awb.trim()
  const { data, error } = await supabase
    .from('orders')
    .update({ courier: courier || null, awb: trimmed || null })
    .eq('id', orderId).select().single()
  if (error) throw error
  return data
}

export async function fetchOrderTracking(merchantId: string, orderNumber: string) {
  const trimmed = orderNumber.trim()
  if (!merchantId || !trimmed) return null
  const { data, error } = await supabase
    .rpc('track_order', { p_merchant: merchantId, p_order_number: trimmed })
  if (error || !data || !data.length) return null
  return data[0] as { status: string; mode: string; courier: string | null; awb: string | null; created_at: string }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @bitetime/frontend typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/store.ts
git commit -m "feat(frontend): setOrderTracking + fetchOrderTracking store fns"
```

---

### Task 4: Merchant tracking entry in the order drawer

**Files:**
- Modify: `apps/frontend/src/merchant/OrdersView.tsx`

**Interfaces:**
- Consumes: `COURIERS`, `trackingUrl`, `courierName` from `../couriers` (Task 2); `setOrderTracking` from `../store` (Task 3); the existing `Input` shadcn component; the existing `patchOrder`, `LBL`, `SELECT_CLS`, `CHEVRON_SVG`, `Section` in this file.

- [ ] **Step 1: Add imports**

In `apps/frontend/src/merchant/OrdersView.tsx`, add `setOrderTracking` to the store import and add the couriers + Input imports. Change:

```tsx
import { fetchMerchantOrders, setOrderStatus, setOrderNote } from '../store'
```
to:
```tsx
import { fetchMerchantOrders, setOrderStatus, setOrderNote, setOrderTracking } from '../store'
```
And add, next to the other `@/components/ui` imports:
```tsx
import { Input } from '@/components/ui/input'
import { COURIERS, trackingUrl, courierName } from '../couriers'
```

- [ ] **Step 2: Add tracking draft state + save handler + dirty flag**

Add state next to the note state (after the `savingNote` line):

```tsx
  const [courierDraft, setCourierDraft] = useState('')
  const [awbDraft, setAwbDraft] = useState('')
  const [savingTrack, setSavingTrack] = useState(false)
```

Extend the per-order reset block (the `if (selected && selected.id !== noteFor)` block) to also re-seed the tracking drafts:

```tsx
  if (selected && selected.id !== noteFor) {
    setNoteFor(selected.id)
    setNoteDraft(selected.note ?? '')
    setCourierDraft(selected.courier ?? '')
    setAwbDraft(selected.awb ?? '')
  }
```

Add the save handler after `handleNoteSave`:

```tsx
  function handleTrackingSave() {
    if (!selected) return
    setSavingTrack(true)
    setOrderTracking(selected.id, courierDraft || null, awbDraft).then(updated => {
      patchOrder(updated)
      toast.success(t('Tracking saved', '物流已保存'))
    }).catch(() => {
      toast.error(t('Could not save tracking.', '无法保存物流。'))
    }).finally(() => setSavingTrack(false))
  }
```

Add the dirty flag next to `noteDirty`:

```tsx
  const trackDirty = selected != null &&
    (courierDraft !== (selected.courier ?? '') || awbDraft.trim() !== (selected.awb ?? ''))
```

- [ ] **Step 3: Make the Fulfilment AWB row read-only-only, and show courier there too**

Replace the Fulfilment AWB row so it only renders when the editable section is NOT shown (i.e. suspended view or non-delivery), and add a courier name row alongside it. Change:

```tsx
                  {selected.awb && <DetailRow label={t('AWB', '运单号')}>{selected.awb}</DetailRow>}
```
to:
```tsx
                  {!(selected.mode === 'delivery' && !readOnly) && selected.courier && (
                    <DetailRow label={t('Courier', '快递公司')}>{courierName(selected.courier) || selected.courier}</DetailRow>
                  )}
                  {!(selected.mode === 'delivery' && !readOnly) && selected.awb && (
                    <DetailRow label={t('AWB', '运单号')}>{selected.awb}</DetailRow>
                  )}
```

- [ ] **Step 4: Add the editable Delivery tracking section**

Insert this section immediately after the closing `</Section>` of the Fulfilment section (before the `{/* Note ... */}` comment):

```tsx
                {/* Delivery tracking — merchant enters courier + AWB (delivery orders only) */}
                {selected.mode === 'delivery' && !readOnly && (
                  <Section title={t('Delivery tracking', '物流追踪')}>
                    <div className="flex flex-col gap-1">
                      <label className={LBL} htmlFor={`courier-${selected.id}`}>{t('Courier', '快递公司')}</label>
                      <select
                        id={`courier-${selected.id}`}
                        className={SELECT_CLS}
                        style={{ backgroundImage: CHEVRON_SVG, backgroundPosition: 'right 10px center' }}
                        value={courierDraft}
                        onChange={e => setCourierDraft(e.target.value)}
                      >
                        <option value="">{t('Select courier…', '选择快递…')}</option>
                        {COURIERS.map(c => (
                          <option key={c.code} value={c.code}>{c.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className={LBL} htmlFor={`awb-${selected.id}`}>{t('AWB / Tracking no.', '运单号')}</label>
                      <Input
                        id={`awb-${selected.id}`}
                        value={awbDraft}
                        onChange={e => setAwbDraft(e.target.value)}
                        placeholder={t('e.g. 630123456789', '例如 630123456789')}
                        className="text-[13px] bg-cream border-clay-border"
                      />
                    </div>
                    {trackingUrl(courierDraft, awbDraft) && (
                      <a
                        href={trackingUrl(courierDraft, awbDraft)!}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[13px] text-oxblood font-medium hover:underline w-fit"
                      >
                        {t('Preview track link →', '预览追踪链接 →')}
                      </a>
                    )}
                    <Button
                      type="button"
                      size="none"
                      className="self-end rounded-pill py-[6px] px-[14px] text-[13px]"
                      disabled={!trackDirty || savingTrack}
                      onClick={handleTrackingSave}
                    >
                      {savingTrack ? t('Saving…', '保存中…') : t('Save tracking', '保存物流')}
                    </Button>
                  </Section>
                )}
```

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm --filter @bitetime/frontend typecheck && pnpm --filter @bitetime/frontend lint`
Expected: typecheck PASS; lint 0 errors (pre-existing warnings only).

- [ ] **Step 6: Run-and-verify (merchant)**

Run `pnpm dev`, log in as the merchant, open a **delivery** order in the drawer:
1. A "Delivery tracking" section shows a Courier select + AWB input.
2. Pick a courier + type an AWB → "Preview track link →" appears and points at the courier site.
3. Save → toast; reload the page, reopen the order → courier + AWB persisted.
4. Open a **pickup** order → no Delivery tracking section (only the read-only Fulfilment rows).

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/merchant/OrdersView.tsx
git commit -m "feat(merchant): courier + AWB entry on delivery orders"
```

---

### Task 5: Shared status module + public track page + route

**Files:**
- Create: `apps/frontend/src/orderStatus.tsx`
- Create: `apps/frontend/src/store/TrackOrder.tsx`
- Modify: `apps/frontend/src/merchant/OrdersView.tsx` (import shared status defs, remove local copies)
- Modify: `apps/frontend/src/AppRouter.tsx` (nested `track` route)

**Interfaces:**
- Consumes: `fetchOrderTracking` (Task 3); `courierName`, `trackingUrl` (Task 2); `useMerchant`, `useSession`.
- Produces: `apps/frontend/src/orderStatus.tsx` exporting `ORDER_STATUSES: string[]`, `STATUS_LABELS`, `STATUS_BADGE`, and `StatusBadge({ status, t }): JSX.Element`; default-export `TrackOrder` component.

- [ ] **Step 1: Create the shared status module**

Create `apps/frontend/src/orderStatus.tsx` by moving the status constants + `StatusBadge` verbatim out of `OrdersView.tsx`:

```tsx
import { Badge } from '@/components/ui/badge'

export const ORDER_STATUSES = ['new', 'preparing', 'ready', 'completed', 'cancelled']

export const STATUS_LABELS: Record<string, { en: string; zh: string }> = {
  new:       { en: 'New',       zh: '新订单' },
  preparing: { en: 'Preparing', zh: '备料中' },
  ready:     { en: 'Ready',     zh: '已备好' },
  completed: { en: 'Completed', zh: '已完成' },
  cancelled: { en: 'Cancelled', zh: '已取消' },
}

type BadgeConfig = { variant?: 'infoBlue' | 'danger'; className?: string }
export const STATUS_BADGE: Record<string, BadgeConfig> = {
  new:       { variant: 'infoBlue' },
  preparing: { className: 'bg-warn-bg-alt text-warn-fg-alt border-transparent' },
  ready:     { className: 'bg-success-bg-soft text-success-deep border-transparent' },
  completed: { className: 'bg-prep-bg-alt text-prep-fg-alt border-transparent' },
  cancelled: { className: 'bg-danger-bg text-danger-fg border-transparent' },
}

export function StatusBadge({ status, t }: { status: string; t: (en: string, zh: string) => string }) {
  const badge = STATUS_BADGE[status] ?? { variant: 'infoBlue' as const }
  return (
    <Badge variant={badge.variant} className={badge.className}>
      {t(STATUS_LABELS[status]?.en ?? status, STATUS_LABELS[status]?.zh ?? status)}
    </Badge>
  )
}
```

- [ ] **Step 2: Refactor `OrdersView.tsx` to import from the shared module**

In `apps/frontend/src/merchant/OrdersView.tsx`:
- Delete the local `ORDER_STATUSES`, `STATUS_LABELS`, `STATUS_BADGE`, `type BadgeConfig`, and the local `StatusBadge` function (now in `orderStatus.tsx`).
- Remove the now-unused `import { Badge } from '@/components/ui/badge'` line (Badge is only used by `StatusBadge`, which moved). If any other reference to `Badge` remains in the file, keep the import.
- Add: `import { ORDER_STATUSES, STATUS_LABELS, StatusBadge } from '../orderStatus'`

- [ ] **Step 3: Typecheck the refactor**

Run: `pnpm --filter @bitetime/frontend typecheck`
Expected: PASS. (Confirms `OrdersView` still resolves `ORDER_STATUSES`/`STATUS_LABELS`/`StatusBadge` from the new module and no stale `Badge` reference remains.)

- [ ] **Step 4: Create the TrackOrder page**

Create `apps/frontend/src/store/TrackOrder.tsx`:

```tsx
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMerchant } from '../MerchantContext'
import { useSession } from '../SessionContext'
import { fetchOrderTracking } from '../store'
import { courierName, trackingUrl } from '../couriers'
import { StatusBadge } from '../orderStatus'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import LanguageSelect from '../components/LanguageSelect'

type Tracking = { status: string; mode: string; courier: string | null; awb: string | null; created_at: string }

export default function TrackOrder() {
  const { merchant } = useMerchant()
  const { t } = useSession()
  const [orderNo, setOrderNo] = useState('')
  const [result, setResult] = useState<Tracking | 'notfound' | null>(null)
  const [loading, setLoading] = useState(false)

  if (!merchant) return null

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const normalized = orderNo.trim().toUpperCase()
    if (!normalized) return
    setLoading(true)
    setResult(null)
    fetchOrderTracking(merchant!.id, normalized)
      .then(r => setResult(r ?? 'notfound'))
      .catch(() => setResult('notfound'))
      .finally(() => setLoading(false))
  }

  const link = result && result !== 'notfound' ? trackingUrl(result.courier, result.awb) : null

  return (
    <div className="form-wrap pt-8 pb-12">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-8 max-[480px]:flex-col max-[480px]:gap-2">
        <div>
          <h1 className="font-heading text-[26px] font-medium text-oxblood tracking-[0.3px]">{merchant.name}</h1>
          <p className="font-heading text-[13px] italic text-rose-muted mt-[5px]">{t('Track your order', '追踪订单')}</p>
        </div>
        <div className="flex justify-end flex-shrink-0 max-[480px]:justify-start">
          <LanguageSelect />
        </div>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-3 mb-6">
        <label className="text-[11px] font-medium text-oxblood uppercase tracking-[0.09em]" htmlFor="track-order-no">
          {t('Order number', '订单号')}
        </label>
        <Input
          id="track-order-no"
          value={orderNo}
          onChange={e => setOrderNo(e.target.value)}
          placeholder={t('e.g. FA-260704-0053', '例如 FA-260704-0053')}
          className="font-mono"
        />
        <Button type="submit" size="none" className="self-start rounded-pill py-[8px] px-[18px] text-[14px]" disabled={loading || !orderNo.trim()}>
          {loading ? t('Checking…', '查询中…') : t('Track', '追踪')}
        </Button>
      </form>

      {result === 'notfound' && (
        <p className="text-[14px] text-rose-muted italic py-4 text-center">
          {t('No order found with that number.', '找不到该订单号。')}
        </p>
      )}

      {result && result !== 'notfound' && (
        <div className="bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-5 flex flex-col gap-3">
          <div className="flex items-center gap-[10px] flex-wrap">
            <span className="font-mono text-[15px] text-oxblood">{orderNo.trim().toUpperCase()}</span>
            <StatusBadge status={result.status || 'new'} t={t} />
          </div>
          {result.courier && (
            <div className="text-[13px] text-ink">
              <span className="text-rose-muted">{t('Courier', '快递公司')}: </span>
              {courierName(result.courier) || result.courier}
            </div>
          )}
          {result.awb ? (
            <div className="text-[13px] text-ink">
              <span className="text-rose-muted">{t('AWB', '运单号')}: </span>
              <span className="font-mono">{result.awb}</span>
            </div>
          ) : (
            <p className="text-[13px] text-rose-muted italic">
              {t('No tracking number yet — check back once your order ships.', '暂无运单号 — 订单发货后再来查看。')}
            </p>
          )}
          {link && (
            <a href={link} target="_blank" rel="noopener noreferrer"
               className="text-[14px] text-oxblood font-medium hover:underline w-fit">
              {t('Track parcel →', '查看包裹 →')}
            </a>
          )}
          {result.awb && !link && (
            <p className="text-[12px] text-rose-muted">
              {t('Search this number on your courier’s website to track.', '请到快递公司官网查询此运单号。')}
            </p>
          )}
        </div>
      )}

      <Link to={`/s/${merchant.slug}`} className="text-[13px] text-rose-muted underline mt-6 inline-block">
        {t('← Back to shop', '← 返回店铺')}
      </Link>
    </div>
  )
}
```

- [ ] **Step 5: Wire the nested route in `AppRouter.tsx`**

Add the lazy import next to the other surfaces (after the `Storefront` lazy line):

```tsx
const TrackOrder = lazy(() => import('./store/TrackOrder'))
```

In `StorefrontShell`, replace the final `return <Storefront />` with nested routes:

```tsx
  return (
    <Routes>
      <Route index element={<Storefront />} />
      <Route path="track" element={<TrackOrder />} />
    </Routes>
  )
```

(`Routes` and `Route` are already imported at the top of `AppRouter.tsx`.)

- [ ] **Step 6: Typecheck + lint + build**

Run: `pnpm --filter @bitetime/frontend typecheck && pnpm --filter @bitetime/frontend lint && pnpm --filter @bitetime/frontend build`
Expected: typecheck PASS, lint 0 errors, build succeeds.

- [ ] **Step 7: Run-and-verify (customer)**

With `pnpm dev` running and a delivery order that has courier + AWB saved (from Task 4):
1. Visit `/s/<slug>/track`, enter that order number → status badge + courier + AWB + working "Track parcel →" link.
2. Enter a nonexistent number → "No order found with that number."
3. Enter an order with no AWB yet → shows status + "No tracking number yet" message.
4. Confirm the merchant order table (`/merchant`) still renders and status badges are unchanged after the shared-module refactor.

- [ ] **Step 8: Commit**

```bash
git add apps/frontend/src/orderStatus.tsx apps/frontend/src/store/TrackOrder.tsx apps/frontend/src/merchant/OrdersView.tsx apps/frontend/src/AppRouter.tsx
git commit -m "feat(storefront): public order track page + shared status module"
```

---

### Task 6: Storefront entry points to the track page

**Files:**
- Modify: `apps/frontend/src/store/Storefront.tsx`

**Interfaces:**
- Consumes: `Link` from `react-router-dom`; `merchant.slug` (already in scope via `useMerchant`).

- [ ] **Step 1: Import `Link`**

Add to the imports at the top of `apps/frontend/src/store/Storefront.tsx`:

```tsx
import { Link } from 'react-router-dom'
```

- [ ] **Step 2: Add a track link on the success/confirmation view**

In the success view, replace the "Place another order" button block:

```tsx
            <button type="button" className="text-[13px] text-rose-muted cursor-pointer underline mt-5 inline-block" onClick={handleReset}>
              {t('Place another order', '再下一单')}
            </button>
```
with a stacked pair (track link + place-another):

```tsx
            <div className="flex flex-col items-center gap-2 mt-5">
              <Link to={`/s/${merchant.slug}/track`} className="text-[13px] text-oxblood font-medium underline">
                {t('Track your order', '追踪订单')}
              </Link>
              <button type="button" className="text-[13px] text-rose-muted cursor-pointer underline inline-block" onClick={handleReset}>
                {t('Place another order', '再下一单')}
              </button>
            </div>
```

- [ ] **Step 3: Add a track link in the order-form header**

In the order-form header, after the "Powered by BiteTime" paragraph:

```tsx
              <p className="font-heading text-[13px] italic text-rose-muted mt-[5px]">
                {t('Powered by BiteTime', 'BiteTime 提供技术支持')}
              </p>
```
add a track link:

```tsx
              <Link to={`/s/${merchant.slug}/track`} className="text-[12px] text-oxblood underline mt-1 inline-block">
                {t('Track an order', '追踪订单')}
              </Link>
```

- [ ] **Step 4: Typecheck + build**

Run: `pnpm --filter @bitetime/frontend typecheck && pnpm --filter @bitetime/frontend build`
Expected: PASS / build succeeds.

- [ ] **Step 5: Run-and-verify**

With `pnpm dev`: on a storefront, the header shows "Track an order" → clicks to `/s/<slug>/track`. Place an order → the confirmation screen shows "Track your order" linking to the same page.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/store/Storefront.tsx
git commit -m "feat(storefront): track-order links on storefront + confirmation"
```

---

## Self-Review

**Spec coverage:**
- Schema `courier` column — Task 1. ✓
- Courier catalog + tracking URLs + tests — Task 2. ✓
- `setOrderTracking` / `fetchOrderTracking` — Task 3. ✓
- `track_order` security-definer RPC, non-PII only, anon grant — Task 1. ✓
- Merchant courier+AWB entry, delivery-only, `!readOnly`, optimistic patch + toast, preview link — Task 4. ✓
- Read-only AWB/courier for suspended/non-delivery — Task 4 Step 3. ✓
- Public `/s/:slug/track` nested route + page, status badge + courier + AWB + deep-link, not-found + no-AWB messages — Task 5. ✓
- Shared status label/badge reuse (spec's "extract if cleanly reusable") — Task 5 (`orderStatus.tsx`). ✓
- Entry points: confirmation link + storefront link — Task 6. ✓
- Order number normalized (trim/upper) before lookup — Task 3 (`fetchOrderTracking` trims) + Task 5 (`toUpperCase`). ✓

**Placeholder scan:** No TBD/TODO. The one deferred item — exact courier URLs — is a concrete Task 2 Step 3 verification action with best-effort defaults and behavioural tests, not a code placeholder.

**Type consistency:** `setOrderTracking(orderId, courier: string|null, awb: string)` defined in Task 3, called with `(selected.id, courierDraft || null, awbDraft)` in Task 4. `fetchOrderTracking(merchantId, orderNumber)` returns `{status,mode,courier,awb,created_at}|null`, consumed as `Tracking | 'notfound'` in Task 5. `courierName`/`trackingUrl`/`COURIERS` signatures (Task 2) match all call sites (Tasks 4, 5). `StatusBadge({status,t})` / `ORDER_STATUSES` / `STATUS_LABELS` defined in `orderStatus.tsx` (Task 5) match the `OrdersView` imports after refactor and the `TrackOrder` usage. RPC param names `p_merchant`/`p_order_number` (Task 1) match `fetchOrderTracking`'s `.rpc(...)` args (Task 3).
