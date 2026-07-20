# Fulfilment Date Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a storefront customer pick the calendar date they want their pickup or delivery on, within a range the merchant controls, and make that date required on every new order.

**Architecture:** The rule deciding which dates are selectable lives in `@bitetime/shared` because the browser builds the picker from it and the backend re-checks the submitted date against it — the browser's copy is UX, the backend's is authority. Merchant config (lead days, window, closed weekdays) rides in the existing `merchants.config` jsonb; the shop's timezone is a new first-class column. Dates travel as `YYYY-MM-DD` strings end to end.

**Tech Stack:** TypeScript everywhere. Vitest for unit and API tests. React 19 + Tailwind for the picker. Hono + `postgres.js` on the backend. Supabase migrations.

## Global Constraints

- **Dates are `YYYY-MM-DD` strings, never `Date` objects.** A `Date` carrying a calendar date can shift a day under timezone conversion, and that day is what the merchant cooks on. Date arithmetic goes through UTC midnight (no DST) inside `fulfilment.ts` and nowhere else.
- **`now` is always a parameter**, never `Date.now()` read inside a pure function. The storefront passes the server-corrected clock from `useServerClock()` (`serverNow()`), the same clock `priceOrder` already uses.
- **The backend re-validates.** `db.ts` is RLS-exempt and the request body is customer-controlled. Browser validation never substitutes for the intake check.
- **Every new backend field must be allowlisted.** `admin` (service role) bypasses RLS and the guard triggers, so `writes.ts` picks are the only thing stopping privilege escalation. Never spread a raw body into a DB write.
- **Every customer- and merchant-facing string is bilingual** via `t(en, zh)`.
- **Adding a migration file does not apply it.** Run `pnpm --filter @bitetime/backend db:migrate` after creating one.
- **New `OrderErrorCode` values must be added in three places** or the customer sees "something went wrong" for a refusal we understand: `apps/backend/src/orders.ts` (`OrderErrorCode`), `apps/frontend/src/store.ts` (`OrderErrorCode` — a deliberate twin, the workspaces cannot import each other), and the `handleSubmit` catch block in `Storefront.tsx`.
- **Backend relative imports keep `.js` specifiers** (NodeNext). Frontend imports are extensionless (bundler resolution). `packages/shared` internal imports use `.js`.
- **Task ordering is load-bearing.** Tasks 3–7 keep checkout working at every commit: the backend accepts an *optional* date first (Task 3), the storefront starts sending one (Task 6), and only the last task (Task 8) makes it required. Flipping requirement earlier would refuse every order placed between two commits.

---

### Task 1: The shared fulfilment rule

**Files:**
- Create: `packages/shared/src/fulfilment.ts`
- Create: `packages/shared/src/fulfilment.test.ts`
- Modify: `packages/shared/src/index.ts:1-22` (add exports)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type FulfilmentConfig = { lead_days: number; window_days: number; closed_weekdays: number[] }`
  - `const DEFAULT_FULFILMENT: FulfilmentConfig`
  - `const DEFAULT_TIMEZONE: string` (`'Asia/Kuala_Lumpur'`)
  - `fulfilmentConfig(raw: unknown): FulfilmentConfig`
  - `isTimezone(tz: unknown): boolean`
  - `todayInZone(tz: string, now: Date): string`
  - `isDateSelectable(date: string, cfg: FulfilmentConfig, tz: string, now: Date): boolean`
  - `selectableDates(cfg: FulfilmentConfig, tz: string, now: Date): string[]`

- [ ] **Step 1: Write the failing tests**

Create `packages/shared/src/fulfilment.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_FULFILMENT, DEFAULT_TIMEZONE, fulfilmentConfig, isTimezone,
  todayInZone, isDateSelectable, selectableDates,
} from './fulfilment.js'

// A fixed instant: 2026-07-20T04:00:00Z is 12:00 on 2026-07-20 in Kuala Lumpur (UTC+8).
const NOON_MYT = new Date('2026-07-20T04:00:00Z')
// 2026-07-20T17:00:00Z is 01:00 on the 21st in KL but still the 20th in UTC.
const LATE_MYT = new Date('2026-07-20T17:00:00Z')

const OPEN: ReturnType<typeof fulfilmentConfig> = { lead_days: 0, window_days: 3, closed_weekdays: [] }

describe('todayInZone', () => {
  it('reads the date in the shop clock, not UTC', () => {
    expect(todayInZone('Asia/Kuala_Lumpur', NOON_MYT)).toBe('2026-07-20')
  })

  it('is already tomorrow in the shop while UTC is still today', () => {
    expect(todayInZone('Asia/Kuala_Lumpur', LATE_MYT)).toBe('2026-07-21')
    expect(todayInZone('UTC', LATE_MYT)).toBe('2026-07-20')
  })

  it('falls back to the default zone rather than throwing on a junk timezone', () => {
    expect(todayInZone('Not/AZone', NOON_MYT)).toBe(todayInZone(DEFAULT_TIMEZONE, NOON_MYT))
  })
})

describe('selectableDates', () => {
  it('offers window_days days starting today when lead is 0', () => {
    expect(selectableDates(OPEN, 'Asia/Kuala_Lumpur', NOON_MYT))
      .toEqual(['2026-07-20', '2026-07-21', '2026-07-22'])
  })

  it('starts lead_days after today, and still offers window_days days', () => {
    expect(selectableDates({ ...OPEN, lead_days: 2 }, 'Asia/Kuala_Lumpur', NOON_MYT))
      .toEqual(['2026-07-22', '2026-07-23', '2026-07-24'])
  })

  it('drops closed weekdays without shortening the window', () => {
    // 2026-07-20 is a Monday (weekday 1).
    expect(selectableDates({ lead_days: 0, window_days: 3, closed_weekdays: [1] }, 'Asia/Kuala_Lumpur', NOON_MYT))
      .toEqual(['2026-07-21', '2026-07-22'])
  })

  it('is empty when every weekday is closed', () => {
    const shut = { lead_days: 0, window_days: 14, closed_weekdays: [0, 1, 2, 3, 4, 5, 6] }
    expect(selectableDates(shut, 'Asia/Kuala_Lumpur', NOON_MYT)).toEqual([])
  })
})

describe('isDateSelectable', () => {
  it('accepts the first and last day of the window', () => {
    expect(isDateSelectable('2026-07-20', OPEN, 'Asia/Kuala_Lumpur', NOON_MYT)).toBe(true)
    expect(isDateSelectable('2026-07-22', OPEN, 'Asia/Kuala_Lumpur', NOON_MYT)).toBe(true)
  })

  it('refuses the day before the window and the day after it', () => {
    expect(isDateSelectable('2026-07-19', OPEN, 'Asia/Kuala_Lumpur', NOON_MYT)).toBe(false)
    expect(isDateSelectable('2026-07-23', OPEN, 'Asia/Kuala_Lumpur', NOON_MYT)).toBe(false)
  })

  it('refuses a date inside the window that falls on a closed weekday', () => {
    const cfg = { lead_days: 0, window_days: 3, closed_weekdays: [1] }
    expect(isDateSelectable('2026-07-20', cfg, 'Asia/Kuala_Lumpur', NOON_MYT)).toBe(false)
  })

  it('refuses anything that is not a YYYY-MM-DD calendar date', () => {
    expect(isDateSelectable('2026-7-20', OPEN, 'Asia/Kuala_Lumpur', NOON_MYT)).toBe(false)
    expect(isDateSelectable('2026-02-30', OPEN, 'Asia/Kuala_Lumpur', NOON_MYT)).toBe(false)
    expect(isDateSelectable('', OPEN, 'Asia/Kuala_Lumpur', NOON_MYT)).toBe(false)
  })

  it('agrees with selectableDates', () => {
    const cfg = { lead_days: 1, window_days: 10, closed_weekdays: [0, 3] }
    for (const d of selectableDates(cfg, 'Asia/Kuala_Lumpur', NOON_MYT)) {
      expect(isDateSelectable(d, cfg, 'Asia/Kuala_Lumpur', NOON_MYT)).toBe(true)
    }
  })
})

