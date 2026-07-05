# Postcode Autofill + Split Delivery Address Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the storefront delivery address into Line1 + Postcode + City + State, autofill City/State from a bundled Malaysia postcode dataset, and feed the resolved state into `priceOrder()` so delivery pricing becomes regional (WM/EM).

**Architecture:** A committed one-off generator turns the `malaysia-postcodes` package into a compact `postcode → "City|State"` JSON checked into the frontend. `lookupPostcode()` lazy-loads that JSON. The storefront delivery block becomes four fields; the postcode field triggers the lookup and prefills the (still-editable) City + State. The address is stored as a structured object in the `orders.address` column (migrated `text → jsonb`); a `formatAddress()` helper renders it wherever it's displayed (merchant order detail, Telegram).

**Tech Stack:** React 19 + Vite + TypeScript (frontend), Hono + TypeScript (backend), Supabase Postgres, Vitest.

## Global Constraints

- Whole codebase is TypeScript (`.ts`/`.tsx`), `strict: true`.
- Backend uses `NodeNext` module resolution — relative imports keep `.js` specifiers that resolve to `.ts` source. Frontend uses `bundler` resolution — extensionless relative imports.
- Every user-facing string uses `t(englishString, chineseString)` from `useSession()`. No i18n library.
- All Supabase access goes through `src/store.ts`. Shared domain types live in `src/types.ts`.
- Canonical East-Malaysia state strings, matched by `EM_STATES` in `src/pricing.ts`, are exactly: `'Sabah'`, `'Sarawak'`, `'W.P. Labuan'`. State values produced anywhere in this feature MUST match the canonical `MY_STATES` set (Task 2) verbatim.
- Adding a migration file does NOT apply it — run `pnpm --filter @bitetime/backend db:migrate` against local Supabase so PostgREST's schema cache sees the change.
- Run commands from the repo root; `turbo`/`pnpm --filter` target a workspace.
- Commit after each task.

---

### Task 1: `AddressParts` type + `formatAddress` (frontend)

Pure display helper and the shared type. No dataset, no UI — safe to land first.

**Files:**
- Modify: `apps/frontend/src/types.ts` (add `AddressParts` interface near `Order`, ~line 77)
- Create: `apps/frontend/src/address.ts`
- Test: `apps/frontend/src/address.test.ts`

**Interfaces:**
- Produces:
  - `interface AddressParts { line1: string; postcode: string; city: string; state: string }` (exported from `types.ts`)
  - `function formatAddress(addr: AddressParts | string | null | undefined): string` (exported from `address.ts`)

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/address.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { formatAddress } from './address'