describe('fulfilmentConfig', () => {
  it('reads a missing or empty bag as the default', () => {
    expect(fulfilmentConfig(undefined)).toEqual(DEFAULT_FULFILMENT)
    expect(fulfilmentConfig({})).toEqual(DEFAULT_FULFILMENT)
    expect(fulfilmentConfig({ fulfilment: null })).toEqual(DEFAULT_FULFILMENT)
  })

  it('reads the fulfilment key off a merchants.config bag', () => {
    expect(fulfilmentConfig({ fulfilment: { lead_days: 2, window_days: 7, closed_weekdays: [1] } }))
      .toEqual({ lead_days: 2, window_days: 7, closed_weekdays: [1] })
  })

  it('clamps out-of-range numbers instead of trusting them', () => {
    expect(fulfilmentConfig({ fulfilment: { lead_days: -5, window_days: 0, closed_weekdays: [] } }))
      .toEqual({ lead_days: 0, window_days: 1, closed_weekdays: [] })
    expect(fulfilmentConfig({ fulfilment: { lead_days: 999, window_days: 999, closed_weekdays: [] } }))
      .toEqual({ lead_days: 30, window_days: 90, closed_weekdays: [] })
  })

  it('drops junk weekdays and de-duplicates the rest', () => {
    expect(fulfilmentConfig({ fulfilment: { lead_days: 0, window_days: 14, closed_weekdays: [1, 1, 7, -1, 'x', 2.5, 6] } }))
      .toEqual({ lead_days: 0, window_days: 14, closed_weekdays: [1, 6] })
  })

  it('falls back per field, so one bad value does not discard the good ones', () => {
    expect(fulfilmentConfig({ fulfilment: { lead_days: 'soon', window_days: 7, closed_weekdays: null } }))
      .toEqual({ lead_days: 0, window_days: 7, closed_weekdays: [] })
  })
})

describe('isTimezone', () => {
  it('accepts real IANA zones', () => {
    expect(isTimezone('Asia/Kuala_Lumpur')).toBe(true)
    expect(isTimezone('UTC')).toBe(true)
  })

  it('refuses junk and non-strings', () => {
    expect(isTimezone('Not/AZone')).toBe(false)
    expect(isTimezone('')).toBe(false)
    expect(isTimezone(null)).toBe(false)
    expect(isTimezone(7)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @bitetime/shared test`
Expected: FAIL — `Failed to resolve import "./fulfilment.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/fulfilment.ts`:

```ts
// When a customer may ask for their order — the rule the storefront picker is BUILT from and
// the rule order intake CHECKS against. It is here, and not in either app, for the same reason
// pricing.ts is: the browser quotes a date and the backend refuses one, and two copies of this
// arithmetic that drift by a day are a checkout that refuses every honest order on the window's
// edge, with nothing on screen to explain it.

/** Per-merchant shape, stored under `merchants.config -> 'fulfilment'`. */
export interface FulfilmentConfig {
  /** Days before the first date a customer may pick. 0 allows same-day. */
  lead_days: number
  /** How many dates are offered, counted from the first selectable one. */
  window_days: number
  /** Weekdays the shop takes nothing, 0 = Sunday … 6 = Saturday. */
  closed_weekdays: number[]
}

/**
 * What a shop that has never opened the Fulfilment tab offers: today through two weeks out,
 * closed on no day. Every existing merchant reads as this, so the feature works on day one
 * without a single merchant touching their settings.
 */
export const DEFAULT_FULFILMENT: FulfilmentConfig = { lead_days: 0, window_days: 14, closed_weekdays: [] }

export const DEFAULT_TIMEZONE = 'Asia/Kuala_Lumpur'

const LEAD_MAX = 30
const WINDOW_MAX = 90

/** True for a string Intl will actually accept as a time zone. */
export function isTimezone(tz: unknown): boolean {
  if (typeof tz !== 'string' || tz === '') return false
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return Math.min(hi, Math.max(lo, Math.trunc(v)))
}

/**
 * Read a merchant's fulfilment rules off the raw `config` jsonb.
 *
 * The sibling of `shopRates`: one function READS this bag on both sides of the wire, so the
 * settings form writes through it too and cannot save a row the storefront then reads back
 * differently. Falls back PER FIELD — one junk value must not discard the merchant's other
 * two, which would silently re-open a shop on the day it said it was closed.
 */
export function fulfilmentConfig(raw: unknown): FulfilmentConfig {
  const bag = (raw ?? {}) as Record<string, unknown>
  const f = (bag.fulfilment ?? {}) as Record<string, unknown>
  if (typeof f !== 'object' || f === null) return { ...DEFAULT_FULFILMENT }
  const closed = Array.isArray(f.closed_weekdays) ? f.closed_weekdays : []
  return {
    lead_days: clampInt(f.lead_days, 0, LEAD_MAX, DEFAULT_FULFILMENT.lead_days),
    window_days: clampInt(f.window_days, 1, WINDOW_MAX, DEFAULT_FULFILMENT.window_days),
    closed_weekdays: [...new Set(
      closed.filter((d): d is number => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6),
    )].sort((a, b) => a - b),
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * A calendar date as UTC midnight milliseconds — the ONLY place a date string becomes a number.
 *
 * UTC deliberately: it has no daylight saving, so "+1 day" is always +86400000 and a window can
 * never gain or lose an hour and land on the wrong date. Returns null for anything that is not a
 * real calendar date, INCLUDING dates that round-trip wrong (2026-02-30 is not February 30th, it
 * is March 2nd, and accepting it would sell an order on a day the customer never picked).
 */
function dayMs(date: string): number | null {
  if (!DATE_RE.test(date)) return null
  const ms = Date.parse(`${date}T00:00:00Z`)
  if (Number.isNaN(ms)) return null
  const d = new Date(ms)
  const round = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  return round === date ? ms : null
}

const DAY = 86_400_000

function fromDayMs(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

/**
 * Today's date on the SHOP's clock.
 *
 * Not the customer's: a customer ordering from another timezone must see the same earliest date
 * the merchant would, or the lead time silently means something different for them. An invalid
 * zone falls back rather than throwing — a bad `merchants.timezone` row must not take checkout
 * down, and the default is the only shop clock this platform has ever had.
 */
export function todayInZone(tz: string, now: Date): string {
  const zone = isTimezone(tz) ? tz : DEFAULT_TIMEZONE
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** The window's bounds as UTC-midnight ms, or null if the shop clock cannot be read. */
function windowBounds(cfg: FulfilmentConfig, tz: string, now: Date): { first: number; last: number } | null {
  const today = dayMs(todayInZone(tz, now))
  if (today === null) return null
  const first = today + cfg.lead_days * DAY
  return { first, last: first + (cfg.window_days - 1) * DAY }
}

/**
 * Every date this shop is currently taking orders for, in order. What the picker renders.
 *
 * Closed weekdays are REMOVED from the window, they do not extend it: `window_days` is how far
 * ahead the merchant is willing to commit, not a quota of open days. A shop closed every day
 * returns an empty list, which the settings form is what prevents (see Task 5) — the rule here
 * reports the merchant's configuration honestly rather than quietly re-opening a day.
 */
export function selectableDates(cfg: FulfilmentConfig, tz: string, now: Date): string[] {
  const b = windowBounds(cfg, tz, now)
  if (!b) return []
  const out: string[] = []
  for (let ms = b.first; ms <= b.last; ms += DAY) {
    if (!cfg.closed_weekdays.includes(new Date(ms).getUTCDay())) out.push(fromDayMs(ms))
  }
  return out
}

/**
 * May this shop take an order for this date, right now?
 *
 * The intake check. It is deliberately a predicate over one date rather than a lookup in
 * `selectableDates`, because intake gets a date from a request body and must judge it without
 * building a list — but the two MUST agree, and a test pins that they do.
 */
export function isDateSelectable(date: string, cfg: FulfilmentConfig, tz: string, now: Date): boolean {
  const ms = dayMs(date)
  if (ms === null) return false
  const b = windowBounds(cfg, tz, now)
  if (!b) return false
  if (ms < b.first || ms > b.last) return false
  return !cfg.closed_weekdays.includes(new Date(ms).getUTCDay())
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @bitetime/shared test`
Expected: PASS — all cases in `fulfilment.test.ts` green.

- [ ] **Step 5: Export from the package index**

In `packages/shared/src/index.ts`, append after the pricing exports:

```ts
export {
  fulfilmentConfig, isTimezone, todayInZone,
  isDateSelectable, selectableDates,
  DEFAULT_FULFILMENT, DEFAULT_TIMEZONE,
} from './fulfilment.js'
export type { FulfilmentConfig } from './fulfilment.js'
```

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm typecheck`
Expected: PASS, no errors.

```bash
git add packages/shared/src/fulfilment.ts packages/shared/src/fulfilment.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): the rule for which fulfilment dates a shop is taking

Which dates a customer may pick has to be decided identically in the
storefront picker and at order intake, so it goes where pricing already
lives. Dates are YYYY-MM-DD strings and the arithmetic runs at UTC
midnight, where a day is always 86400000ms and no DST can move it."
```

---

### Task 2: Migration — timezone column, fulfil_date column

**Files:**
- Create: `apps/backend/supabase/migrations/20260720130000_fulfilment_date.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `merchants.timezone` (`text not null default 'Asia/Kuala_Lumpur'`), `orders.fulfil_date` (`date`, nullable). Removes `orders.preferred_date`.

- [ ] **Step 1: Write the migration**

Create `apps/backend/supabase/migrations/20260720130000_fulfilment_date.sql`:

```sql
-- supabase/migrations/20260720130000_fulfilment_date.sql
-- Fulfilment date selection (#91). Customers pick the date they want their order on.

-- The shop's clock. Which date is "today" — and therefore which date is the earliest a
-- customer may pick — is a property of the SHOP, not of the device ordering from it. A
-- column rather than a key in `config` because order intake reads it on every single order
-- and it is not optional.
alter table public.merchants
  add column if not exists timezone text not null default 'Asia/Kuala_Lumpur';

-- The date the customer asked for.
--
-- NULLABLE, and it stays nullable: every order placed before this shipped has no date and
-- never will. "Required" is enforced at intake for NEW orders (apps/backend/src/orders.ts),
-- which is the only place that can tell a new order from an old row. A NOT NULL here would
-- have to invent a date for history, and an invented fulfilment date is worse than none.
alter table public.orders
  add column if not exists fulfil_date date;

-- The single-tenant baseline shipped `preferred_date` and nothing ever wrote or read it.
-- Dropped rather than reused: the name reads as a soft wish, and this column is a
-- commitment the shop schedules against.
alter table public.orders
  drop column if exists preferred_date;

-- The merchant dashboard's natural question is "what is due, soonest first", per shop.
create index if not exists orders_merchant_fulfil_date_idx
  on public.orders (merchant_id, fulfil_date);

comment on column public.merchants.timezone is
  'IANA zone deciding the shop''s "today" for fulfilment date windows. Validated on write by pickMerchantConfig.';
comment on column public.orders.fulfil_date is
  'Date the customer asked for. NULL only on orders placed before #91 shipped.';
```

- [ ] **Step 2: Apply it locally**

Run: `pnpm --filter @bitetime/backend db:migrate`
Expected: the migration applies with no error. If Supabase is not running, `supabase start` from `apps/backend` first.

- [ ] **Step 3: Verify the columns exist**

Run:
```bash
psql "$(cd apps/backend && supabase status -o env | grep '^DB_URL=' | cut -d= -f2- | tr -d '"')" \
  -c "select column_name from information_schema.columns where table_name='orders' and column_name in ('fulfil_date','preferred_date');" \
  -c "select column_name, column_default from information_schema.columns where table_name='merchants' and column_name='timezone';"
```
Expected: `fulfil_date` listed and `preferred_date` absent; `timezone` present with default `'Asia/Kuala_Lumpur'::text`.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/supabase/migrations/20260720130000_fulfilment_date.sql
git commit -m "feat(db): merchants.timezone and orders.fulfil_date

fulfil_date stays nullable because every order placed before this has no
date and never will; required is enforced at intake, which is the only
layer that can tell a new order from history. Drops the unused
preferred_date rather than reusing a name that reads as a soft wish."
```

---

### Task 3: Intake validates the date when one is sent

**Files:**
- Modify: `apps/backend/src/orders.ts` (`OrderErrorCode`, `PlaceOrderInput`, `placeOrder`, `OrderableMerchant`, `assertOrderableMerchant`)
- Modify: `apps/backend/src/app.ts:829-874` (parse `fulfilDate` off the body)
- Test: `apps/backend/tests/api/orders.test.ts` (existing suite — add cases)

**Interfaces:**
- Consumes: `isDateSelectable`, `fulfilmentConfig`, `DEFAULT_TIMEZONE` from `@bitetime/shared` (Task 1); `orders.fulfil_date`, `merchants.timezone` (Task 2).
- Produces: `PlaceOrderInput.fulfilDate?: string | null`; `OrderErrorCode` gains `'fulfil_date_unavailable'`; `OrderableMerchant` gains `fulfilment: FulfilmentConfig` and `timezone: string`.

This task accepts an *optional* date. Task 8 makes it required. Splitting it that way is what keeps checkout alive between commits — the storefront does not send a date until Task 6.

- [ ] **Step 1: Write the failing API tests**

Open `apps/backend/tests/api/orders.test.ts` and read how existing cases build a merchant, a product and a request — reuse those helpers verbatim rather than writing new ones. Add:

```ts
  it('stores a fulfilment date the shop is taking orders for', async () => {
    const res = await app.request('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...validOrderBody(), fulfilDate: tomorrowInShopZone() }),
    })
    expect(res.status).toBe(200)
    const { orderNumber } = await res.json()
    const [row] = await sql`select fulfil_date from orders where order_number = ${orderNumber}`
    expect(row.fulfil_date).not.toBeNull()
  })

  it('refuses a date past the end of the shop window, and writes nothing', async () => {
    const before = await sql`select count(*)::int as n from orders`
    const res = await app.request('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...validOrderBody(), fulfilDate: '2099-01-01' }),
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'fulfil_date_unavailable' })
    const after = await sql`select count(*)::int as n from orders`
    expect(after[0].n).toBe(before[0].n)
  })

  it('refuses a date on a weekday the shop is closed', async () => {
    // Shut the shop every day, so whatever date the helper picks is closed.
    await sql`update merchants set config = jsonb_set(config, '{fulfilment}',
      '{"lead_days":0,"window_days":14,"closed_weekdays":[0,1,2,3,4,5,6]}'::jsonb, true)
      where id = ${merchantId}`
    const res = await app.request('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...validOrderBody(), fulfilDate: tomorrowInShopZone() }),
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'fulfil_date_unavailable' })
  })

  it('refuses a malformed date rather than storing it', async () => {
    const res = await app.request('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...validOrderBody(), fulfilDate: 'next tuesday' }),
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'fulfil_date_unavailable' })
  })