describe('formatAddress', () => {
  it('joins a structured address, skipping empty parts', () => {
    expect(
      formatAddress({ line1: '12 Jalan Ceria', postcode: '43000', city: 'Kajang', state: 'Selangor' }),
    ).toBe('12 Jalan Ceria, 43000 Kajang, Selangor')
  })

  it('omits missing pieces without stray separators', () => {
    expect(formatAddress({ line1: '12 Jalan Ceria', postcode: '', city: '', state: 'Selangor' }))
      .toBe('12 Jalan Ceria, Selangor')
  })

  it('returns a legacy string address unchanged', () => {
    expect(formatAddress('12 Jalan Ceria, Kajang')).toBe('12 Jalan Ceria, Kajang')
  })

  it('returns empty string for nullish input', () => {
    expect(formatAddress(null)).toBe('')
    expect(formatAddress(undefined)).toBe('')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bitetime/frontend test -- address.test.ts`
Expected: FAIL — cannot resolve `./address` / `formatAddress` is not a function.

- [ ] **Step 3: Add the `AddressParts` type**

In `apps/frontend/src/types.ts`, immediately above `export interface Order {` (~line 77), add:

```ts
export interface AddressParts {
  line1: string
  postcode: string
  city: string
  state: string
}
```

- [ ] **Step 4: Write the helper**

Create `apps/frontend/src/address.ts`:

```ts
import type { AddressParts } from './types'

// Renders a delivery address for display. Accepts the new structured object
// or a legacy free-text string (orders placed before the split). Empty parts
// are dropped so there are no stray commas.
export function formatAddress(addr: AddressParts | string | null | undefined): string {
  if (!addr) return ''
  if (typeof addr === 'string') return addr
  const cityLine = [addr.postcode, addr.city].filter(Boolean).join(' ')
  return [addr.line1, cityLine, addr.state].filter(Boolean).join(', ')
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @bitetime/frontend test -- address.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/types.ts apps/frontend/src/address.ts apps/frontend/src/address.test.ts
git commit -m "feat(storefront): AddressParts type + formatAddress helper"
```

---

### Task 2: Canonical MY states + postcode dataset generator

Produces the checked-in dataset consumed by Task 3, plus the state list used by the generator and the UI.

**Files:**
- Create: `apps/frontend/src/states-my.ts`
- Create: `apps/frontend/scripts/gen-postcodes.ts`
- Create (generated, committed): `apps/frontend/src/postcodes-my.json`

**Interfaces:**
- Produces:
  - `MY_STATES: readonly string[]` (exported from `states-my.ts`) — the 16 canonical state names.
  - `postcodes-my.json` — a JSON object `{ [postcode5: string]: "City|State" }` where `State` is one of `MY_STATES`.

- [ ] **Step 1: Write the canonical state list**

Create `apps/frontend/src/states-my.ts`:

```ts
// Canonical Malaysian states / federal territories. The East-Malaysia three
// (Sabah, Sarawak, W.P. Labuan) MUST match EM_STATES in pricing.ts verbatim so
// regional shipping resolves. Used by the storefront State <select> and by the
// postcode-dataset generator to validate/normalise upstream state names.
export const MY_STATES = [
  'Johor',
  'Kedah',
  'Kelantan',
  'Melaka',
  'Negeri Sembilan',
  'Pahang',
  'Perak',
  'Perlis',
  'Pulau Pinang',
  'Sabah',
  'Sarawak',
  'Selangor',
  'Terengganu',
  'W.P. Kuala Lumpur',
  'W.P. Labuan',
  'W.P. Putrajaya',
] as const
```

- [ ] **Step 2: Write the generator**

Create `apps/frontend/scripts/gen-postcodes.ts`:

```ts
// One-off generator. NOT run at build time — run it manually to (re)produce
// src/postcodes-my.json, which is committed.
//
// Source: the `malaysia-postcodes` npm package, which exports `allPostcodes`,
// an array of { state: string, city: string, postcode: string[] }.
//
// Run from the repo root:
//   pnpm dlx tsx apps/frontend/scripts/gen-postcodes.ts
//
// The script throws on any upstream state name it can't map to MY_STATES, so a
// dataset change can never silently drop East-Malaysia pricing.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
// eslint-disable-next-line @typescript-eslint/no-var-requires
import pkg from 'malaysia-postcodes'
import { MY_STATES } from '../src/states-my'

interface UpstreamEntry { state: string; city: string; postcode: string[] }

// Upstream uses "WP Kuala Lumpur" etc.; map those to our canonical strings.
// Names already canonical fall through unchanged.
const NORMALIZE: Record<string, string> = {
  'WP Kuala Lumpur': 'W.P. Kuala Lumpur',
  'WP Labuan': 'W.P. Labuan',
  'WP Putrajaya': 'W.P. Putrajaya',
  'Penang': 'Pulau Pinang',
  'Malacca': 'Melaka',
}

const allPostcodes: UpstreamEntry[] =
  (pkg as any).allPostcodes ?? (pkg as any).default?.allPostcodes
if (!Array.isArray(allPostcodes)) {
  throw new Error('malaysia-postcodes: could not find `allPostcodes` array export')
}

const canonicalStates = new Set<string>(MY_STATES as readonly string[])
const out: Record<string, string> = {}

for (const entry of allPostcodes) {
  const state = NORMALIZE[entry.state] ?? entry.state
  if (!canonicalStates.has(state)) {
    throw new Error(`Unmapped state "${entry.state}" — add it to NORMALIZE or MY_STATES`)
  }
  for (const raw of entry.postcode) {
    const pc = String(raw).padStart(5, '0')
    if (!/^\d{5}$/.test(pc)) continue
    // First city wins for a shared postcode (matches lookupPostcode contract).
    if (!(pc in out)) out[pc] = `${entry.city}|${state}`
  }
}

const dest = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'postcodes-my.json')
writeFileSync(dest, JSON.stringify(out))
console.log(`Wrote ${Object.keys(out).length} postcodes to ${dest}`)
```

- [ ] **Step 3: Add the generator's source package as a dev dependency**

Run: `pnpm --filter @bitetime/frontend add -D malaysia-postcodes`
Expected: package added under `apps/frontend/package.json` devDependencies.

- [ ] **Step 4: Generate the dataset**

Run: `pnpm dlx tsx apps/frontend/scripts/gen-postcodes.ts`
Expected: console prints `Wrote <N> postcodes to …/src/postcodes-my.json` with N in the thousands, and no "Unmapped state" throw. If it throws, add the named upstream state to `NORMALIZE` and re-run.

- [ ] **Step 5: Sanity-check the output**

Run: `node -e "const m=require('./apps/frontend/src/postcodes-my.json'); console.log(m['50000'], m['88000'], m['93000'])"`
Expected: three `City|State` strings; `m['88000']` ends with `|Sabah` and `m['93000']` ends with `|Sarawak` (both East Malaysia). If a specific key is absent, pick any nearby key from the file — the important check is that Sabah/Sarawak entries exist.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/states-my.ts apps/frontend/scripts/gen-postcodes.ts apps/frontend/src/postcodes-my.json apps/frontend/package.json pnpm-lock.yaml
git commit -m "feat(storefront): bundled MY postcode dataset + generator"
```

---

### Task 3: `lookupPostcode`

Lazy-loading lookup over the Task 2 dataset.

**Files:**
- Create: `apps/frontend/src/postcodes.ts`
- Test: `apps/frontend/src/postcodes.test.ts`

**Interfaces:**
- Consumes: `postcodes-my.json` (Task 2).
- Produces: `function lookupPostcode(code: string): Promise<{ city: string; state: string } | null>` (exported from `postcodes.ts`).

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/postcodes.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import raw from './postcodes-my.json'
import { lookupPostcode } from './postcodes'

const map = raw as Record<string, string>
// Pick real keys straight from the generated data so the test never depends on
// a hardcoded postcode being present.
const anyKey = Object.keys(map)[0]
const sabahKey = Object.keys(map).find(k => map[k].endsWith('|Sabah'))!

describe('lookupPostcode', () => {
  it('resolves a known postcode to city + state', async () => {
    const hit = await lookupPostcode(anyKey)
    expect(hit).not.toBeNull()
    expect(typeof hit!.city).toBe('string')
    expect(hit!.city.length).toBeGreaterThan(0)
  })

  it('resolves an East-Malaysia postcode to its state', async () => {
    const hit = await lookupPostcode(sabahKey)
    expect(hit!.state).toBe('Sabah')
  })

  it('returns null for a non-5-digit code', async () => {
    expect(await lookupPostcode('1234')).toBeNull()
    expect(await lookupPostcode('ABCDE')).toBeNull()
  })

  it('returns null for an unknown 5-digit code', async () => {
    // 00000 is not a real MY postcode and is absent from the dataset.
    expect(await lookupPostcode('00000')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bitetime/frontend test -- postcodes.test.ts`
Expected: FAIL — cannot resolve `./postcodes` / `lookupPostcode` is not a function.

- [ ] **Step 3: Write the lookup**

Create `apps/frontend/src/postcodes.ts`:

```ts
// Postcode → { city, state } lookup over the bundled MY dataset. The JSON is
// loaded lazily (dynamic import) so pickup-only sessions never pay for it, and
// memoised after the first call.
let cache: Record<string, string> | null = null

async function load(): Promise<Record<string, string>> {
  if (!cache) {
    const mod = await import('./postcodes-my.json')
    cache = (mod.default ?? mod) as Record<string, string>
  }
  return cache
}

export async function lookupPostcode(
  code: string,
): Promise<{ city: string; state: string } | null> {
  if (!/^\d{5}$/.test(code)) return null
  const map = await load()
  const value = map[code]
  if (!value) return null
  const [city, state] = value.split('|')
  return { city, state }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @bitetime/frontend test -- postcodes.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/postcodes.ts apps/frontend/src/postcodes.test.ts
git commit -m "feat(storefront): lazy postcode lookup"
```

---

### Task 4: Migrate `orders.address` to jsonb + type `placeOrder`

Persistence layer accepts the structured object. Independent of any UI.

**Files:**
- Create: `apps/backend/supabase/migrations/20260705120000_orders_address_jsonb.sql`
- Modify: `apps/frontend/src/store.ts:407-417` (`placeOrder` signature)

**Interfaces:**
- Consumes: `AddressParts` (Task 1).
- Produces: `placeOrder({ …, address?: AddressParts | string, … })` — persists `address` into the `jsonb` `orders.address` column.

- [ ] **Step 1: Write the migration**

Create `apps/backend/supabase/migrations/20260705120000_orders_address_jsonb.sql`:

```sql
-- Delivery address is now a structured object { line1, postcode, city, state }.
-- Convert the existing free-text column to jsonb. Existing text rows become
-- JSON string scalars (still valid jsonb) so the display formatter's string
-- branch keeps rendering them.
alter table orders
  alter column address type jsonb
  using case when address is null then null else to_jsonb(address) end;
```

- [ ] **Step 2: Apply the migration locally**

Run: `pnpm --filter @bitetime/backend db:migrate`
Expected: migration applies without error; `orders.address` is now `jsonb`. (Requires local Supabase running — `supabase start`.)

- [ ] **Step 3: Type the `placeOrder` address param**

In `apps/frontend/src/store.ts`, add the import near the other type imports at the top of the file:

```ts
import type { AddressParts } from './types'
```

Then change the `placeOrder` destructured signature (currently `address?: any` at ~line 412):

```ts
export async function placeOrder({ merchantId, customerName, customerWa, mode, address, shippingFee, items, total, currency }: {
  merchantId: string
  customerName: string
  customerWa: string
  mode: string
  address?: AddressParts | string
  shippingFee?: number
  items: any
  total: number
  currency?: string
}) {
```

The insert body is unchanged — Supabase serialises the object into the `jsonb` column.

- [ ] **Step 4: Verify the type change compiles**

Run: `pnpm --filter @bitetime/frontend typecheck`
Expected: PASS (no errors). Note: `Storefront.tsx` still passes a string here; that call site is updated in Task 5, and `AddressParts | string` accepts both, so this stays green.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/supabase/migrations/20260705120000_orders_address_jsonb.sql apps/frontend/src/store.ts
git commit -m "feat(orders): store delivery address as structured jsonb"
```

---

### Task 5: Storefront delivery fields + autofill + regional shipping

The user-facing change: four fields, postcode-driven autofill, and wiring the state into pricing. Verified by running the app (repo convention: UI is run-and-verify, not component-tested).

**Files:**
- Modify: `apps/frontend/src/store/Storefront.tsx` (state ~46; pricing block ~70-93; delivery block ~405-417; submit ~144-159)

**Interfaces:**
- Consumes: `lookupPostcode` (Task 3), `MY_STATES` (Task 2), `AddressParts` (Task 1), `priceOrder` (existing, `pricing.ts`).

- [ ] **Step 1: Add imports**

At the top of `apps/frontend/src/store/Storefront.tsx`, alongside the existing imports, add:

```ts
import { lookupPostcode } from '../postcodes'
import { MY_STATES } from '../states-my'
import type { AddressParts } from '../types'
```

- [ ] **Step 2: Replace the address state**

Change (line 46):

```ts
const [address, setAddress] = useState('')
```

to:

```ts
const [address, setAddress] = useState<AddressParts>({ line1: '', postcode: '', city: '', state: '' })

const onPostcodeChange = async (raw: string) => {
  const pc = raw.replace(/\D/g, '').slice(0, 5)
  setAddress(a => ({ ...a, postcode: pc }))
  if (pc.length === 5) {
    const hit = await lookupPostcode(pc)
    if (hit) setAddress(a => ({ ...a, postcode: pc, city: hit.city, state: hit.state }))
  }
}
```

- [ ] **Step 3: Rewire pricing to regional shipping**

Replace lines 70-71:

```ts
const deliveryFee = merchant?.shipping?.WM ?? 8
const fee = mode === 'delivery' ? deliveryFee : 0
```

with:

```ts
const rateWM = merchant?.shipping?.WM ?? 8
const rateEM = merchant?.shipping?.EM ?? rateWM
const baseDeliveryFee = rateWM // shown on the Delivery toggle before a state is known
```

Replace the `priceOrder({ … })` call (lines 81-88):

```ts
const bd = priceOrder({
  products: activeProducts,
  cart,
  mode,
  state: mode === 'delivery' ? address.state : null,
  rates: { WM: rateWM, EM: rateEM },
  voucher: appliedVoucher,
})
```

Add, right after the `bd` breakdown is computed (after line 92 `const total = bd.total`):

```ts
const fee = bd.shipping
```

Then update the Delivery toggle label that referenced `deliveryFee`: find where the fulfilment button renders the delivery surcharge (the `+RM 8.00` label) and use `baseDeliveryFee` in place of the old `deliveryFee`.

- [ ] **Step 4: Extend submit gating**

Replace `canSubmit` (line 93):

```ts
const deliveryReady =
  mode !== 'delivery' ||
  (address.line1.trim() !== '' &&
    address.postcode.length === 5 &&
    address.city.trim() !== '' &&
    address.state.trim() !== '')
const canSubmit = cartItems.length > 0 && name.trim() !== '' && wa.trim() !== '' && !busy && deliveryReady
```

- [ ] **Step 5: Pass the object to placeOrder**

Change line 154:

```ts
address: mode === 'delivery' ? address : '',
```

(`address` is now the `AddressParts` object; pickup still sends `''`.) No other change to the `placeOrder` call.

- [ ] **Step 6: Replace the textarea with four fields**

Replace the delivery block (lines 405-417):

```tsx
{mode === 'delivery' && (
  <div className="flex flex-col gap-3 mt-3">
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="sf-line1">{t('Address line', '地址')}</Label>
      <Input
        id="sf-line1"
        value={address.line1}
        onChange={e => setAddress(a => ({ ...a, line1: e.target.value }))}
        placeholder={t('Street, building, unit…', '街道、建筑、单位…')}
      />
    </div>
    <div className="flex gap-3">
      <div className="flex flex-col gap-1.5 w-1/3">
        <Label htmlFor="sf-postcode">{t('Postcode', '邮编')}</Label>
        <Input
          id="sf-postcode"
          value={address.postcode}
          onChange={e => onPostcodeChange(e.target.value)}
          inputMode="numeric"
          maxLength={5}
          placeholder="43000"
        />
      </div>
      <div className="flex flex-col gap-1.5 flex-1">
        <Label htmlFor="sf-city">{t('City', '城市')}</Label>
        <Input
          id="sf-city"
          value={address.city}
          onChange={e => setAddress(a => ({ ...a, city: e.target.value }))}
          placeholder={t('City', '城市')}
        />
      </div>
    </div>
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="sf-state">{t('State', '州属')}</Label>
      <select
        id="sf-state"
        value={address.state}
        onChange={e => setAddress(a => ({ ...a, state: e.target.value }))}
        className="h-10 rounded-md border border-clay-border bg-cream px-3 text-[14px] text-ink"
      >
        <option value="">{t('Select state…', '选择州属…')}</option>
        {MY_STATES.map(s => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>
    </div>
  </div>
)}
```

Note: confirm `Input` is already imported in this file (it is used elsewhere in the storefront). If not, add it to the existing UI-component import line. The `<select>` className mirrors the input styling used nearby — adjust the token names to match the file's existing inputs if they differ.

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @bitetime/frontend typecheck`
Expected: PASS. If `bd.shipping` is flagged, confirm `PriceBreakdown.shipping` exists in `pricing.ts` (it does, line 20).

- [ ] **Step 8: Run and verify in the app**

Run: `pnpm dev` then open a storefront at `/s/<active-slug>`.
Verify:
1. Select **Delivery** → four fields appear (Address line, Postcode, City, State).
2. Type a West-Malaysia postcode (e.g. `43000`) → City + State autofill; State shows the matching option.
3. Edit the City field → your edit sticks (not overwritten).
4. Type a Sabah postcode (e.g. `88000`) with an EM rate configured on the shop → the delivery fee reflects the EM rate; with no EM rate set, it equals the WM fee.
5. Leave a field blank → the place-order button stays disabled.
6. Place an order → succeeds.

- [ ] **Step 9: Commit**

```bash
git add apps/frontend/src/store/Storefront.tsx
git commit -m "feat(storefront): split delivery address into fields with postcode autofill"
```

---

### Task 6: Render structured address in the merchant order detail

**Files:**
- Modify: `apps/frontend/src/merchant/OrdersView.tsx:288`

**Interfaces:**
- Consumes: `formatAddress` (Task 1).

- [ ] **Step 1: Add the import**

At the top of `apps/frontend/src/merchant/OrdersView.tsx`, add:

```ts
import { formatAddress } from '../address'
```

- [ ] **Step 2: Use the formatter**

Change line 288:

```tsx
{selected.address && <DetailRow label={t('Address', '地址')}>{selected.address}</DetailRow>}
```

to:

```tsx
{selected.address && <DetailRow label={t('Address', '地址')}>{formatAddress(selected.address)}</DetailRow>}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @bitetime/frontend typecheck`
Expected: PASS.

- [ ] **Step 4: Verify in the app**

With `pnpm dev` running, open the merchant dashboard, select a newly placed delivery order, and confirm the Address row reads `line1, postcode city, state` (not `[object Object]`). Open an older order (legacy string address) and confirm it still renders.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/merchant/OrdersView.tsx
git commit -m "feat(merchant): render structured delivery address"
```

---

### Task 7: Render structured address in the Telegram notification

Backend cannot import frontend code, so it gets a small twin formatter (exported so it can be unit-tested).

**Files:**
- Modify: `apps/backend/src/notify.ts` (add exported `formatAddress`; use it at line 47)
- Test: `apps/backend/tests/unit/notify-address.test.ts`

**Interfaces:**
- Produces: `formatAddress(addr: unknown): string` (exported from `apps/backend/src/notify.ts`).

- [ ] **Step 1: Write the failing test**

Create `apps/backend/tests/unit/notify-address.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildOrderMessage, formatAddress } from '../../src/notify.js'

describe('backend formatAddress', () => {
  it('joins a structured address', () => {
    expect(formatAddress({ line1: '12 Jalan Ceria', postcode: '43000', city: 'Kajang', state: 'Selangor' }))
      .toBe('12 Jalan Ceria, 43000 Kajang, Selangor')
  })

  it('passes a legacy string through', () => {
    expect(formatAddress('12 Jalan Ceria, Kajang')).toBe('12 Jalan Ceria, Kajang')
  })

  it('returns empty string for nullish', () => {
    expect(formatAddress(null)).toBe('')
    expect(formatAddress(undefined)).toBe('')
  })
})

describe('buildOrderMessage', () => {
  it('formats a structured delivery address in the Telegram body', () => {
    const msg = buildOrderMessage({
      order_number: 'AB-20260705-0001',
      customer_name: 'Amir',
      mode: 'delivery',
      address: { line1: '12 Jalan Ceria', postcode: '43000', city: 'Kajang', state: 'Selangor' },
      items: [{ name: 'Nasi Lemak', qty: 2, price: 5 }],
      total: 18,
      currency: 'MYR',
    })
    expect(msg).toContain('*Address:* 12 Jalan Ceria, 43000 Kajang, Selangor')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bitetime/backend test -- notify-address.test.ts`
Expected: FAIL — `formatAddress` is not exported from `notify`.

- [ ] **Step 3: Add the twin formatter and use it**

In `apps/backend/src/notify.ts`, add above `buildOrderMessage` (~line 36):

```ts
// Delivery address may be a structured object { line1, postcode, city, state }
// (current) or a legacy free-text string. Mirrors the frontend formatAddress;
// the backend can't import frontend code, so this is an intentional twin.
export function formatAddress(addr: unknown): string {
  if (!addr) return ''
  if (typeof addr === 'string') return addr
  const a = addr as { line1?: string; postcode?: string; city?: string; state?: string }
  const cityLine = [a.postcode, a.city].filter(Boolean).join(' ')
  return [a.line1, cityLine, a.state].filter(Boolean).join(', ')
}
```

Change line 47:

```ts
if (order.address) msg += `*Address:* ${order.address}\n`
```

to:

```ts
if (order.address) msg += `*Address:* ${formatAddress(order.address)}\n`
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @bitetime/backend test -- notify-address.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/notify.ts apps/backend/tests/unit/notify-address.test.ts
git commit -m "feat(notify): render structured delivery address in Telegram message"
```

---

### Task 8: Full-suite verification

- [ ] **Step 1: Typecheck the monorepo**

Run: `pnpm typecheck`
Expected: PASS across both workspaces.

- [ ] **Step 2: Run all unit tests**

Run: `pnpm test`
Expected: PASS, including `address.test.ts`, `postcodes.test.ts`, `notify-address.test.ts`, and the existing `pricing.test.ts`.

- [ ] **Step 3: Lint**

Run: `pnpm lint`
Expected: PASS. If the generator's `import pkg from 'malaysia-postcodes'` trips a lint rule, keep the eslint-disable comment already in the file or adjust to the repo's convention.

- [ ] **Step 4: Final commit (if lint/typecheck required tweaks)**

```bash
git add -A
git commit -m "chore: postcode-address feature verification fixes"
```

---

## Self-Review

**Spec coverage:**
- §1 dataset + lookup → Tasks 2, 3. ✓
- §2 canonical states → Task 2 (`states-my.ts`). ✓
- §3 four fields UI + editable autofill + submit gating → Task 5. ✓
- §4 state shape + `AddressParts` → Tasks 1, 5. ✓
- §5 shipping wiring (drop `resolvedShipping`, real WM/EM rates) → Task 5 step 3. ✓
- §6 storage + jsonb migration → Task 4. ✓
- §7 formatter, both read sites → Tasks 1 (helper), 6 (OrdersView), 7 (notify). ✓
- Testing (unit for `lookupPostcode`, `formatAddress`) → Tasks 1, 3, 7. ✓
- Non-goals respected: no profile prefill, no multi-city dropdown, no merchant EM-rate UI (falls back to WM), MY-only. ✓
- Risk: state-name drift → generator throws on unmapped state (Task 2 step 2/4). Dataset source pinned to `malaysia-postcodes`. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. The one soft spot — exact UI className tokens and `Input` import in Task 5 — is called out with a concrete check rather than left vague.

**Type consistency:** `AddressParts { line1, postcode, city, state }` used identically in Tasks 1, 4, 5. `formatAddress` signature consistent (frontend `AddressParts|string|null|undefined`; backend `unknown` twin, same output). `lookupPostcode(code): Promise<{city,state}|null>` consistent between Tasks 3 and 5. `MY_STATES` consistent Tasks 2, 5. Dataset value format `"City|State"` consistent Tasks 2, 3.