```

Add this helper near the suite's other helpers:

```ts
import { todayInZone, DEFAULT_TIMEZONE } from '@bitetime/shared'

// A date the default config is certainly taking: today + 1, on the shop's clock.
function tomorrowInShopZone(): string {
  const today = todayInZone(DEFAULT_TIMEZONE, new Date())
  const ms = Date.parse(`${today}T00:00:00Z`) + 86_400_000
  return new Date(ms).toISOString().slice(0, 10)
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @bitetime/backend test:db -- orders`
Expected: FAIL — the first case's `fulfil_date` comes back `null` (the field is ignored), the refusal cases return 200 instead of 409.

- [ ] **Step 3: Widen the merchant read**

In `apps/backend/src/orders.ts`, extend the imports at the top:

```ts
import { priceOrder, voucherFromRow, shopRates, productFromRow, promoClaims, fulfilmentConfig, isDateSelectable, DEFAULT_TIMEZONE } from '@bitetime/shared'
import type { PricedProduct, PricedVoucher, FulfilmentConfig } from '@bitetime/shared'
```

Replace the `OrderableMerchant` interface and the body of `assertOrderableMerchant`:

```ts
interface OrderableMerchant {
  order_prefix: string
  rates: { WM: number; EM: number }
  currency: string
  fulfilment: FulfilmentConfig
  timezone: string
}
```

```ts
async function assertOrderableMerchant(tx: postgres.TransactionSql, merchantId: string): Promise<OrderableMerchant> {
  const rows = await tx<{ order_prefix: string; status: string; shipping: unknown; currency: string | null; config: unknown; timezone: string | null }[]>`
    select order_prefix, status::text, shipping, currency, config, timezone from merchants where id = ${merchantId}
  `
  const merchant = rows[0]
  if (!merchant) throw new OrderError('merchant_not_found')
  if (merchant.status !== 'active') throw new OrderError('merchant_inactive')
  return {
    order_prefix: merchant.order_prefix,
    // shopRates, not a local fallback: the storefront quotes from the same function, and the
    // penalty for the two disagreeing is now a REFUSAL (`price_changed`), not a rounding gap.
    rates: shopRates(merchant.shipping),
    currency: merchant.currency ?? 'MYR',
    // Same argument as shopRates one line up: the picker is BUILT from this function, so intake
    // must judge with it. A second reading of the bag here is a second rule, and the customer
    // meets it as a refusal of a date the picker just offered them.
    fulfilment: fulfilmentConfig(merchant.config),
    timezone: merchant.timezone ?? DEFAULT_TIMEZONE,
  }
}
```

- [ ] **Step 4: Add the error code and the input field**

In `apps/backend/src/orders.ts`, add to the `OrderErrorCode` union (after `'delivery_state_required'`):

```ts
  | 'fulfil_date_unavailable'
```

Add to `PlaceOrderInput`, after `voucherCode`:

```ts
  /**
   * The date the customer asked for, `YYYY-MM-DD`, on the SHOP's clock.
   *
   * Checked here against the shop's own window, never taken on trust: the picker that produced
   * it runs in the customer's browser, and a body is a body. Optional for now — the storefront
   * does not send one until it has a picker, and refusing every dateless order before then
   * would close checkout. It becomes required in the same change that ships the picker.
   */
  fulfilDate?: string | null
```

- [ ] **Step 5: Validate inside the transaction**

In `placeOrder`, immediately after the `assertOrderableMerchant` call:

```ts
    const merchant = await assertOrderableMerchant(tx, input.merchantId)

    // Before the counter moves. A refused date must cost the shop nothing — not a burnt order
    // number, not a claimed voucher — and throwing here rolls back a transaction that has not
    // yet written anything anyway.
    if (input.fulfilDate != null && !isDateSelectable(input.fulfilDate, merchant.fulfilment, merchant.timezone, now)) {
      throw new OrderError('fulfil_date_unavailable')
    }

    const day = orderDay(now)
```

- [ ] **Step 6: Store it**

In the `insert into orders` statement, add `fulfil_date` to the column list after `voucher_code`:

```sql
        shipping_fee, items, total, currency, discount, voucher_code, fulfil_date, order_number, status
```

and the matching value after the `voucherCode` expression:

```ts
        ${input.fulfilDate ?? null},
```

- [ ] **Step 7: Accept it at the door**

In `apps/backend/src/app.ts`, inside the `/api/orders` handler, after the `mode` allowlist:

```ts
  // A string or nothing. The SHAPE is checked here; whether the shop is actually taking that
  // date is `placeOrder`'s call, because the window is the shop's rule and not HTTP's — the
  // same split as `mode` (allowlisted here) versus the delivery region (refused there).
  const fulfilDate = typeof b.fulfilDate === 'string' ? b.fulfilDate : null
```

and pass it in the `placeOrder({ ... })` call, after `voucherCode`:

```ts
      fulfilDate,
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm --filter @bitetime/backend test:db -- orders`
Expected: PASS — new cases green and every pre-existing case in the suite still green (a dateless order must still succeed).

- [ ] **Step 9: Typecheck and commit**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

```bash
git add apps/backend/src/orders.ts apps/backend/src/app.ts apps/backend/tests/api/orders.test.ts
git commit -m "feat(orders): intake checks the fulfilment date against the shop window

The picker runs in the customer's browser and db.ts is RLS-exempt, so
the date is judged here against the shop's own config and clock. Checked
before the counter moves, so a refused date burns no order number.

Optional for now: the storefront has no picker yet, and requiring a date
before it does would refuse every order in between."
```

---

### Task 4: Merchant timezone and fulfilment config are writable

**Files:**
- Modify: `apps/backend/src/writes.ts:14-22`
- Test: `apps/backend/tests/unit/writes.test.ts` (create if absent)

**Interfaces:**
- Consumes: `isTimezone` from `@bitetime/shared` (Task 1).
- Produces: `pickMerchantConfig` accepts `config` and `timezone`; rejects a timezone Intl cannot parse.

- [ ] **Step 1: Write the failing test**

In `apps/backend/tests/unit/writes.test.ts` (create with this content if the file does not exist, otherwise append the `describe`):

```ts
import { describe, it, expect } from 'vitest'
import { pickMerchantConfig } from '../../src/writes.js'

describe('pickMerchantConfig — fulfilment', () => {
  it('accepts a config bag and a real timezone', () => {
    expect(pickMerchantConfig({
      config: { fulfilment: { lead_days: 1, window_days: 7, closed_weekdays: [1] } },
      timezone: 'Asia/Kuala_Lumpur',
    })).toEqual({
      config: { fulfilment: { lead_days: 1, window_days: 7, closed_weekdays: [1] } },
      timezone: 'Asia/Kuala_Lumpur',
    })
  })

  it('drops a timezone Intl cannot parse rather than writing it', () => {
    expect(pickMerchantConfig({ timezone: 'Mars/Olympus' })).toEqual({})
  })

  it('still refuses the privilege columns', () => {
    expect(pickMerchantConfig({ status: 'active', owner_id: 'x', slug: 'y', plan: 'pro' })).toEqual({})
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @bitetime/backend test -- writes`
Expected: FAIL — `config` and `timezone` come back stripped, so the first case gets `{}`.

- [ ] **Step 3: Implement**

In `apps/backend/src/writes.ts`, extend the allowlist and the pick:

```ts
import { isTimezone } from '@bitetime/shared'

const MERCHANT_CONFIG_FIELDS = [
  'currency', 'shipping', 'pickup_address', 'payment_bank', 'payment_note', 'config', 'timezone',
] as const

export function pickMerchantConfig(body: any): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of MERCHANT_CONFIG_FIELDS) if (body?.[k] !== undefined) out[k] = body[k]
  // A timezone is not free text: `todayInZone` feeds it to Intl on EVERY order intake, and a
  // row holding junk would decide the shop's "today" by falling back — silently moving the
  // earliest date a customer can pick, for every order, with nothing on screen to say why.
  // Refused at the door instead, where the merchant is present to see it.
  if (out.timezone !== undefined && !isTimezone(out.timezone)) delete out.timezone
  return out
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @bitetime/backend test -- writes`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/writes.ts apps/backend/tests/unit/writes.test.ts
git commit -m "feat(merchants): allow config and timezone through the write allowlist

admin bypasses RLS, so this pick is the only gate. timezone is validated
rather than allowlisted blind: a junk zone would silently fall back on
every intake and move the earliest date a customer can pick."
```

---

### Task 5: Merchant Fulfilment settings tab

**Files:**
- Create: `apps/frontend/src/merchant/FulfilmentTab.tsx`
- Modify: `apps/frontend/src/merchant/ShopSettings.tsx:17` (`TabKey`), `:50-56` (`TABS`), `:66-75` (render), imports

**Interfaces:**
- Consumes: `fulfilmentConfig`, `DEFAULT_TIMEZONE`, `FulfilmentConfig` from `@bitetime/shared`; `updateMerchantConfig` from `../store`; `useSession`, `useTabDirty` conventions from `ShopSettings.tsx`; the PATCH allowlist from Task 4.
- Produces: a `fulfilment` key inside `merchants.config` and a validated `merchants.timezone` for the storefront and intake to read.

- [ ] **Step 1: Create the tab**

Create `apps/frontend/src/merchant/FulfilmentTab.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useSession } from '../SessionContext'
import { updateMerchantConfig } from '../store'
import { fulfilmentConfig, DEFAULT_TIMEZONE } from '@bitetime/shared'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger } from '../components/ui/select'

const CARD = 'bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-5 mb-8 w-full box-border max-sm:p-4 max-sm:mb-6'
const HEADING = 'font-heading text-[15px] font-medium text-oxblood mb-4 flex items-center gap-2'

// Every zone the runtime knows, so a merchant anywhere can name their own clock. The one-entry
// fallback is for a runtime without `supportedValuesOf` — the default is the only shop clock
// this platform has ever had, so a merchant who cannot see the list is not stranded.
const TIMEZONES: string[] = (Intl as any).supportedValuesOf?.('timeZone') ?? [DEFAULT_TIMEZONE]

const WEEKDAYS: { value: number; en: string; zh: string }[] = [
  { value: 0, en: 'Sun', zh: '周日' },
  { value: 1, en: 'Mon', zh: '周一' },
  { value: 2, en: 'Tue', zh: '周二' },
  { value: 3, en: 'Wed', zh: '周三' },
  { value: 4, en: 'Thu', zh: '周四' },
  { value: 5, en: 'Fri', zh: '周五' },
  { value: 6, en: 'Sat', zh: '周六' },
]

interface TabProps { onDirtyChange: (dirty: boolean) => void }

export default function FulfilmentTab({ onDirtyChange }: TabProps) {
  const { t, merchant, refreshMerchant } = useSession()

  // fulfilmentConfig, not a local `?? 0` / `?? 14`: this form shows the merchant what a shop
  // with no saved config ACTUALLY OFFERS, and that is decided by one function on both sides of
  // the wire. A second set of fallbacks here would show a window the storefront never renders.
  const initial = () => {
    const cfg = fulfilmentConfig(merchant!.config)
    return {
      lead: String(cfg.lead_days),
      window: String(cfg.window_days),
      closed: cfg.closed_weekdays,
      timezone: merchant!.timezone ?? DEFAULT_TIMEZONE,
    }
  }
  const [saved, setSaved] = useState(initial)
  const [fields, setFields] = useState(saved)
  const [busy, setBusy] = useState(false)

  const dirty =
    fields.lead !== saved.lead ||
    fields.window !== saved.window ||
    fields.timezone !== saved.timezone ||
    fields.closed.join(',') !== saved.closed.join(',')

  // The container tracks one dirty flag for the active tab and registers it with the NavGuard.
  // Not ShopSettings' `useTabDirty`, which is typed to SettingsFields (a flat string map) and
  // cannot hold this tab's number[] of closed weekdays. Same contract, different shape.
  useEffect(() => { onDirtyChange(dirty) }, [dirty, onDirtyChange])

  const allClosed = fields.closed.length === 7

  function toggleDay(d: number) {
    setFields(f => ({
      ...f,
      closed: f.closed.includes(d) ? f.closed.filter(x => x !== d) : [...f.closed, d].sort((a, b) => a - b),
    }))
  }

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    // A shop closed all seven days offers the customer NO date at all, and the storefront's
    // picker would render empty with nothing to explain it. Refused here, where the merchant
    // is looking at the checkboxes that caused it.
    if (allClosed) {
      toast.error(t('Leave at least one day open, or customers cannot order at all.', '请至少保留一天营业，否则顾客无法下单。'))
      return
    }
    setBusy(true)
    try {
      // fulfilmentConfig is what READS this bag on both sides of the wire, so it is what WRITES
      // it too — the form cannot save a shape the storefront then reads back differently.
      const fulfilment = fulfilmentConfig({
        fulfilment: {
          lead_days: Number(fields.lead),
          window_days: Number(fields.window),
          closed_weekdays: fields.closed,
        },
      })
      await updateMerchantConfig(merchant!.id, {
        config: { ...(merchant!.config ?? {}), fulfilment },
        timezone: fields.timezone,
      })
      await refreshMerchant()
      // Show back what was SAVED, not what was typed: `fulfilmentConfig` clamps, and a merchant
      // who typed 999 must not be left reading 999 while their shop offers 90.
      const applied = {
        lead: String(fulfilment.lead_days),
        window: String(fulfilment.window_days),
        closed: fulfilment.closed_weekdays,
        timezone: fields.timezone,
      }
      setFields(applied)
      setSaved(applied)
      toast.success(t('Fulfilment saved', '取货设置已保存'))
    } catch (err: any) {
      toast.error(err.message || t('Save failed', '保存失败'))
    } finally { setBusy(false) }
  }

  return (
    <form onSubmit={save}>
      <div className={CARD}>
        <h3 className={HEADING}>{t('Order dates', '可选日期')}</h3>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="ff-lead">{t('Days of notice you need', '需要提前的天数')}</Label>
            <Input id="ff-lead" type="number" min="0" max="30" value={fields.lead} variant="compact"
              onChange={e => setFields(f => ({ ...f, lead: e.target.value }))} />
            <p className="text-[12px] text-rose-muted mt-1 leading-[1.5]">
              {t('0 lets customers order for today. 1 means the earliest they can pick is tomorrow.',
                 '填 0 表示顾客可选当天。填 1 表示最早只能选明天。')}
            </p>
          </div>
          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="ff-window">{t('How many days ahead you take orders', '可提前预订的天数')}</Label>
            <Input id="ff-window" type="number" min="1" max="90" value={fields.window} variant="compact"
              onChange={e => setFields(f => ({ ...f, window: e.target.value }))} />
            <p className="text-[12px] text-rose-muted mt-1 leading-[1.5]">
              {t('Counted from the earliest date above. Closed days come out of this range — they do not extend it.',
                 '从上面最早可选日期起算。休息日会从这段日期中扣除，不会顺延。')}
            </p>
          </div>
        </div>
      </div>

      <div className={CARD}>
        <h3 className={HEADING}>{t('Closed days', '休息日')}</h3>
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('Closed days', '休息日')}>
          {WEEKDAYS.map(d => {
            const on = fields.closed.includes(d.value)
            return (
              <button
                key={d.value}
                type="button"
                aria-pressed={on}
                onClick={() => toggleDay(d.value)}
                className={
                  'border rounded-md py-2 px-[14px] pointer-coarse:min-h-11 cursor-pointer text-[14px] font-sans transition-all ' +
                  'hover:border-oxblood focus-visible:outline-2 focus-visible:outline-oxblood focus-visible:outline-offset-2 ' +
                  (on
                    ? 'border-[1.5px] border-oxblood bg-oxblood-tint text-oxblood font-medium'
                    : 'border-clay-border bg-surface-raised text-ink')
                }
              >
                {t(d.en, d.zh)}
              </button>
            )
          })}
        </div>
        <p className="text-[12px] text-rose-muted mt-3 leading-[1.5]">
          {allClosed
            ? t('Every day is marked closed — customers would have no date to pick.', '所有日期都标记为休息，顾客将无日期可选。')
            : t('Days you take no orders. Customers cannot pick these.', '不接单的日子，顾客无法选择。')}
        </p>
      </div>

      <div className={CARD}>
        <h3 className={HEADING}>{t('Time zone', '时区')}</h3>
        <div className="flex flex-col gap-[6px]">
          <Label htmlFor="ff-tz">{t('Your shop’s clock', '店铺所在时区')}</Label>
          <Select value={fields.timezone} onValueChange={v => setFields(f => ({ ...f, timezone: v }))}>
            <SelectTrigger id="ff-tz" className="w-full max-w-[280px]" aria-label={t('Time zone', '时区')}>
              <span className="truncate">{fields.timezone}</span>
            </SelectTrigger>
            <SelectContent>
              {TIMEZONES.map(tz => <SelectItem key={tz} value={tz}>{tz}</SelectItem>)}
            </SelectContent>
          </Select>
          <p className="text-[12px] text-rose-muted mt-1 leading-[1.5]">
            {t('Decides which date counts as “today” for your customers, wherever they are ordering from.',
               '决定顾客下单时“今天”是哪一天，无论他们身在何处。')}
          </p>
        </div>
      </div>

      <Button type="submit" size="md" className="mt-1" disabled={busy || allClosed}>
        {busy ? t('Saving…', '保存中…') : t('Save fulfilment', '保存取货设置')}
      </Button>
    </form>
  )
}
```

- [ ] **Step 2: Wire it into the tab bar**

In `apps/frontend/src/merchant/ShopSettings.tsx`:

Add the import beside `ReferralTab`:
```tsx
import FulfilmentTab from './FulfilmentTab'
```

Widen `TabKey` (line 17):
```ts
type TabKey = 'shipping' | 'fulfilment' | 'payment' | 'notifications' | 'referral'
```

Add to `TABS`, after `shipping`:
```tsx
    { key: 'fulfilment', label: t('Fulfilment', '取货') },
```

Add to the render block, after the `shipping` line:
```tsx
      {tab === 'fulfilment' && <FulfilmentTab onDirtyChange={setDirty} />}
```

- [ ] **Step 3: Add `config` and `timezone` to the Merchant type**

In `apps/frontend/src/types.ts`, inside `interface Merchant`, after `pickup_address`:

```ts
  config?: Record<string, unknown>
  timezone?: string
```

- [ ] **Step 4: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Verify in the running app**

Run: `pnpm dev`, sign in as a merchant, open Shop Settings → Fulfilment.
Expected: the tab renders with lead 0, window 14, no closed days, timezone `Asia/Kuala_Lumpur`. Set lead 1, window 7, tick Mon, Save → a success toast. Reload the page → the tab shows exactly those values. Tick all seven days → the Save button disables and the hint says customers would have no date to pick.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/merchant/FulfilmentTab.tsx apps/frontend/src/merchant/ShopSettings.tsx apps/frontend/src/types.ts
git commit -m "feat(settings): Fulfilment tab for lead time, window, closed days, timezone

Writes through fulfilmentConfig, the same function the storefront reads
with, so the form cannot save a shape the picker reads back differently
— and shows back the clamped values rather than what was typed.

Saving all seven days closed is refused here, where the merchant can see
the checkboxes that caused it, rather than as an empty picker later."
```

---

### Task 6: The storefront picker

**Files:**
- Create: `apps/frontend/src/store/FulfilDatePicker.tsx`
- Modify: `apps/frontend/src/store/Storefront.tsx` (state, gate, render, submit, catch block)
- Modify: `apps/frontend/src/store.ts:577-613` (`placeOrder` signature and body), and its `OrderErrorCode` union

**Interfaces:**
- Consumes: `selectableDates`, `fulfilmentConfig`, `DEFAULT_TIMEZONE`, `weekdayOf` from `@bitetime/shared`; `serverNow()` from `useServerClock`; `merchants.config` / `merchants.timezone` (already returned by `GET /api/shops/:slug`, which selects `*`).
- Produces: `placeOrder({ ..., fulfilDate })`; frontend `OrderErrorCode` gains `'fulfil_date_unavailable'`.

- [ ] **Step 1: Build the picker**

Create `apps/frontend/src/store/FulfilDatePicker.tsx`:

```tsx
import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'

interface Props {
  /** Every date the shop is taking, `YYYY-MM-DD`, ascending. */
  available: string[]
  value: string | null
  onChange: (date: string) => void
  t: (en: string, zh: string) => string
  lang: 'en' | 'zh'
}

const DAY = 86_400_000
const ms = (date: string) => Date.parse(`${date}T00:00:00Z`)
const iso = (n: number) => new Date(n).toISOString().slice(0, 10)

/**
 * A month grid of the dates this shop is taking.
 *
 * Unavailable days render DISABLED rather than hidden. A customer who cannot find Monday
 * assumes the picker is broken; a customer who sees Monday greyed out learns the shop is shut
 * that day, which is the fact the merchant configured. Everything the grid shows is derived
 * from `available` — this component holds no rule of its own, so it cannot disagree with the
 * one the backend enforces.
 */
export default function FulfilDatePicker({ available, value, onChange, t, lang }: Props) {
  const open = useMemo(() => new Set(available), [available])
  const first = available[0] ?? null
  const last = available[available.length - 1] ?? null

  // Which month the grid is showing. Starts on the month holding the first available date, so
  // a shop with a week of lead time opens on the month the customer can actually order in.
  const [cursor, setCursor] = useState(() => {
    const d = new Date(first ? ms(first) : Date.now())
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() }
  })

  const monthLabel = new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-GB', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(Date.UTC(cursor.year, cursor.month, 1)))

  const weekdayLabels = [
    t('Su', '日'), t('Mo', '一'), t('Tu', '二'), t('We', '三'),
    t('Th', '四'), t('Fr', '五'), t('Sa', '六'),
  ]

  const monthStart = Date.UTC(cursor.year, cursor.month, 1)
  const daysInMonth = new Date(Date.UTC(cursor.year, cursor.month + 1, 0)).getUTCDate()
  const leading = new Date(monthStart).getUTCDay() // blank cells before the 1st

  // Bounded by the window: there is nothing to see outside it, and a customer paging through
  // empty months is a customer who thinks the shop has no dates at all.
  const canPrev = first !== null && monthStart > ms(first)
  const canNext = last !== null && Date.UTC(cursor.year, cursor.month + 1, 1) <= ms(last)

  const step = (delta: number) => setCursor(c => {
    const d = new Date(Date.UTC(c.year, c.month + delta, 1))
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() }
  })

  if (available.length === 0) {
    return (
      <div className="text-[14px] text-rose-muted leading-[1.5]">
        {t('This shop is not taking orders for any date right now. Please check back later.',
           '本店目前暂不接受任何日期的订单，请稍后再试。')}
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <button
          type="button" onClick={() => step(-1)} disabled={!canPrev}
          aria-label={t('Previous month', '上个月')}
          className="w-9 h-9 rounded-md border border-clay-border bg-surface-raised text-ink disabled:opacity-35 disabled:cursor-not-allowed hover:enabled:border-oxblood transition-colors focus-visible:outline-2 focus-visible:outline-oxblood focus-visible:outline-offset-2"
        >‹</button>
        <div aria-live="polite" className="text-[14px] font-medium text-oxblood">{monthLabel}</div>
        <button
          type="button" onClick={() => step(1)} disabled={!canNext}
          aria-label={t('Next month', '下个月')}
          className="w-9 h-9 rounded-md border border-clay-border bg-surface-raised text-ink disabled:opacity-35 disabled:cursor-not-allowed hover:enabled:border-oxblood transition-colors focus-visible:outline-2 focus-visible:outline-oxblood focus-visible:outline-offset-2"
        >›</button>
      </div>

      <div className="grid grid-cols-7 gap-1" role="grid" aria-label={t('Choose a date', '选择日期')}>
        {weekdayLabels.map((w, i) => (
          <div key={i} className="text-[11px] text-rose-muted text-center py-1" aria-hidden="true">{w}</div>
        ))}
        {Array.from({ length: leading }, (_, i) => <div key={`pad-${i}`} />)}
        {Array.from({ length: daysInMonth }, (_, i) => {
          const date = iso(monthStart + i * DAY)
          const selectable = open.has(date)
          const selected = value === date
          return (
            <button
              key={date}
              type="button"
              disabled={!selectable}
              aria-pressed={selected}
              aria-label={date}
              onClick={() => onChange(date)}
              className={cn(
                'h-10 pointer-coarse:min-h-11 rounded-md text-[14px] font-sans transition-all border',
                'focus-visible:outline-2 focus-visible:outline-oxblood focus-visible:outline-offset-2',
                selected
                  ? 'border-[1.5px] border-oxblood bg-oxblood-tint text-oxblood font-medium'
                  : selectable
                    ? 'border-clay-border bg-surface-raised text-ink hover:border-oxblood cursor-pointer'
                    // Greyed, not gone: the customer must be able to SEE that the shop is shut
                    // on this day rather than wonder where it went.
                    : 'border-transparent bg-transparent text-ink/25 cursor-not-allowed',
              )}
            >
              {i + 1}
            </button>
          )
        })}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Wire it into the storefront**

In `apps/frontend/src/store/Storefront.tsx`:

Extend the `@bitetime/shared` import to include `selectableDates`, `fulfilmentConfig`, `DEFAULT_TIMEZONE`, and add:
```tsx
import FulfilDatePicker from './FulfilDatePicker'
```

Add state beside `const [mode, setMode] = useState<'pickup' | 'delivery'>('pickup')`:
```tsx
  const [fulfilDate, setFulfilDate] = useState<string | null>(null)
```

After `const now = serverNow()` (line ~257), derive the offered dates:
```tsx
  // The SHOP's window, on the SHOP's clock — `now` is the server-corrected time the same
  // breakdown prices with. The list is derived, never stored: a checkout left open across
  // midnight re-renders with yesterday dropped, so the customer cannot submit a date the
  // backend would refuse.
  const fulfilDates = useMemo(
    () => selectableDates(fulfilmentConfig(merchant?.config), merchant?.timezone ?? DEFAULT_TIMEZONE, now),
    [merchant?.config, merchant?.timezone, now],
  )
  // A date the shop stopped offering while the page sat open is not a selection any more.
  const chosenDate = fulfilDate && fulfilDates.includes(fulfilDate) ? fulfilDate : null
```

Extend the submit gate (line ~297):
```tsx
  const canSubmit = cartItems.length > 0 && name.trim() !== '' && wa.trim() !== '' && !busy && deliveryReady && chosenDate !== null
```

Render the picker between the fulfilment block and the `<hr>` that precedes the checkout gate — inside the same `<div className="mb-7">` that closes after the delivery address fields, add a sibling block right after it:

```tsx
          <hr className="border-0 border-t border-clay-border my-6" />

          {/* When */}
          <div className="mb-7">
            <div className="text-[11px] font-medium text-oxblood uppercase tracking-[0.09em] mb-3">
              {t('Date', '日期')} *
            </div>
            <FulfilDatePicker
              available={fulfilDates}
              value={chosenDate}
              onChange={setFulfilDate}
              t={t}
              lang={lang}
            />
          </div>
```

Pass it to `placeOrder` inside `handleSubmit`, after `voucherCode`:
```tsx
        fulfilDate: chosenDate,
```

- [ ] **Step 3: Send it, and name the refusal**

In `apps/frontend/src/store.ts`, add `'fulfil_date_unavailable'` to the `OrderErrorCode` union (the deliberate twin of the backend's), then extend `placeOrder`'s parameter object type with:

```ts
  /** `YYYY-MM-DD` on the shop's clock. The backend re-checks it against the shop's window. */
  fulfilDate: string | null
```

destructure it in the signature alongside `voucherCode`, and add it to the `JSON.stringify` body:

```ts
      cart, quotedTotal, voucherCode, fulfilDate,
```

- [ ] **Step 4: Handle the refusal in the catch block**

In `Storefront.tsx`'s `handleSubmit` catch chain, after the `delivery_state_required` branch:

```tsx
      } else if (code === 'fulfil_date_unavailable') {
        // Reachable honestly: a checkout left open past midnight, or a merchant who closed a
        // day while this customer was typing. Clearing the selection is what RECOVERS it — the
        // re-render rebuilds the window from the corrected clock, and the stale date is gone
        // from the grid rather than sitting there selected and refused on every retry.
        setFulfilDate(null)
        const msg = t(
          'That date is no longer available. Please choose another one.',
          '该日期已不可选，请重新选择日期。',
        )
        setError(msg)
        toast.error(msg)
```

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Verify in the running app**

Run: `pnpm dev`, open `/s/<slug>`.
Expected:
- A DATE section appears between Fulfilment and Your Details, with a month grid.
- With default config, today and the next 13 days are pickable; day 15 onward is greyed.
- Place Order stays disabled until a date is picked.
- Set lead 1 and closed Mondays in the merchant Fulfilment tab, reload the storefront: today is greyed and every Monday is greyed.
- Switching between Pickup and Delivery leaves the picker unchanged (same rules for both).
- Place an order → succeeds, and `select fulfil_date from orders order by created_at desc limit 1` shows the chosen date.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/store/FulfilDatePicker.tsx apps/frontend/src/store/Storefront.tsx apps/frontend/src/store.ts
git commit -m "feat(storefront): customers pick the date they want their order on

The grid is derived from selectableDates on the server-corrected clock,
so a checkout left open across midnight re-renders without yesterday
rather than submitting a date intake would refuse.

Unavailable days are greyed, not hidden: a customer who cannot find
Monday thinks the picker is broken, one who sees it greyed learns the
shop is shut."
```

---

### Task 7: The date reaches the merchant

**Files:**
- Modify: `apps/backend/src/notify.ts:47-66` (`buildOrderMessage`)
- Modify: `apps/backend/tests/unit/notify.test.ts` (existing suite)
- Modify: `apps/frontend/src/types.ts` (`Order`)
- Modify: `apps/frontend/src/merchant/OrdersView.tsx` (merchant order list)
- Modify: `apps/frontend/src/store/OrderHistory.tsx`, `apps/frontend/src/store/TrackOrder.tsx`, `apps/frontend/src/store/ReceiptDialog.tsx` (the three customer-facing surfaces that already render `formatOrderDate`)

**Interfaces:**
- Consumes: `orders.fulfil_date` (Task 2), written since Task 3.
- Produces: nothing new.

- [ ] **Step 1: Write the failing notify test**

In `apps/backend/tests/unit/notify.test.ts`, following the existing `buildOrderMessage` cases:

```ts
  it('prints the fulfilment date when the order carries one', () => {
    const msg = buildOrderMessage({ ...baseOrder, fulfil_date: '2026-07-22' })
    expect(msg).toContain('*Date:* 2026-07-22')
  })

  it('omits the line entirely for a legacy order with no date', () => {
    const msg = buildOrderMessage({ ...baseOrder, fulfil_date: null })
    expect(msg).not.toContain('*Date:*')
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @bitetime/backend test -- notify`
Expected: FAIL — `expected '…' to contain '*Date:* 2026-07-22'`.

- [ ] **Step 3: Implement**

In `apps/backend/src/notify.ts`, inside `buildOrderMessage`, after the `Mode` line:

```ts
  // The merchant reading this on their phone is the person scheduling around it, so it sits
  // with the mode rather than down by the totals. Omitted rather than blanked for rows written
  // before #91 — `orders.fulfil_date` is null for every one of them, and a `*Date:* ` with
  // nothing after it reads as data we lost.
  if (order.fulfil_date) msg += `*Date:* ${order.fulfil_date}\n`
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @bitetime/backend test -- notify`
Expected: PASS.

- [ ] **Step 5: Add it to the Order type**

In `apps/frontend/src/types.ts`, inside `interface Order`, after `created_at`:

```ts
  /** `YYYY-MM-DD`. Null on orders placed before fulfilment dates shipped. */
  fulfil_date?: string | null
```

- [ ] **Step 6: Show it in the order lists**

Four surfaces render an order's date today: `merchant/OrdersView.tsx`, `store/OrderHistory.tsx`, `store/TrackOrder.tsx`, `store/ReceiptDialog.tsx`. In each, beside the existing `created_at` (when the order was PLACED), add the fulfilment date (when the customer WANTS it), using the same styling as the neighbouring metadata:

```tsx
{order.fulfil_date
  ? <span>{t('For', '取货日')} {formatOrderDate(order.fulfil_date, lang)}</span>
  : <span>—</span>}
```

`formatOrderDate` accepts a `YYYY-MM-DD` string — `new Date('2026-07-22')` parses as UTC midnight and `toLocaleDateString` renders it in the viewer's zone, which for any zone at or east of UTC (including MYT) shows the same calendar day. Do not "fix" this by appending a time.

- [ ] **Step 7: Typecheck, lint, verify**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS.

Run: `pnpm dev`, place a storefront order with a date, then open the merchant dashboard order list.
Expected: the row shows the chosen date; an order placed before this feature shows `—`. If Telegram is configured for the shop, the alert carries a `Date:` line.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/notify.ts apps/backend/tests/unit/notify.test.ts apps/frontend/src/types.ts apps/frontend/src
git commit -m "feat(orders): show the fulfilment date to the merchant

Telegram carries it beside the mode, because the merchant reading that
alert is the one scheduling around it. Legacy rows omit the line rather
than print an empty one — a blank Date reads as data we lost."
```

---

### Task 8: Make the date required

**Files:**
- Modify: `apps/backend/src/orders.ts` (`OrderErrorCode`, `PlaceOrderInput`, the validation block)
- Modify: `apps/frontend/src/store.ts` (`OrderErrorCode` twin)
- Modify: `apps/frontend/src/store/Storefront.tsx` (catch block)
- Test: `apps/backend/tests/api/orders.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `OrderErrorCode` gains `'fulfil_date_required'`; `PlaceOrderInput.fulfilDate` becomes `string`.

Do this last. Until the storefront sends a date (Task 6), requiring one refuses every order.

- [ ] **Step 1: Write the failing test**

In `apps/backend/tests/api/orders.test.ts`:

```ts
  it('refuses an order with no fulfilment date', async () => {
    const body = validOrderBody() // carries no fulfilDate
    const res = await app.request('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'fulfil_date_required' })
  })
```

Then update every pre-existing case in the suite that posts an order body to include a valid `fulfilDate: tomorrowInShopZone()` — a required field is required for all of them, and leaving them dateless would turn unrelated assertions into date refusals.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @bitetime/backend test:db -- orders`
Expected: FAIL — the dateless order returns 200.

- [ ] **Step 3: Implement**

In `apps/backend/src/orders.ts`, add to `OrderErrorCode`:

```ts
  | 'fulfil_date_required'
```

Change `PlaceOrderInput.fulfilDate` from optional to required, and replace its comment's last paragraph:

```ts
  /**
   * The date the customer asked for, `YYYY-MM-DD`, on the SHOP's clock.
   *
   * Checked here against the shop's own window, never taken on trust: the picker that produced
   * it runs in the customer's browser, and a body is a body.
   */
  fulfilDate: string | null
```

Replace the validation block in `placeOrder`:

```ts
    // Before the counter moves. A refused date must cost the shop nothing — not a burnt order
    // number, not a claimed voucher — and throwing here rolls back a transaction that has not
    // yet written anything anyway.
    //
    // Two codes, not one: "you sent nothing" and "the shop is not taking that day" are
    // different things for the customer to do about, and the storefront says so.
    if (input.fulfilDate == null || input.fulfilDate === '') {
      throw new OrderError('fulfil_date_required')
    }
    if (!isDateSelectable(input.fulfilDate, merchant.fulfilment, merchant.timezone, now)) {
      throw new OrderError('fulfil_date_unavailable')
    }
```

and simplify the insert value from `${input.fulfilDate ?? null}` to `${input.fulfilDate}`.

- [ ] **Step 4: Mirror the code on the frontend**

In `apps/frontend/src/store.ts`, add `'fulfil_date_required'` to the `OrderErrorCode` union.

In `Storefront.tsx`, extend the catch branch added in Task 6 to cover both:

```tsx
      } else if (code === 'fulfil_date_unavailable' || code === 'fulfil_date_required') {
        // `fulfil_date_required` is unreachable from this form — `canSubmit` will not let a
        // dateless order be submitted — and it is here precisely because that gate is the ONLY
        // thing making it so. `fulfil_date_unavailable` IS reachable honestly: a checkout left
        // open past midnight, or a merchant who closed a day mid-checkout. Clearing the
        // selection is what recovers it, since the re-render drops the stale date from the grid.
        setFulfilDate(null)
        const msg = t(
          'Please choose a date for your order.',
          '请选择订单日期。',
        )
        setError(msg)
        toast.error(msg)
```

- [ ] **Step 5: Run the full suite**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm --filter @bitetime/backend test:db`
Expected: PASS across all four.

- [ ] **Step 6: Verify end to end**

Run: `pnpm dev`. Place a storefront order picking a date → succeeds and the merchant list shows it. In the merchant Fulfilment tab close every weekday except one, reload the storefront → only that weekday is pickable.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/orders.ts apps/frontend/src/store.ts apps/frontend/src/store/Storefront.tsx apps/backend/tests/api/orders.test.ts
git commit -m "feat(orders): a fulfilment date is now required on every new order

Last in the sequence deliberately: requiring one before the storefront
sent one would have refused every order in between.

Two codes rather than one — a missing date and an unavailable date are
different things for the customer to act on, and only the second is
reachable from an honest checkout.

Closes #91"
```

---

## Notes for the implementer

- **Do not mock the database** in `tests/api` or `tests/rls`. They exist to prove properties of real Postgres; a mocked run reports green while asserting nothing.
- **`orders.fulfil_date` never becomes NOT NULL.** If a later change wants that, it needs a story for pre-#91 rows that is not an invented date.
- **`selectableDates` and `isDateSelectable` must stay in agreement.** Task 1 pins that with a test; if you add a rule to one, the test will tell you that you forgot the other.
- **The picker holds no rule.** Everything it renders comes from the `available` array. Resist adding a "but also allow…" condition inside the component — it would be a rule the backend does not enforce.
