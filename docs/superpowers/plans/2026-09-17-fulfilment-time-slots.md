# Fulfilment Time Slots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer picks a time slot after the date. The merchant sets opening hours, a slot length and a notice, so the customer cannot pick a time the shop does not serve.

**Architecture:** The slot rule lives in `packages/shared/src/fulfilment.ts` next to the date rule. The storefront builds its picker from `selectableSlots`, and order intake judges the body with `isSlotSelectable`, inside the order transaction. The order row stores both ends of the slot. The whole feature is off until a merchant turns `slots_enabled` on.

**Tech Stack:** TypeScript, Vitest, Hono, postgres.js, React 19, shadcn/ui, Supabase migrations (SQL).

**Spec:** `docs/superpowers/specs/2026-09-17-fulfilment-time-slots-design.md`

## Global Constraints

- Every rule that both sides of the wire read lives in `@bitetime/shared`. No copy in either app.
- `fulfilmentConfig` never throws. A junk value reads as its fallback, per field.
- `slots_enabled` defaults to `false`. An existing shop must see no change.
- Slot times are `HH:MM`, 24-hour, shop-local. The order row stores `time` columns. Postgres returns them as `HH:MM:SS`; every reader slices to `HH:MM`.
- New refusal codes: `fulfil_time_required` and `fulfil_time_unavailable`, both `409`.
- New order event kind: `fulfil_time_changed`, detail `{ from: 'HH:MM-HH:MM' | null, to: 'HH:MM-HH:MM' | null }`.
- Migrations are idempotent (`if not exists`, `drop constraint if exists`). Apply locally with `pnpm --filter @bitetime/backend db:migrate`. Never run `db:push`.
- Run commands from the repo root. `pnpm test` runs every unit suite. `pnpm --filter @bitetime/backend test:db` needs a running local Supabase (`supabase start` from `apps/backend`).
- Commit messages: Conventional Commits, STE. End each with `Claude-Session: https://claude.ai/code/session_01MsAqEnXM2x5a1QkTJQxTAN`.
- User-facing copy is `t(en, zh)`. Every new string needs both.
- Backend relative imports keep `.js` specifiers.

---

## File map

| File | Responsibility |
|---|---|
| `packages/shared/src/fulfilment.ts` | Config fields, `selectableSlots`, `isSlotSelectable`, `slotsBetween`, `validateSlotHours`, `no_slots` warning, date rule gated on slots |
| `packages/shared/src/fulfilment.test.ts` | Unit tests for all of the above |
| `packages/shared/src/refusal.ts` | The two new codes |
| `packages/shared/src/orderEvents.ts` | The new event kind |
| `packages/shared/src/index.ts` | Exports |
| `apps/backend/supabase/migrations/20260917120000_fulfilment_time_slots.sql` | Two `time` columns on `orders` + pair check |
| `apps/backend/supabase/migrations/20260917120100_order_events_fulfil_time.sql` | Event kind check |
| `apps/backend/src/orders.ts` | Intake slot gate, insert, PATCH slot judgement |
| `apps/backend/src/orderSlotPatch.ts` | Pure: judge a merchant's slot/date patch |
| `apps/backend/src/orderEvents.ts` | `OrderPatch`/`OrderPatchBefore` slot fields, `fulfil_time_changed` draft |
| `apps/backend/src/writes.ts` | `pickOrderFields` slot pair |
| `apps/backend/src/app.ts` | Route body parse, merchant config validation |
| `apps/backend/src/fulfilSlotLabel.ts` | Pure: `'14:00 – 15:00'` from two DB values |
| `apps/backend/src/notify.ts`, `orderEmails.ts` | Slot on the date line |
| `apps/frontend/src/types.ts` | `Order` slot fields |
| `apps/frontend/src/orderDate.ts` | `formatSlotRange` |
| `apps/frontend/src/store.ts` | `placeOrder` slot, `setOrderFulfilment` |
| `apps/frontend/src/store/submitGate.ts` | Slot required → chosen |
| `apps/frontend/src/store/orderRefusal.ts` | Copy + `clear_slot` action |
| `apps/frontend/src/store/FulfilSlotPicker.tsx` | Slot buttons |
| `apps/frontend/src/store/Storefront.tsx` | Wiring, minute tick, success screen |
| `apps/frontend/src/store/OrderHistory.tsx` | Slot on the "For" line |
| `apps/frontend/src/merchant/FulfilmentTab.tsx` | "Time slots" card |
| `apps/frontend/src/merchant/FulfilmentDatesBanner.tsx` | `no_slots` copy |
| `apps/frontend/src/merchant/orderDetail/CustomerCard.tsx`, `OrderDetailSheet.tsx`, `OrderHeader.tsx`, `orderEventLine.ts` | Drawer slot edit, display, log line |
| `apps/frontend/src/merchant/OrdersView.tsx` | Slot in the date column |
| `CONTEXT.md`, `docs/adr/0027-…md` | Docs |

---

### Task 1: Config fields and the reader

**Files:**
- Modify: `packages/shared/src/fulfilment.ts:8-40` (types, defaults), `:86-116` (`fulfilmentConfig`)
- Test: `packages/shared/src/fulfilment.test.ts`

**Interfaces:**
- Produces: `SlotMinutes`, `SLOT_MINUTES`, `SLOT_NOTICE_MAX`, `DayHours`, `Slot`, `FulfilmentConfig.{slots_enabled, hours, slot_minutes, slot_notice_minutes}`, `timeToMinutes(v: unknown): number | null`, `minutesToTime(min: number): string`, `DEFAULT_HOURS`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/fulfilment.test.ts`:

```ts
describe('fulfilmentConfig — time slots', () => {
  it('reads a shop that predates slots as slots off, with default hours', () => {
    const cfg = fulfilmentConfig({ fulfilment: { mode: 'rolling' } })
    expect(cfg.slots_enabled).toBe(false)
    expect(cfg.slot_minutes).toBe(60)
    expect(cfg.slot_notice_minutes).toBe(0)
    expect(cfg.hours).toEqual(Array.from({ length: 7 }, () => ({ open: '09:00', close: '18:00' })))
  })

  it('reads slots_enabled as a real boolean only', () => {
    expect(fulfilmentConfig({ fulfilment: { slots_enabled: true } }).slots_enabled).toBe(true)
    expect(fulfilmentConfig({ fulfilment: { slots_enabled: 'true' } }).slots_enabled).toBe(false)
    expect(fulfilmentConfig({ fulfilment: { slots_enabled: 1 } }).slots_enabled).toBe(false)
  })

  it('reads hours per weekday and turns a junk day into closed without touching the others', () => {
    const hours = [
      null,
      { open: '10:00', close: '14:00' },
      { open: '14:00', close: '10:00' },   // close before open
      { open: '9:00', close: '18:00' },    // not HH:MM
      'lunch',
      { open: '08:30', close: '08:30' },   // zero length
      { open: '00:00', close: '23:30' },
    ]
    expect(fulfilmentConfig({ fulfilment: { hours } }).hours).toEqual([
      null,
      { open: '10:00', close: '14:00' },
      null,
      null,
      null,
      null,
      { open: '00:00', close: '23:30' },
    ])
  })

  it('reads a short or missing hours array as default for the missing days', () => {
    const cfg = fulfilmentConfig({ fulfilment: { hours: [{ open: '10:00', close: '12:00' }] } })
    expect(cfg.hours[0]).toEqual({ open: '10:00', close: '12:00' })
    expect(cfg.hours[1]).toBeNull()
    expect(cfg.hours).toHaveLength(7)
  })

  it('reads slot_minutes from the closed set only', () => {
    expect(fulfilmentConfig({ fulfilment: { slot_minutes: 30 } }).slot_minutes).toBe(30)
    expect(fulfilmentConfig({ fulfilment: { slot_minutes: 120 } }).slot_minutes).toBe(120)
    expect(fulfilmentConfig({ fulfilment: { slot_minutes: 45 } }).slot_minutes).toBe(60)
    expect(fulfilmentConfig({ fulfilment: { slot_minutes: '60' } }).slot_minutes).toBe(60)
  })

  it('clamps slot_notice_minutes to 0..1440', () => {
    expect(fulfilmentConfig({ fulfilment: { slot_notice_minutes: -5 } }).slot_notice_minutes).toBe(0)
    expect(fulfilmentConfig({ fulfilment: { slot_notice_minutes: 90.7 } }).slot_notice_minutes).toBe(90)
    expect(fulfilmentConfig({ fulfilment: { slot_notice_minutes: 99_999 } }).slot_notice_minutes).toBe(1440)
  })
})

describe('timeToMinutes / minutesToTime', () => {
  it('round-trips HH:MM', () => {
    expect(timeToMinutes('00:00')).toBe(0)
    expect(timeToMinutes('09:30')).toBe(570)
    expect(timeToMinutes('23:59')).toBe(1439)
    expect(minutesToTime(570)).toBe('09:30')
    expect(minutesToTime(0)).toBe('00:00')
  })

  it('refuses anything that is not a 24-hour HH:MM', () => {
    for (const v of ['24:00', '9:30', '09:60', '0930', '', null, 930, undefined]) {
      expect(timeToMinutes(v), String(v)).toBeNull()
    }
  })
})
```

Add `timeToMinutes, minutesToTime` to the import list at the top of the test file.

Note: a short `hours` array reads the missing days as **closed**, not default. When the key is present the merchant sent a list, and a day they did not send is a day they did not open. Only a **missing** key reads as the default.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @bitetime/shared test -- fulfilment`
Expected: FAIL — `timeToMinutes` is not exported; `slots_enabled` is `undefined`.

- [ ] **Step 3: Add the types, defaults and the reader**

In `packages/shared/src/fulfilment.ts`, after `FulfilmentMode`:

```ts
/** The slot lengths a shop may pick. Closed set — the form offers exactly these. */
export type SlotMinutes = 30 | 60 | 120
export const SLOT_MINUTES: readonly SlotMinutes[] = [30, 60, 120]

/** The longest notice a shop may ask for: one day. Beyond that, `lead_days` is the tool. */
export const SLOT_NOTICE_MAX = 1440

/** One weekday's opening hours, `HH:MM` 24-hour, shop-local. `close` is after `open`. */
export interface DayHours { open: string; close: string }

/** One window a customer may pick, `HH:MM` both ends, `to` = `from` + `slot_minutes`. */
export interface Slot { from: string; to: string }
```

Extend `FulfilmentConfig` after `needs_review`:

```ts
  /**
   * The customer picks a TIME SLOT after the date. Off for every shop until its owner turns it
   * on, so the day this shipped changed nothing for anyone. While off, `hours`, `slot_minutes`
   * and `slot_notice_minutes` are dormant — kept in the row like an unused mode's settings.
   */
  slots_enabled: boolean
  /** Opening hours per weekday, index 0 = Sunday … 6 = Saturday. `null` = closed that day. */
  hours: (DayHours | null)[]
  /** How long one slot is. */
  slot_minutes: SlotMinutes
  /** A slot must START at least this many minutes after now, on the shop's clock. */
  slot_notice_minutes: number
```

Add to `DEFAULT_FULFILMENT`:

```ts
export const DEFAULT_HOURS: readonly (DayHours | null)[] =
  Array.from({ length: 7 }, () => ({ open: '09:00', close: '18:00' }))

export const DEFAULT_FULFILMENT: FulfilmentConfig = {
  mode: 'rolling',
  lead_days: 0,
  window_days: 14,
  closed_weekdays: [],
  custom_dates: [],
  needs_review: false,
  slots_enabled: false,
  hours: DEFAULT_HOURS.map(h => (h ? { ...h } : null)),
  slot_minutes: 60,
  slot_notice_minutes: 0,
}
```

Add the time helpers near `clampInt`:

```ts
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/** `HH:MM` (24-hour) as minutes since midnight, or null for anything else. */
export function timeToMinutes(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const m = TIME_RE.exec(v)
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

export function minutesToTime(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
}

/** One weekday's hours off the raw bag. Anything that is not a real, non-empty range reads as closed. */
function dayHours(raw: unknown): DayHours | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const open = timeToMinutes(r.open)
  const close = timeToMinutes(r.close)
  if (open === null || close === null || close <= open) return null
  return { open: r.open as string, close: r.close as string }
}

/**
 * Seven days of hours off the raw bag. A MISSING key reads as the default week: the merchant
 * never opened the card. A PRESENT array reads day by day, and a day the array does not name is
 * closed — the merchant sent a list, and a day they did not send is a day they did not open.
 */
function hoursFromRaw(raw: unknown): (DayHours | null)[] {
  if (raw === undefined) return DEFAULT_HOURS.map(h => (h ? { ...h } : null))
  const src = Array.isArray(raw) ? raw : []
  return Array.from({ length: 7 }, (_, i) => dayHours(src[i]))
}
```

Extend the object `fulfilmentConfig` returns:

```ts
    needs_review: f.needs_review === true,
    slots_enabled: f.slots_enabled === true,
    hours: hoursFromRaw(f.hours),
    slot_minutes: (SLOT_MINUTES as readonly number[]).includes(f.slot_minutes as number)
      ? (f.slot_minutes as SlotMinutes)
      : DEFAULT_FULFILMENT.slot_minutes,
    slot_notice_minutes: clampInt(f.slot_notice_minutes, 0, SLOT_NOTICE_MAX, DEFAULT_FULFILMENT.slot_notice_minutes),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @bitetime/shared test -- fulfilment`
Expected: PASS, including every pre-existing test (the fixtures spread `DEFAULT_FULFILMENT`).

- [ ] **Step 5: Export and typecheck**

In `packages/shared/src/index.ts`, extend the `./fulfilment.js` export block:

```ts
export {
  fulfilmentConfig, isTimezone, todayInZone,
  isDateSelectable, selectableDates,
  customDateBounds, pruneCustomDates, validateCustomDates,
  fulfilmentWarning,
  timeToMinutes, minutesToTime,
  DEFAULT_FULFILMENT, DEFAULT_TIMEZONE, DEFAULT_HOURS,
  FULFILMENT_HORIZON_DAYS, MAX_CUSTOM_DATES, DATES_ENDING_SOON_DAYS,
  SLOT_MINUTES, SLOT_NOTICE_MAX,
} from './fulfilment.js'
export type {
  FulfilmentConfig, FulfilmentMode, CustomDatesError, FulfilmentWarning,
  SlotMinutes, DayHours, Slot,
} from './fulfilment.js'
```

Run: `pnpm typecheck`
Expected: PASS. The `FulfilmentTab` save path builds its bag through `fulfilmentConfig`, so the new fields fall to defaults there — no compile error.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/fulfilment.ts packages/shared/src/fulfilment.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): read time slot settings off the fulfilment config

Adds slots_enabled, hours, slot_minutes and slot_notice_minutes. Every field
falls back on its own, and a shop that predates slots reads as slots off.

Claude-Session: https://claude.ai/code/session_01MsAqEnXM2x5a1QkTJQxTAN"
```

---

### Task 2: The slot rule

**Files:**
- Modify: `packages/shared/src/fulfilment.ts` (`selectableDates`, `isDateSelectable`, `fulfilmentWarning`, new functions)
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/fulfilment.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces:
  - `minutesInZone(tz: string, now: Date): number`
  - `slotsBetween(day: DayHours, slotMinutes: SlotMinutes): Slot[]`
  - `selectableSlots(date: string, cfg: FulfilmentConfig, tz: string, now: Date): Slot[]`
  - `isSlotSelectable(date: string, slot: Slot, cfg: FulfilmentConfig, tz: string, now: Date): boolean`
  - `type SlotHoursError = 'close_before_open' | 'no_open_day'`
  - `validateSlotHours(rawHours: unknown, cfg: FulfilmentConfig): SlotHoursError | null`
  - `FulfilmentWarning` gains `{ kind: 'no_slots' }`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/fulfilment.test.ts`. Add `selectableSlots, isSlotSelectable, slotsBetween, validateSlotHours, minutesInZone` to the import list.

```ts
// 2026-07-20 is a Monday. NOON_MYT is 12:00 in KL on that day.
const SLOTS: FulfilmentConfig = {
  ...DEFAULT_FULFILMENT,
  window_days: 3,
  slots_enabled: true,
  hours: [null, { open: '10:00', close: '14:00' }, { open: '10:00', close: '14:00' }, { open: '10:00', close: '14:00' }, null, null, null],
  slot_minutes: 60,
}

describe('minutesInZone', () => {
  it('reads the wall clock in the shop zone', () => {
    expect(minutesInZone(KL, NOON_MYT)).toBe(12 * 60)
    expect(minutesInZone('UTC', NOON_MYT)).toBe(4 * 60)
  })
  it('reads midnight as 0, never 1440', () => {
    expect(minutesInZone(KL, new Date('2026-07-19T16:00:00Z'))).toBe(0)
  })
})

describe('slotsBetween', () => {
  it('steps from open and drops the partial slot at the end', () => {
    expect(slotsBetween({ open: '10:00', close: '12:30' }, 60)).toEqual([
      { from: '10:00', to: '11:00' }, { from: '11:00', to: '12:00' },
    ])
    expect(slotsBetween({ open: '10:00', close: '12:30' }, 30)).toHaveLength(5)
    expect(slotsBetween({ open: '10:00', close: '11:59' }, 120)).toEqual([])
  })
})

describe('selectableSlots', () => {
  it('is empty while slots are off, whatever the hours say', () => {
    expect(selectableSlots('2026-07-21', { ...SLOTS, slots_enabled: false }, KL, NOON_MYT)).toEqual([])
  })

  it('offers every slot of a future open day', () => {
    expect(selectableSlots('2026-07-21', SLOTS, KL, NOON_MYT)).toEqual([
      { from: '10:00', to: '11:00' }, { from: '11:00', to: '12:00' },
      { from: '12:00', to: '13:00' }, { from: '13:00', to: '14:00' },
    ])
  })

  it('drops today’s slots that start before now + notice, and keeps one that starts exactly then', () => {
    // Monday 12:00. Slots at 10, 11, 12, 13. Notice 0: 12:00 and 13:00 remain.
    expect(selectableSlots('2026-07-20', SLOTS, KL, NOON_MYT).map(s => s.from)).toEqual(['12:00', '13:00'])
    // Notice 60: only 13:00.
    expect(selectableSlots('2026-07-20', { ...SLOTS, slot_notice_minutes: 60 }, KL, NOON_MYT).map(s => s.from)).toEqual(['13:00'])
    // Notice 61: nothing.
    expect(selectableSlots('2026-07-20', { ...SLOTS, slot_notice_minutes: 61 }, KL, NOON_MYT)).toEqual([])
  })

  it('applies the notice across midnight — a day of notice at noon Monday hides Tuesday morning', () => {
    const cfg = { ...SLOTS, slot_notice_minutes: 1440 }
    expect(selectableSlots('2026-07-21', cfg, KL, NOON_MYT).map(s => s.from)).toEqual(['12:00', '13:00'])
  })

  it('is empty on a weekday with no hours, and on a date the date rule refuses', () => {
    expect(selectableSlots('2026-07-23', SLOTS, KL, NOON_MYT)).toEqual([])   // Thursday: null hours
    expect(selectableSlots('2026-07-30', SLOTS, KL, NOON_MYT)).toEqual([])   // past the 3-day window
    expect(selectableSlots('2026-07-21', { ...SLOTS, closed_weekdays: [2] }, KL, NOON_MYT)).toEqual([])
  })

  it('uses the shop clock, not UTC, to decide which day is today', () => {
    // LATE_MYT: 01:00 Tuesday in KL, still Monday in UTC. Tuesday 10:00 is 9h away — all four remain.
    expect(selectableSlots('2026-07-21', SLOTS, KL, LATE_MYT)).toHaveLength(4)
    // Monday is over on the shop clock: nothing.
    expect(selectableSlots('2026-07-20', SLOTS, KL, LATE_MYT)).toEqual([])
  })
})

describe('isSlotSelectable', () => {
  const at = (from: string, to: string) => isSlotSelectable('2026-07-21', { from, to }, SLOTS, KL, NOON_MYT)

  it('accepts a slot on the grid and refuses one off it', () => {
    expect(at('10:00', '11:00')).toBe(true)
    expect(at('13:00', '14:00')).toBe(true)
    expect(at('10:30', '11:30')).toBe(false)   // off the step grid
    expect(at('10:00', '11:30')).toBe(false)   // wrong length
    expect(at('14:00', '15:00')).toBe(false)   // past close
    expect(at('09:00', '10:00')).toBe(false)   // before open
    expect(at('11:00', '10:00')).toBe(false)   // inverted
    expect(at('10:00', '')).toBe(false)
  })

  it('refuses everything while slots are off', () => {
    expect(isSlotSelectable('2026-07-21', { from: '10:00', to: '11:00' }, { ...SLOTS, slots_enabled: false }, KL, NOON_MYT)).toBe(false)
  })

  it('agrees with selectableSlots over a sweep of dates, clocks and notices', () => {
    const clocks = [NOON_MYT, LATE_MYT, new Date('2026-07-20T01:59:00Z'), new Date('2026-07-20T05:00:00Z')]
    const notices = [0, 30, 90, 1440]
    const dates = ['2026-07-19', '2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24']
    for (const now of clocks) for (const n of notices) for (const minutes of [30, 60, 120] as const) {
      const cfg = { ...SLOTS, slot_notice_minutes: n, slot_minutes: minutes }
      for (const date of dates) {
        const offered = selectableSlots(date, cfg, KL, now)
        const grid = slotsBetween({ open: '08:00', close: '16:00' }, minutes)
        for (const s of grid) {
          const listed = offered.some(o => o.from === s.from && o.to === s.to)
          expect(isSlotSelectable(date, s, cfg, KL, now), `${date} ${s.from} n=${n} m=${minutes} @${now.toISOString()}`).toBe(listed)
        }
      }
    }
  })
})

describe('the date rule when slots are on', () => {
  it('drops a date with no slot from selectableDates', () => {
    // Window Mon–Wed; Monday at noon still has 12:00 and 13:00; all three remain.
    expect(selectableDates(SLOTS, KL, NOON_MYT)).toEqual(['2026-07-20', '2026-07-21', '2026-07-22'])
    // At 13:01 Monday nothing is left today: Monday drops.
    const late = new Date('2026-07-20T05:01:00Z')
    expect(selectableDates(SLOTS, KL, late)).toEqual(['2026-07-21', '2026-07-22'])
    expect(isDateSelectable('2026-07-20', SLOTS, KL, late)).toBe(false)
    expect(isDateSelectable('2026-07-21', SLOTS, KL, late)).toBe(true)
  })

  it('treats a weekday with null hours as closed in both modes', () => {
    const thursdayOnly = { ...SLOTS, window_days: 7 }
    expect(selectableDates(thursdayOnly, KL, NOON_MYT)).not.toContain('2026-07-23')
    const c = custom(['2026-07-21', '2026-07-23'], { slots_enabled: true, hours: SLOTS.hours })
    expect(selectableDates(c, KL, NOON_MYT)).toEqual(['2026-07-21'])
    expect(isDateSelectable('2026-07-23', c, KL, NOON_MYT)).toBe(false)
  })

  it('ignores hours entirely while slots are off', () => {
    const off = { ...SLOTS, slots_enabled: false }
    expect(selectableDates(off, KL, NOON_MYT)).toEqual(['2026-07-20', '2026-07-21', '2026-07-22'])
  })

  it('isDateSelectable still agrees with selectableDates', () => {
    for (const now of [NOON_MYT, LATE_MYT, new Date('2026-07-20T05:01:00Z')]) {
      const list = selectableDates(SLOTS, KL, now)
      for (const d of consecutive(10, Date.UTC(2026, 6, 18))) {
        expect(isDateSelectable(d, SLOTS, KL, now), `${d} @${now.toISOString()}`).toBe(list.includes(d))
      }
    }
  })
})

describe('validateSlotHours', () => {
  it('passes normal hours, and passes anything while slots are off', () => {
    expect(validateSlotHours(SLOTS.hours, SLOTS)).toBeNull()
    expect(validateSlotHours([{ open: '14:00', close: '10:00' }], { ...SLOTS, slots_enabled: false })).toBeNull()
  })

  it('names close_before_open on the RAW hours, which the reader would have hidden', () => {
    const raw = [null, { open: '14:00', close: '10:00' }]
    expect(validateSlotHours(raw, fulfilmentConfig({ fulfilment: { slots_enabled: true, hours: raw } }))).toBe('close_before_open')
    expect(validateSlotHours([{ open: '10:00', close: '10:00' }], SLOTS)).toBe('close_before_open')
  })

  it('names no_open_day when no weekday holds one full slot', () => {
    const cfg = { ...SLOTS, hours: [null, null, null, null, null, null, null] }
    expect(validateSlotHours(cfg.hours, cfg)).toBe('no_open_day')
    const short = { ...SLOTS, slot_minutes: 120 as const, hours: [{ open: '10:00', close: '11:00' }, null, null, null, null, null, null] }
    expect(validateSlotHours(short.hours, short)).toBe('no_open_day')
  })
})

describe('fulfilmentWarning — no_slots', () => {
  it('reports no_slots when slots are on and no offered date holds a slot', () => {
    const cfg = { ...SLOTS, hours: [null, null, null, null, null, null, null] }
    expect(fulfilmentWarning(cfg, KL, NOON_MYT)).toEqual({ kind: 'no_slots' })
  })

  it('says nothing for a rolling slot shop with an open day', () => {
    expect(fulfilmentWarning(SLOTS, KL, NOON_MYT)).toEqual({ kind: 'none' })
  })

  it('reports empty, not no_slots, when a custom allowlist has run dry', () => {
    const c = custom(['2026-07-01'], { slots_enabled: true, hours: SLOTS.hours })
    expect(fulfilmentWarning(c, KL, NOON_MYT)).toEqual({ kind: 'empty' })
  })

  it('still reports review first', () => {
    expect(fulfilmentWarning({ ...SLOTS, needs_review: true }, KL, NOON_MYT)).toEqual({ kind: 'review' })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @bitetime/shared test -- fulfilment`
Expected: FAIL — the new functions are not exported.

- [ ] **Step 3: Implement the rule**

In `packages/shared/src/fulfilment.ts`:

Add after `todayInZone`:

```ts
/**
 * Minutes since midnight on the SHOP's clock. `hourCycle: 'h23'` so midnight reads 0, never 24.
 * The same fallback rule as `todayInZone`: a junk zone reads as the default, never throws.
 */
export function minutesInZone(tz: string, now: Date): number {
  const zone = isTimezone(tz) ? tz : DEFAULT_TIMEZONE
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now)
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? '0')
  return get('hour') * 60 + get('minute')
}
```

Rename the existing `isDateSelectable` body to a private `dateInRule` and the existing `selectableDates` body to a private `datesInRule`. Then add the slot core and the public functions:

```ts
/** The full grid of one day's hours: from `open`, stepping `slotMinutes`, dropping a slot that runs past `close`. */
export function slotsBetween(day: DayHours, slotMinutes: SlotMinutes): Slot[] {
  const open = timeToMinutes(day.open)
  const close = timeToMinutes(day.close)
  if (open === null || close === null) return []
  const out: Slot[] = []
  for (let from = open; from + slotMinutes <= close; from += slotMinutes) {
    out.push({ from: minutesToTime(from), to: minutesToTime(from + slotMinutes) })
  }
  return out
}

/**
 * The earliest minute, counted from the shop's midnight TODAY, at which a slot may start.
 * Minutes-since-today rather than an instant, so a day's offset is a plain `× 1440` and the
 * notice crosses midnight without a zone-offset calculation. (A DST shift inside the shop's own
 * zone would move this by an hour; the platform's shops have none, and an hour of notice is not
 * a price.)
 */
function earliestStart(cfg: FulfilmentConfig, tz: string, now: Date): number {
  return minutesInZone(tz, now) + cfg.slot_notice_minutes
}

/** A slot's start as minutes from the shop's midnight today. Null when either date is unreadable. */
function slotStartFromToday(date: string, from: number, tz: string, now: Date): number | null {
  const day = dayMs(date)
  const today = dayMs(todayInZone(tz, now))
  if (day === null || today === null) return null
  return Math.round((day - today) / DAY) * 1440 + from
}

/** The slots of one date that the DATE RULE has already accepted. */
function slotsOnDay(date: string, cfg: FulfilmentConfig, tz: string, now: Date): Slot[] {
  const ms = dayMs(date)
  if (ms === null) return []
  const hours = cfg.hours[new Date(ms).getUTCDay()]
  if (!hours) return []
  const earliest = earliestStart(cfg, tz, now)
  return slotsBetween(hours, cfg.slot_minutes).filter(s => {
    const start = slotStartFromToday(date, timeToMinutes(s.from)!, tz, now)
    return start !== null && start >= earliest
  })
}

/**
 * Every date this shop is currently taking orders for, in order. What the picker renders.
 *
 * With slots on, a date that holds no slot is not offered — a weekday with no hours, or today
 * once its last slot has passed — so the storefront never shows a day the customer cannot
 * complete. That filter lives HERE and in `isDateSelectable`, so intake refuses the same days.
 */
export function selectableDates(cfg: FulfilmentConfig, tz: string, now: Date): string[] {
  const dates = datesInRule(cfg, tz, now)
  if (!cfg.slots_enabled) return dates
  return dates.filter(d => slotsOnDay(d, cfg, tz, now).length > 0)
}

/** May this shop take an order for this date, right now? The intake check. Agrees with `selectableDates`. */
export function isDateSelectable(date: string, cfg: FulfilmentConfig, tz: string, now: Date): boolean {
  if (!dateInRule(date, cfg, tz, now)) return false
  return !cfg.slots_enabled || slotsOnDay(date, cfg, tz, now).length > 0
}

/**
 * Every slot this shop offers on this date, in order. What the slot picker renders.
 * Empty while slots are off, on a date the date rule refuses, and on a weekday with no hours.
 */
export function selectableSlots(date: string, cfg: FulfilmentConfig, tz: string, now: Date): Slot[] {
  if (!cfg.slots_enabled) return []
  if (!dateInRule(date, cfg, tz, now)) return []
  return slotsOnDay(date, cfg, tz, now)
}

/**
 * May this shop take an order for this slot on this date, right now?
 *
 * The intake predicate. Judged from the body's two strings without building a list, the way
 * `isDateSelectable` is — and a test sweeps the grid to pin that the two agree. A slot is only
 * selectable when it sits ON the step grid from `open` and is exactly `slot_minutes` long.
 */
export function isSlotSelectable(date: string, slot: Slot, cfg: FulfilmentConfig, tz: string, now: Date): boolean {
  if (!cfg.slots_enabled) return false
  if (!dateInRule(date, cfg, tz, now)) return false
  const ms = dayMs(date)
  if (ms === null) return false
  const hours = cfg.hours[new Date(ms).getUTCDay()]
  if (!hours) return false
  const from = timeToMinutes(slot.from)
  const to = timeToMinutes(slot.to)
  const open = timeToMinutes(hours.open)
  const close = timeToMinutes(hours.close)
  if (from === null || to === null || open === null || close === null) return false
  if (to - from !== cfg.slot_minutes) return false
  if (from < open || to > close || (from - open) % cfg.slot_minutes !== 0) return false
  const start = slotStartFromToday(date, from, tz, now)
  return start !== null && start >= earliestStart(cfg, tz, now)
}

export type SlotHoursError = 'close_before_open' | 'no_open_day'

/**
 * Why these hours cannot be saved, or null.
 *
 * Takes the RAW hours as well as the parsed config, for the reason `too_many` is counted on the
 * raw allowlist: `fulfilmentConfig` reads a `close <= open` day as closed, so the parsed config
 * can never show the mistake — and a merchant who typed it must be told, not quietly closed.
 * `no_open_day` is the slot twin of the all-seven-days-closed refusal.
 */
export function validateSlotHours(rawHours: unknown, cfg: FulfilmentConfig): SlotHoursError | null {
  if (!cfg.slots_enabled) return null
  if (Array.isArray(rawHours)) {
    for (const day of rawHours) {
      if (typeof day !== 'object' || day === null) continue
      const open = timeToMinutes((day as Record<string, unknown>).open)
      const close = timeToMinutes((day as Record<string, unknown>).close)
      if (open !== null && close !== null && close <= open) return 'close_before_open'
    }
  }
  const anyOpen = cfg.hours.some(h => h !== null && slotsBetween(h, cfg.slot_minutes).length > 0)
  return anyOpen ? null : 'no_open_day'
}
```

Extend `FulfilmentWarning` and `fulfilmentWarning`:

```ts
export type FulfilmentWarning =
  | { kind: 'none' }
  | { kind: 'review' }
  | { kind: 'empty' }
  /** Slots are on, the date rule offers days, and none of them holds a slot. */
  | { kind: 'no_slots' }
  | { kind: 'ending'; last: string; daysLeft: number }

export function fulfilmentWarning(cfg: FulfilmentConfig, tz: string, now: Date): FulfilmentWarning {
  if (cfg.needs_review) return { kind: 'review' }
  const byDate = datesInRule(cfg, tz, now)
  if (cfg.mode === 'custom' && byDate.length === 0) return { kind: 'empty' }
  const open = selectableDates(cfg, tz, now)
  if (cfg.slots_enabled && byDate.length > 0 && open.length === 0) return { kind: 'no_slots' }
  if (cfg.mode !== 'custom') return { kind: 'none' }
  if (open.length === 0) return { kind: 'empty' }
  const today = dayMs(todayInZone(tz, now))
  const last = open[open.length - 1]
  const lastMs = dayMs(last)
  if (today === null || lastMs === null) return { kind: 'none' }
  const daysLeft = Math.round((lastMs - today) / DAY)
  return daysLeft <= DATES_ENDING_SOON_DAYS ? { kind: 'ending', last, daysLeft } : { kind: 'none' }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @bitetime/shared test -- fulfilment`
Expected: PASS.

- [ ] **Step 5: Export, typecheck, run every suite**

Add `minutesInZone, slotsBetween, selectableSlots, isSlotSelectable, validateSlotHours` to the value exports and `SlotHoursError` to the type exports in `packages/shared/src/index.ts`.

Run: `pnpm typecheck && pnpm test`
Expected: PASS. `FulfilmentDatesBanner.tsx` compiles because `state.kind === 'no_slots'` falls into the non-urgent branch with an empty message — Task 12 fixes the copy.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/fulfilment.ts packages/shared/src/fulfilment.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): add the time slot rule next to the date rule

selectableSlots builds the picker, isSlotSelectable judges intake, and a
sweep pins that they agree. With slots on, a date with no slot is not offered.

Claude-Session: https://claude.ai/code/session_01MsAqEnXM2x5a1QkTJQxTAN"
```

---

### Task 3: Refusal codes, event kind, and their frontend words

**Files:**
- Modify: `packages/shared/src/refusal.ts:77-79, 151-152`
- Modify: `packages/shared/src/orderEvents.ts:14-38`
- Modify: `apps/frontend/src/store/orderRefusal.ts:34, 185-188`
- Modify: `apps/frontend/src/merchant/orderDetail/orderEventLine.ts:47-58`
- Test: `apps/frontend/src/store/orderRefusal.test.ts`, `apps/frontend/src/merchant/orderDetail/orderEventLine.test.ts`

**Interfaces:**
- Produces: `OrderRefusal` gains `'fulfil_time_unavailable' | 'fulfil_time_required'`; `OrderEventKind` gains `'fulfil_time_changed'`; `RefusalAction` gains `'clear_slot'`.

- [ ] **Step 1: Write the failing tests**

In `apps/frontend/src/store/orderRefusal.test.ts`, next to the `clear_date` assertions:

```ts
    expect(orderRefusalPlan('fulfil_time_unavailable', ctx()).actions).toEqual(['clear_slot'])
    expect(orderRefusalPlan('fulfil_time_required', ctx()).actions).toEqual(['clear_slot'])
```

In `apps/frontend/src/merchant/orderDetail/orderEventLine.test.ts`, next to the `fulfil_date_changed` cases:

```ts
    expect(orderEventLine(ev({ kind: 'fulfil_time_changed', detail: { from: '10:00-11:00', to: '14:00-15:00' } }), en))
      .toBe('You moved the time slot from 10:00 – 11:00 to 14:00 – 15:00')
    expect(orderEventLine(ev({ kind: 'fulfil_time_changed', detail: { from: null, to: '14:00-15:00' } }), en))
      .toBe('You set the time slot to 14:00 – 15:00')
    expect(orderEventLine(ev({ kind: 'fulfil_time_changed', detail: { from: '10:00-11:00', to: null } }), en))
      .toBe('You cleared the time slot')
```

- [ ] **Step 2: Add the codes and the kind, then run the tests**

`packages/shared/src/refusal.ts`, after `fulfil_date_required` in the union:

```ts
  /** The chosen slot is outside the shop's hours, off the grid, or too close to now. Also: one end without the other. */
  | 'fulfil_time_unavailable'
  /** No slot on an order at a shop that asks for one. */
  | 'fulfil_time_required'
```

and in `REFUSAL_STATUS`:

```ts
  fulfil_time_unavailable: 409,
  fulfil_time_required: 409,
```

`packages/shared/src/orderEvents.ts`, after `fulfil_date_changed`:

```ts
  /** `detail.from` → `detail.to`, each `'HH:MM-HH:MM'` or null. A slot shop can move one but never clear it. */
  'fulfil_time_changed',
```

Update the comment on `ORDER_EVENT_KINDS` so "last moved in" names `20260917120100_order_events_fulfil_time.sql`.

Run: `pnpm --filter @bitetime/frontend test -- orderRefusal orderEventLine`
Expected: FAIL — the exhaustiveness sweeps fail on the new code and kind; the switch does not compile.

- [ ] **Step 3: Add the words**

`apps/frontend/src/store/orderRefusal.ts`. Add to `RefusalAction`:

```ts
  /** Clear the chosen time slot so the stale one leaves the list. */
  | 'clear_slot'
```

Add a case before `invalid_body`:

```ts
    case 'fulfil_time_unavailable':
    case 'fulfil_time_required':
      // Same recovery as the date: clearing the selection re-renders the list without the slot
      // that closed. The date stays — the customer has not been told their DAY is gone.
      return { message: t('Please choose a time slot for your order.', '请选择订单时段。'), actions: ['clear_slot'] }
```

`apps/frontend/src/merchant/orderDetail/orderEventLine.ts`, after the `fulfil_date_changed` case:

```ts
    case 'fulfil_time_changed': {
      // `'HH:MM-HH:MM'` on the wire, an en dash with spaces on screen — the same shape the header
      // and the customer's confirmation print, so the log names the window the way they do.
      const label = (v: unknown) => (typeof v === 'string' ? v.replace('-', ' – ') : null)
      const to = label(e.detail.to)
      const from = label(e.detail.from)
      if (!to) return t('You cleared the time slot', '你清除了时段')
      if (!from) return t(`You set the time slot to ${to}`, `你将时段设为${to}`)
      return t(`You moved the time slot from ${from} to ${to}`, `你将时段从${from}改为${to}`)
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm typecheck && pnpm --filter @bitetime/frontend test -- orderRefusal orderEventLine`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/refusal.ts packages/shared/src/orderEvents.ts apps/frontend/src/store/orderRefusal.ts apps/frontend/src/store/orderRefusal.test.ts apps/frontend/src/merchant/orderDetail/orderEventLine.ts apps/frontend/src/merchant/orderDetail/orderEventLine.test.ts
git commit -m "feat: add the time slot refusals and the fulfil_time_changed event

Claude-Session: https://claude.ai/code/session_01MsAqEnXM2x5a1QkTJQxTAN"
```

---

### Task 4: Migrations

**Files:**
- Create: `apps/backend/supabase/migrations/20260917120000_fulfilment_time_slots.sql`
- Create: `apps/backend/supabase/migrations/20260917120100_order_events_fulfil_time.sql`

- [ ] **Step 1: Write the orders migration**

```sql
-- supabase/migrations/20260917120000_fulfilment_time_slots.sql
--
-- The slot the customer picked (#282), stored as BOTH ends. Not a start plus the shop's
-- `slot_minutes`: the merchant may change the slot length later, and the order records what the
-- customer was promised. Null on both means "placed with no slot" — before this feature, or at a
-- shop with slots off — the same rule `fulfil_date` uses for its null.
alter table public.orders
  add column if not exists fulfil_time_from time,
  add column if not exists fulfil_time_to time;

alter table public.orders
  drop constraint if exists orders_fulfil_time_pair;
alter table public.orders
  add constraint orders_fulfil_time_pair check (
    (fulfil_time_from is null and fulfil_time_to is null)
    or (fulfil_time_from is not null and fulfil_time_to is not null and fulfil_time_to > fulfil_time_from)
  );

comment on column public.orders.fulfil_time_from is
  'Start of the slot the customer picked, shop-local wall clock. Null: placed with no slot.';
comment on column public.orders.fulfil_time_to is
  'End of the slot the customer picked. Stored, not derived, so a later slot_minutes change does not rewrite history.';
```

- [ ] **Step 2: Write the order_events migration**

```sql
-- supabase/migrations/20260917120100_order_events_fulfil_time.sql
--
-- The order log gains `fulfil_time_changed`: a merchant moved the slot an order is for. Same
-- shape as 20260904150000_order_events_fulfil_date.sql — the constraint is dropped by its name
-- and re-added with the new member, so the next kind does the same thing. Adding a kind means
-- this constraint, `packages/shared/src/orderEvents.ts`, and the drawer's sentence table.
alter table public.order_events drop constraint if exists order_events_kind_check;

alter table public.order_events
  add constraint order_events_kind_check check (kind in (
    'created',
    'payment_proof_uploaded',
    'merchant_payment_proof_uploaded',
    'status_changed',
    'note_changed',
    'courier_changed',
    'awb_changed',
    'fulfil_date_changed',
    'fulfil_time_changed',
    'voucher_released',
    'voucher_restored'
  ));
```

- [ ] **Step 3: Apply locally and check**

Run from the repo root: `pnpm --filter @bitetime/backend db:migrate`
Expected: both versions apply. If it refuses over a version whose file is gone, follow the CLAUDE.md `repair --status reverted <version> --db-url <local>` note. Do not run `db reset` without asking.

Run: `cd apps/backend && supabase status -o env | grep DB_URL` then `psql "<that url>" -c "\d public.orders" | grep fulfil_time`
Expected: two `time without time zone` columns.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/supabase/migrations/20260917120000_fulfilment_time_slots.sql apps/backend/supabase/migrations/20260917120100_order_events_fulfil_time.sql
git commit -m "feat(db): store the fulfilment slot on orders and log slot moves

Applied locally. Production still needs db:push by a human.

Claude-Session: https://claude.ai/code/session_01MsAqEnXM2x5a1QkTJQxTAN"
```

---

### Task 5: Order intake stores the slot

**Files:**
- Modify: `apps/backend/src/orders.ts:71` (`PlaceOrderInput`), `:179-184` (gate), `:300-335` (insert)
- Modify: `apps/backend/src/app.ts:3330, 3363` (body parse)
- Test: `apps/backend/tests/api/orders.test.ts`

**Interfaces:**
- Consumes: `isSlotSelectable`, `Slot` from `@bitetime/shared`.
- Produces: `PlaceOrderInput.fulfilTimeFrom: string | null`, `PlaceOrderInput.fulfilTimeTo: string | null`. Wire body fields `fulfilTimeFrom`, `fulfilTimeTo`.

- [ ] **Step 1: Write the failing tests**

In `apps/backend/tests/api/orders.test.ts`, inside the existing `describe('fulfilment date'…)` block (the one that holds `fulfil_date_required`), add a nested block. Import `minutesToTime, minutesInZone` from `@bitetime/shared` at the top.

```ts
    describe('time slots', () => {
      // Open every weekday all day, 60-minute slots, no notice — so `tomorrowInShopZone()` at
      // 10:00–11:00 is certainly offered.
      const ALL_DAY = Array.from({ length: 7 }, () => ({ open: '00:00', close: '23:00' }))
      const slotShop = () => setFulfilmentConfig(shop, {
        lead_days: 0, window_days: 14, closed_weekdays: [],
        slots_enabled: true, hours: ALL_DAY, slot_minutes: 60, slot_notice_minutes: 0,
      })
      const withSlot = (over: Record<string, unknown> = {}) =>
        body(shop, productId, { fulfilDate: tomorrowInShopZone(), fulfilTimeFrom: '10:00', fulfilTimeTo: '11:00', ...over })

      it('stores both ends of the slot at a slot shop', async () => {
        await slotShop()
        const res = await post(withSlot())
        expect(res.status).toBe(200)
        const [order] = await ordersOf(shop)
        expect(order.fulfil_time_from).toBe('10:00:00')
        expect(order.fulfil_time_to).toBe('11:00:00')
      })

      it('refuses an order with no slot at a slot shop, and the counter does not move', async () => {
        await slotShop()
        const res = await post(body(shop, productId, { fulfilDate: tomorrowInShopZone() }))
        expect(res.status).toBe(409)
        expect(await errorOf(res)).toBe('fulfil_time_required')
        expect(await ordersOf(shop)).toEqual([])
        expect(await counterOf(shop)).toBeNull()
      })

      it('refuses a slot outside the hours, off the grid, of the wrong length, or half-sent', async () => {
        await slotShop()
        for (const [over, why] of [
          [{ fulfilTimeFrom: '23:00', fulfilTimeTo: '24:00' }, 'past close'],
          [{ fulfilTimeFrom: '10:30', fulfilTimeTo: '11:30' }, 'off the grid'],
          [{ fulfilTimeFrom: '10:00', fulfilTimeTo: '12:00' }, 'wrong length'],
          [{ fulfilTimeTo: undefined }, 'one end only'],
          [{ fulfilTimeFrom: 'ten', fulfilTimeTo: 'eleven' }, 'not a time'],
        ] as const) {
          const res = await post(withSlot(over as Record<string, unknown>))
          expect(res.status, why).toBe(409)
          expect(await errorOf(res), why).toBe('fulfil_time_unavailable')
        }
        expect(await ordersOf(shop)).toEqual([])
        expect(await counterOf(shop)).toBeNull()
      })

      it('refuses a same-day slot that starts inside the notice', async () => {
        await setFulfilmentConfig(shop, {
          lead_days: 0, window_days: 14, closed_weekdays: [],
          slots_enabled: true, hours: ALL_DAY, slot_minutes: 60, slot_notice_minutes: 1440,
        })
        // The next grid slot after now, today: certainly inside a day of notice.
        const nowMin = minutesInZone(DEFAULT_TIMEZONE, new Date())
        const from = Math.min(22, Math.floor(nowMin / 60) + 1) * 60
        const res = await post(body(shop, productId, {
          fulfilDate: todayInZone(DEFAULT_TIMEZONE, new Date()),
          fulfilTimeFrom: minutesToTime(from), fulfilTimeTo: minutesToTime(from + 60),
        }))
        expect(res.status).toBe(409)
        // Either the date has no slot left (date refusal) or the slot itself is too close. Both are honest.
        expect(['fulfil_date_unavailable', 'fulfil_time_unavailable']).toContain(await errorOf(res))
      })

      it('ignores a slot at a shop with slots off and stores nulls', async () => {
        const res = await post(withSlot())
        expect(res.status).toBe(200)
        const [order] = await ordersOf(shop)
        expect(order.fulfil_time_from).toBeNull()
        expect(order.fulfil_time_to).toBeNull()
      })
    })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @bitetime/backend test:db -- orders.test`
Expected: FAIL — `fulfil_time_from` is null at the slot shop; no `fulfil_time_required`.

- [ ] **Step 3: Implement**

`apps/backend/src/orders.ts`. Add to the import from `@bitetime/shared`: `isSlotSelectable`. Add to `PlaceOrderInput` after `fulfilDate`:

```ts
  /**
   * The slot the customer asked for, `HH:MM` both ends, on the SHOP's clock. Judged against the
   * shop's hours the way `fulfilDate` is judged against its window. Both null when the customer
   * sent none; at a shop with slots off, both are IGNORED and the row stores nulls.
   */
  fulfilTimeFrom: string | null
  fulfilTimeTo: string | null
```

After the `fulfil_date_unavailable` throw:

```ts
    // The slot, judged by the same rule the picker was built from, and BEFORE the counter moves
    // for the same reason as the date. Two codes again: "you sent no slot" and "that slot is not
    // open" want different things of the customer. A shop with slots OFF ignores whatever the
    // body says — a customer who loaded the page before the merchant flipped the switch must
    // not be refused for it — and the row stores nulls.
    const slotsOn = merchant.fulfilment.slots_enabled
    if (slotsOn) {
      if (input.fulfilTimeFrom == null && input.fulfilTimeTo == null) {
        throw new OrderError('fulfil_time_required')
      }
      if (
        input.fulfilTimeFrom == null || input.fulfilTimeTo == null ||
        !isSlotSelectable(input.fulfilDate, { from: input.fulfilTimeFrom, to: input.fulfilTimeTo }, merchant.fulfilment, merchant.timezone, now)
      ) {
        throw new OrderError('fulfil_time_unavailable')
      }
    }
    const fulfilTimeFrom = slotsOn ? input.fulfilTimeFrom : null
    const fulfilTimeTo = slotsOn ? input.fulfilTimeTo : null
```

In the `insert into orders (...)` column list, after `fulfil_date`, add `fulfil_time_from, fulfil_time_to`. In the `values`, after `${input.fulfilDate},`:

```ts
        ${fulfilTimeFrom},
        ${fulfilTimeTo},
```

`apps/backend/src/app.ts`, in `POST /api/orders` after the `fulfilDate` parse:

```ts
  // Same split as the date: the SHAPE here, the rule in `placeOrder`.
  const fulfilTimeFrom = typeof b.fulfilTimeFrom === 'string' ? b.fulfilTimeFrom : null
  const fulfilTimeTo = typeof b.fulfilTimeTo === 'string' ? b.fulfilTimeTo : null
```

and pass `fulfilTimeFrom, fulfilTimeTo,` into `placeOrder({...})` after `fulfilDate`.

Search `apps/backend` for every other `placeOrder(` call site or `PlaceOrderInput` literal (`grep -rn "fulfilDate:" apps/backend/src apps/backend/scripts apps/backend/tests`) and add `fulfilTimeFrom: null, fulfilTimeTo: null` where an object literal is typed as `PlaceOrderInput`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm typecheck && pnpm --filter @bitetime/backend test:db -- orders.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/orders.ts apps/backend/src/app.ts apps/backend/tests/api/orders.test.ts
git commit -m "feat(backend): judge and store the fulfilment slot at order intake

Claude-Session: https://claude.ai/code/session_01MsAqEnXM2x5a1QkTJQxTAN"
```

---

### Task 6: The merchant PATCH moves a slot

**Files:**
- Create: `apps/backend/src/orderSlotPatch.ts`
- Create: `apps/backend/tests/unit/orderSlotPatch.test.ts`
- Modify: `apps/backend/src/orderEvents.ts:12-58`
- Modify: `apps/backend/src/writes.ts:322-329`
- Modify: `apps/backend/src/orders.ts:471-510`
- Test: `apps/backend/tests/unit/orderEvents.test.ts`, `apps/backend/tests/api/order-events.test.ts`

**Interfaces:**
- Consumes: `isSlotSelectable`, `fulfilmentConfig`, `FulfilmentConfig` from shared.
- Produces:
  - `OrderPatchBefore.fulfil_time_from: string | null`, `.fulfil_time_to: string | null` (`HH:MM`)
  - `OrderPatch.fulfil_time_from?: string | null`, `.fulfil_time_to?: string | null`
  - `judgeSlotPatch(before, patch, cfg, tz, now): 'fulfil_time_unavailable' | null`
  - `PatchRefusal` gains `'fulfil_time_unavailable'`
  - Wire: PATCH body `fulfil_time_from` + `fulfil_time_to` together, both strings or both null.

- [ ] **Step 1: Write the failing unit tests**

`apps/backend/tests/unit/orderSlotPatch.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { DEFAULT_FULFILMENT, type FulfilmentConfig } from '@bitetime/shared'
import { judgeSlotPatch } from '../../src/orderSlotPatch.js'

const KL = 'Asia/Kuala_Lumpur'
const NOON_MYT = new Date('2026-07-20T04:00:00Z') // Monday 12:00 in KL
const ON: FulfilmentConfig = {
  ...DEFAULT_FULFILMENT,
  slots_enabled: true,
  hours: Array.from({ length: 7 }, () => ({ open: '10:00', close: '14:00' })),
}
const OFF: FulfilmentConfig = { ...ON, slots_enabled: false }
const before = (over: Partial<{ fulfil_date: string | null; fulfil_time_from: string | null; fulfil_time_to: string | null }> = {}) => ({
  fulfil_date: '2026-07-21', fulfil_time_from: '10:00', fulfil_time_to: '11:00', ...over,
})

describe('judgeSlotPatch', () => {
  it('passes a patch that names neither date nor slot', () => {
    expect(judgeSlotPatch(before(), { note: 'x' }, ON, KL, NOON_MYT)).toBeNull()
  })

  it('accepts an open slot and refuses a closed one on a slot shop', () => {
    expect(judgeSlotPatch(before(), { fulfil_time_from: '13:00', fulfil_time_to: '14:00' }, ON, KL, NOON_MYT)).toBeNull()
    expect(judgeSlotPatch(before(), { fulfil_time_from: '14:00', fulfil_time_to: '15:00' }, ON, KL, NOON_MYT)).toBe('fulfil_time_unavailable')
  })

  it('refuses clearing the slot on a slot shop, allows it on a shop with slots off', () => {
    expect(judgeSlotPatch(before(), { fulfil_time_from: null, fulfil_time_to: null }, ON, KL, NOON_MYT)).toBe('fulfil_time_unavailable')
    expect(judgeSlotPatch(before(), { fulfil_time_from: null, fulfil_time_to: null }, OFF, KL, NOON_MYT)).toBeNull()
  })

  it('on a shop with slots off, accepts the identical slot as a no-op but refuses a new one', () => {
    expect(judgeSlotPatch(before(), { fulfil_time_from: '10:00', fulfil_time_to: '11:00' }, OFF, KL, NOON_MYT)).toBeNull()
    expect(judgeSlotPatch(before(), { fulfil_time_from: '12:00', fulfil_time_to: '13:00' }, OFF, KL, NOON_MYT)).toBe('fulfil_time_unavailable')
  })

  it('judges a date move against the slot the row keeps', () => {
    // Wednesday is open 10–14 too: the kept 10:00 slot is fine.
    expect(judgeSlotPatch(before(), { fulfil_date: '2026-07-22' }, ON, KL, NOON_MYT)).toBeNull()
    // Thursday closed: the kept slot is not open there.
    const thuClosed = { ...ON, hours: ON.hours.map((h, i) => (i === 4 ? null : h)) }
    expect(judgeSlotPatch(before(), { fulfil_date: '2026-07-23' }, thuClosed, KL, NOON_MYT)).toBe('fulfil_time_unavailable')
  })

  it('judges a date move with a new slot against the NEW date', () => {
    const thuShort = { ...ON, hours: ON.hours.map((h, i) => (i === 4 ? { open: '12:00', close: '14:00' } : h)) }
    expect(judgeSlotPatch(before(), { fulfil_date: '2026-07-23', fulfil_time_from: '10:00', fulfil_time_to: '11:00' }, thuShort, KL, NOON_MYT)).toBe('fulfil_time_unavailable')
    expect(judgeSlotPatch(before(), { fulfil_date: '2026-07-23', fulfil_time_from: '12:00', fulfil_time_to: '13:00' }, thuShort, KL, NOON_MYT)).toBeNull()
  })

  it('lets a legacy order with no slot move its date at a slot shop without gaining one', () => {
    expect(judgeSlotPatch(before({ fulfil_time_from: null, fulfil_time_to: null }), { fulfil_date: '2026-07-22' }, ON, KL, NOON_MYT)).toBeNull()
  })

  it('refuses a slot on an order that has no date to judge it against', () => {
    expect(judgeSlotPatch(before({ fulfil_date: null }), { fulfil_time_from: '10:00', fulfil_time_to: '11:00' }, ON, KL, NOON_MYT)).toBe('fulfil_time_unavailable')
  })
})
```

In `apps/backend/tests/unit/orderEvents.test.ts`, add a case (read the file's `before`/`patch` helpers and match them):

```ts
  it('records fulfil_time_changed with both ends as HH:MM-HH:MM labels, and nothing for an unchanged slot', () => {
    const b = { status: 'new', note: null, courier: null, awb: null, fulfil_date: '2026-07-21', fulfil_time_from: '10:00', fulfil_time_to: '11:00' }
    expect(orderPatchEvents(b, { fulfil_time_from: '13:00', fulfil_time_to: '14:00' }))
      .toEqual([{ kind: 'fulfil_time_changed', detail: { from: '10:00-11:00', to: '13:00-14:00' } }])
    expect(orderPatchEvents(b, { fulfil_time_from: '10:00', fulfil_time_to: '11:00' })).toEqual([])
    expect(orderPatchEvents({ ...b, fulfil_time_from: null, fulfil_time_to: null }, { fulfil_time_from: '10:00', fulfil_time_to: '11:00' }))
      .toEqual([{ kind: 'fulfil_time_changed', detail: { from: null, to: '10:00-11:00' } }])
    expect(orderPatchEvents(b, { fulfil_time_from: null, fulfil_time_to: null }))
      .toEqual([{ kind: 'fulfil_time_changed', detail: { from: '10:00-11:00', to: null } }])
  })
```

Also in `apps/backend/tests/unit/writes.test.ts`, find the `pickOrderFields` block and add:

```ts
  it('takes the slot pair together, as two strings or two nulls, and drops a half pair', () => {
    expect(pickOrderFields({ fulfil_time_from: '10:00', fulfil_time_to: '11:00' }))
      .toEqual({ fulfil_time_from: '10:00', fulfil_time_to: '11:00' })
    expect(pickOrderFields({ fulfil_time_from: null, fulfil_time_to: null }))
      .toEqual({ fulfil_time_from: null, fulfil_time_to: null })
    expect(pickOrderFields({ fulfil_time_from: '10:00' })).toEqual({})
    expect(pickOrderFields({ fulfil_time_from: '10:00', fulfil_time_to: '' })).toEqual({})
  })
```

- [ ] **Step 2: Run the unit tests to verify they fail**

Run: `pnpm --filter @bitetime/backend test -- orderSlotPatch orderEvents writes`
Expected: FAIL — module not found; `fulfil_time_changed` not produced; pair not picked.

- [ ] **Step 3: Implement the pure parts**

`apps/backend/src/orderEvents.ts`:

```ts
export interface OrderPatchBefore {
  status: string | null
  note: string | null
  courier: string | null
  awb: string | null
  /** `YYYY-MM-DD`, null for an order placed before #91. */
  fulfil_date: string | null
  /** `HH:MM`, both null for an order placed with no slot (#282). */
  fulfil_time_from: string | null
  fulfil_time_to: string | null
}

/** A merchant PATCH after `pickOrderFields` — only the keys present are being written. */
export interface OrderPatch {
  status?: string
  note?: string | null
  courier?: string | null
  awb?: string | null
  fulfil_date?: string
  /** Always together: two `HH:MM` strings, or two nulls (clearing, slots-off shops only). */
  fulfil_time_from?: string | null
  fulfil_time_to?: string | null
}

/** `'HH:MM-HH:MM'` or null — the label the log stores, so a slot is one string in `detail`. */
export function slotLabel(from: string | null | undefined, to: string | null | undefined): string | null {
  return from && to ? `${from}-${to}` : null
}
```

Add to `orderPatchEvents` after the `fulfil_date` block:

```ts
  if (patch.fulfil_time_from !== undefined) {
    const from = slotLabel(before.fulfil_time_from, before.fulfil_time_to)
    const to = slotLabel(patch.fulfil_time_from, patch.fulfil_time_to)
    if (from !== to) out.push({ kind: 'fulfil_time_changed', detail: { from, to } })
  }
```

`apps/backend/src/writes.ts`, `pickOrderFields`, after the `fulfil_date` line:

```ts
  // The slot travels as a PAIR (#282). Two non-empty strings write both; two nulls clear both
  // (which only a shop with slots off may do — patchOrder's call); anything else — one end, an
  // empty string — is dropped whole, so the row can never hold half a slot. Whether the pair is
  // an open slot on the shop's hours is patchOrder's call, judged under the row lock.
  const tf = body?.fulfil_time_from
  const tt = body?.fulfil_time_to
  if (typeof tf === 'string' && tf.trim() && typeof tt === 'string' && tt.trim()) {
    out.fulfil_time_from = tf.trim()
    out.fulfil_time_to = tt.trim()
  } else if (tf === null && tt === null) {
    out.fulfil_time_from = null
    out.fulfil_time_to = null
  }
```

`apps/backend/src/orderSlotPatch.ts`:

```ts
import { isSlotSelectable, type FulfilmentConfig } from '@bitetime/shared'
import type { OrderPatch, OrderPatchBefore } from './orderEvents.js'

/**
 * Whether a merchant's patch leaves the order with a slot the shop can serve (#282).
 *
 * The CUSTOMER's rule, on purpose, as the date is: the shop's hours are what the merchant told
 * the platform they serve, and the drawer must not be a door around the Fulfilment tab. Judged
 * against the date the row WILL hold — a moved date carries its slot along, and the slot must be
 * open on the new day too.
 *
 * Pure, and separate from `patchOrder`, so every branch runs under `pnpm test` with no database.
 * Returns the refusal code or null; `patchOrder` turns the code into `{ refused }`.
 */
export function judgeSlotPatch(
  before: Pick<OrderPatchBefore, 'fulfil_date' | 'fulfil_time_from' | 'fulfil_time_to'>,
  patch: OrderPatch,
  cfg: FulfilmentConfig,
  tz: string,
  now: Date,
): 'fulfil_time_unavailable' | null {
  const slotPatched = patch.fulfil_time_from !== undefined
  const datePatched = patch.fulfil_date !== undefined
  if (!slotPatched && !datePatched) return null

  const from = slotPatched ? (patch.fulfil_time_from ?? null) : before.fulfil_time_from
  const to = slotPatched ? (patch.fulfil_time_to ?? null) : before.fulfil_time_to
  const unchanged = from === before.fulfil_time_from && to === before.fulfil_time_to

  if (!cfg.slots_enabled) {
    // Hours are dormant: nothing new can be judged open. Clearing and a no-op retry pass.
    return slotPatched && !unchanged && from !== null ? 'fulfil_time_unavailable' : null
  }

  if (from === null || to === null) {
    // A slot shop's order keeps its slot: it can move but never clear. A LEGACY order that never
    // had one is not given one by a date move — that is the merchant's choice to make explicitly.
    return slotPatched ? 'fulfil_time_unavailable' : null
  }

  const date = patch.fulfil_date ?? before.fulfil_date
  if (date === null) return 'fulfil_time_unavailable'
  return isSlotSelectable(date, { from, to }, cfg, tz, now) ? null : 'fulfil_time_unavailable'
}
```

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `pnpm --filter @bitetime/backend test -- orderSlotPatch orderEvents writes`
Expected: PASS.

- [ ] **Step 5: Write the failing API tests**

In `apps/backend/tests/api/order-events.test.ts`, inside `describe('merchant patch'…)`, after the `fulfil_date` block:

```ts
    describe('fulfil_time (#282)', () => {
      const ALL_DAY = Array.from({ length: 7 }, () => ({ open: '00:00', close: '23:00' }))
      const slotsOn = (over: Record<string, unknown> = {}) => setFulfilment({
        mode: 'rolling', lead_days: 0, window_days: 14, closed_weekdays: [],
        slots_enabled: true, hours: ALL_DAY, slot_minutes: 60, slot_notice_minutes: 0, ...over,
      })
      const slot = (from: string, to: string) => ({ fulfil_time_from: from, fulfil_time_to: to })

      it('moves the slot, records both ends, and hands the row back with the new times', async () => {
        await slotsOn()
        const orderId = await seedOrder(shop, 'new')
        await patchOrder(orderId, { fulfil_date: plusDays(2) })
        const res = await patchOrder(orderId, slot('10:00', '11:00'))
        expect(res.status).toBe(200)
        const body = (await res.json()) as { fulfil_time_from: string; fulfil_time_to: string; events: EventRow[] }
        expect(body.fulfil_time_from).toBe('10:00:00')
        expect(body.fulfil_time_to).toBe('11:00:00')
        expect(body.events.map(e => e.kind)).toEqual(['fulfil_time_changed'])
        expect((await eventsOf(orderId)).at(-1)).toMatchObject({
          kind: 'fulfil_time_changed', detail: { from: null, to: '10:00-11:00' },
        })
      })

      it('refuses a slot outside the hours and records nothing', async () => {
        await slotsOn({ hours: Array.from({ length: 7 }, () => ({ open: '10:00', close: '14:00' })) })
        const orderId = await seedOrder(shop, 'new')
        await patchOrder(orderId, { fulfil_date: plusDays(2) })
        const n = (await eventsOf(orderId)).length
        const res = await patchOrder(orderId, slot('14:00', '15:00'))
        expect(res.status).toBe(409)
        expect(await res.json()).toEqual({ error: 'fulfil_time_unavailable' })
        expect((await eventsOf(orderId)).length).toBe(n)
      })

      it('refuses a date move whose kept slot is closed on the new day', async () => {
        const target = plusDays(3)
        const hours = ALL_DAY.map((h, i) => (i === weekdayOf(target) ? { open: '12:00', close: '14:00' } : h))
        await slotsOn({ hours })
        const orderId = await seedOrder(shop, 'new')
        await patchOrder(orderId, { fulfil_date: plusDays(2), ...slot('10:00', '11:00') })
        const res = await patchOrder(orderId, { fulfil_date: target })
        expect(res.status).toBe(409)
        expect(await res.json()).toEqual({ error: 'fulfil_time_unavailable' })
        const ok = await patchOrder(orderId, { fulfil_date: target, ...slot('12:00', '13:00') })
        expect(ok.status).toBe(200)
        expect(((await ok.json()) as { events: EventRow[] }).events.map(e => e.kind)).toEqual(['fulfil_date_changed', 'fulfil_time_changed'])
      })

      it('refuses to move the slot of a completed order (ADR 0024)', async () => {
        await slotsOn()
        const orderId = await seedOrder(shop, 'completed')
        const res = await patchOrder(orderId, slot('10:00', '11:00'))
        expect(res.status).toBe(409)
        expect(await res.json()).toEqual({ error: 'order_completed' })
      })

      it('lets a shop with slots off clear a slot, and refuses a new one', async () => {
        await slotsOn()
        const orderId = await seedOrder(shop, 'new')
        await patchOrder(orderId, { fulfil_date: plusDays(2), ...slot('10:00', '11:00') })
        await setFulfilment({ mode: 'rolling', lead_days: 0, window_days: 14, closed_weekdays: [], slots_enabled: false })
        expect((await patchOrder(orderId, slot('12:00', '13:00'))).status).toBe(409)
        const res = await patchOrder(orderId, { fulfil_time_from: null, fulfil_time_to: null })
        expect(res.status).toBe(200)
        expect(((await res.json()) as { fulfil_time_from: null }).fulfil_time_from).toBeNull()
      })
    })
```

Run: `pnpm --filter @bitetime/backend test:db -- order-events`
Expected: FAIL — the slot is not written; no refusal.

- [ ] **Step 6: Wire `patchOrder`**

`apps/backend/src/orders.ts`. Import `judgeSlotPatch` from `./orderSlotPatch.js`. Change:

```ts
export type PatchRefusal = 'order_completed' | 'fulfil_date_unavailable' | 'fulfil_time_unavailable'
```

In the `before` select, add `to_char(o.fulfil_time_from, 'HH24:MI') as fulfil_time_from, to_char(o.fulfil_time_to, 'HH24:MI') as fulfil_time_to,` — `to_char` so the row reads as `HH:MM`, the shape the patch, the rule and the log all use. Then, after the completed-status check and before the `fulfil_date` block:

```ts
    // A completed order's slot is as final as its date (ADR 0024). Only a slot that DIFFERS is refused.
    if (patch.fulfil_time_from !== undefined && completed) {
      const same = (patch.fulfil_time_from ?? null) === before.fulfil_time_from
        && (patch.fulfil_time_to ?? null) === before.fulfil_time_to
      if (!same) return { refused: 'order_completed' as const }
    }
```

After the `fulfil_date` block (which keeps its own `isDateSelectable` check), add:

```ts
    // The slot, judged against the date the row WILL hold — a moved date carries its slot along.
    // Pure, so every branch is unit-tested; this line only asks.
    const slotRefusal = judgeSlotPatch(
      before, patch, fulfilmentConfig(before.config), before.timezone ?? DEFAULT_TIMEZONE, new Date(),
    )
    if (slotRefusal) return { refused: slotRefusal }
```

- [ ] **Step 7: Run the API tests to verify they pass**

Run: `pnpm typecheck && pnpm --filter @bitetime/backend test && pnpm --filter @bitetime/backend test:db -- order-events writes-orders`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/orderSlotPatch.ts apps/backend/tests/unit/orderSlotPatch.test.ts apps/backend/src/orderEvents.ts apps/backend/tests/unit/orderEvents.test.ts apps/backend/src/writes.ts apps/backend/tests/unit/writes.test.ts apps/backend/src/orders.ts apps/backend/tests/api/order-events.test.ts
git commit -m "feat(backend): let the merchant move an order's slot under the customer's rule

Claude-Session: https://claude.ai/code/session_01MsAqEnXM2x5a1QkTJQxTAN"
```

---

### Task 7: The merchant config PATCH validates hours

**Files:**
- Modify: `apps/backend/src/app.ts:385-406`
- Test: `apps/backend/tests/api/writes-merchants.test.ts`

- [ ] **Step 1: Write the failing tests**

In `apps/backend/tests/api/writes-merchants.test.ts`, inside `describe('PATCH /api/merchants/:id (custom order dates)'…)`:

```ts
  it('refuses hours whose close is not after open', async () => {
    const res = await save({ slots_enabled: true, hours: [null, { open: '14:00', close: '10:00' }] })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe('close_before_open')
  })

  it('refuses turning slots on with no open day', async () => {
    const res = await save({ slots_enabled: true, hours: [null, null, null, null, null, null, null] })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe('no_open_day')
  })

  it('saves slot settings normalised, and does not judge hours while slots are off', async () => {
    const ok = await save({ slots_enabled: false, hours: [{ open: '14:00', close: '10:00' }] })
    expect(ok.status).toBe(200)
    const res = await save({ slots_enabled: true, hours: Array(7).fill({ open: '10:00', close: '12:00' }), slot_minutes: 30, slot_notice_minutes: 90 })
    expect(res.status).toBe(200)
    const f = ((await res.json()) as any).config.fulfilment
    expect(f.slots_enabled).toBe(true)
    expect(f.slot_minutes).toBe(30)
    expect(f.slot_notice_minutes).toBe(90)
    expect(f.hours).toHaveLength(7)
  })
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @bitetime/backend test:db -- writes-merchants`
Expected: FAIL — the first two return 200.

- [ ] **Step 3: Implement**

`apps/backend/src/app.ts`. Add `validateSlotHours` to the `@bitetime/shared` import. Inside `if (submitted.fulfilment !== undefined) {`, after `const fulfilment = fulfilmentConfig(submitted)`:

```ts
      // The RAW hours, for the reason `too_many` counts the raw allowlist: the reader turns a
      // `close <= open` day into a closed one, and a merchant who typed it must be told.
      const badHours = validateSlotHours((submitted.fulfilment as Record<string, unknown>)?.hours, fulfilment)
      if (badHours) return c.json({ error: badHours }, 400)
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @bitetime/backend test:db -- writes-merchants`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/app.ts apps/backend/tests/api/writes-merchants.test.ts
git commit -m "feat(backend): refuse opening hours a shop cannot serve

Claude-Session: https://claude.ai/code/session_01MsAqEnXM2x5a1QkTJQxTAN"
```

---

### Task 8: Telegram and email show the slot

**Files:**
- Create: `apps/backend/src/fulfilSlotLabel.ts`
- Create: `apps/backend/tests/unit/fulfilSlotLabel.test.ts`
- Modify: `apps/backend/src/notify.ts:99`
- Modify: `apps/backend/src/orderEmails.ts:205, 231, 456`
- Test: `apps/backend/tests/unit/notify.test.ts`

**Interfaces:**
- Produces: `fulfilSlotLabel(from: unknown, to: unknown): string | null` → `'14:00 – 15:00'`.

- [ ] **Step 1: Write the failing tests**

`apps/backend/tests/unit/fulfilSlotLabel.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { fulfilSlotLabel } from '../../src/fulfilSlotLabel.js'

describe('fulfilSlotLabel', () => {
  it('prints the window from the two DB values, HH:MM only', () => {
    expect(fulfilSlotLabel('14:00:00', '15:00:00')).toBe('14:00 – 15:00')
    expect(fulfilSlotLabel('14:00', '15:00')).toBe('14:00 – 15:00')
  })
  it('is null for a legacy order or a half pair', () => {
    expect(fulfilSlotLabel(null, null)).toBeNull()
    expect(fulfilSlotLabel('14:00:00', null)).toBeNull()
    expect(fulfilSlotLabel(undefined, undefined)).toBeNull()
  })
})
```

In `apps/backend/tests/unit/notify.test.ts`, after the two date cases:

```ts
  it('prints the slot on the date line when the order carries one', () => {
    const msg = buildOrderMessage({ ...ORDER, fulfil_date: '2026-07-22', fulfil_time_from: '14:00:00', fulfil_time_to: '15:00:00' })
    expect(msg).toContain('*Date:* 2026-07-22 14:00 – 15:00')
  })
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @bitetime/backend test -- fulfilSlotLabel notify`
Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/backend/src/fulfilSlotLabel.ts`:

```ts
/**
 * `'14:00 – 15:00'` from the two `time` columns, or null when the order has no slot (#282).
 *
 * Postgres hands `time` back as `HH:MM:SS`; the merchant reads `HH:MM`. One function so the
 * Telegram message, both emails and nothing else agree on the shape. Null for a legacy order
 * and for any half pair — the CHECK constraint forbids one, but a reader never trusts a row.
 */
export function fulfilSlotLabel(from: unknown, to: unknown): string | null {
  if (typeof from !== 'string' || typeof to !== 'string' || !from || !to) return null
  return `${from.slice(0, 5)} – ${to.slice(0, 5)}`
}
```

`apps/backend/src/notify.ts`, replace the `*Date:*` line:

```ts
  if (order.fulfil_date) {
    const slot = fulfilSlotLabel(order.fulfil_time_from, order.fulfil_time_to)
    msg += `*Date:* ${order.fulfil_date}${slot ? ` ${slot}` : ''}\n`
  }
```

`apps/backend/src/orderEmails.ts`: at each of the three date lines, compute `const slot = fulfilSlotLabel(order.fulfil_time_from, order.fulfil_time_to)` and append `` `${slot ? ` ${slot}` : ''}` `` to the date string. Import at the top of both files: `import { fulfilSlotLabel } from './fulfilSlotLabel.js'`.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @bitetime/backend test`
Expected: PASS (the email suites' fixtures carry no slot and print as before).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/fulfilSlotLabel.ts apps/backend/tests/unit/fulfilSlotLabel.test.ts apps/backend/src/notify.ts apps/backend/src/orderEmails.ts apps/backend/tests/unit/notify.test.ts
git commit -m "feat(backend): print the fulfilment slot on the Telegram and email date lines

Claude-Session: https://claude.ai/code/session_01MsAqEnXM2x5a1QkTJQxTAN"
```

---

### Task 9: Frontend data layer

**Files:**
- Modify: `apps/frontend/src/types.ts:190`
- Modify: `apps/frontend/src/orderDate.ts`
- Modify: `apps/frontend/src/store.ts:775-810, 1022-1028`
- Modify: `apps/frontend/src/store/submitGate.ts`
- Test: `apps/frontend/src/orderDate.test.ts` (create if absent), `apps/frontend/src/store/submitGate.test.ts`

**Interfaces:**
- Produces:
  - `Order.fulfil_time_from?: string | null`, `Order.fulfil_time_to?: string | null`
  - `formatSlotRange(from, to): string`
  - `placeOrder({ …, fulfilSlot: Slot | null })`
  - `setOrderFulfilment(orderId, { fulfilDate: string; fulfilSlot?: Slot | null }, merchantId)` — replaces `setOrderFulfilDate`
  - `SubmitGateInput.slotRequired: boolean`, `.chosenSlot: Slot | null`

- [ ] **Step 1: Write the failing tests**

`apps/frontend/src/orderDate.test.ts` (append; if the file does not exist, create it with these imports):

```ts
import { describe, it, expect } from 'vitest'
import { formatSlotRange } from './orderDate'

describe('formatSlotRange', () => {
  it('prints HH:MM – HH:MM from DB or wire values', () => {
    expect(formatSlotRange('14:00:00', '15:00:00')).toBe('14:00 – 15:00')
    expect(formatSlotRange('14:00', '15:00')).toBe('14:00 – 15:00')
  })
  it('is empty for a legacy order', () => {
    expect(formatSlotRange(null, null)).toBe('')
    expect(formatSlotRange('14:00', undefined)).toBe('')
  })
})
```

In `apps/frontend/src/store/submitGate.test.ts`, add `slotRequired: false, chosenSlot: null` to `base`, then:

```ts
describe('time slot', () => {
  it('asks nothing of a shop with slots off', () => {
    expect(gate({ slotRequired: false, chosenSlot: null }).canSubmit).toBe(true)
  })
  it('needs a chosen slot at a slot shop', () => {
    expect(gate({ slotRequired: true, chosenSlot: null }).canSubmit).toBe(false)
    expect(gate({ slotRequired: true, chosenSlot: { from: '10:00', to: '11:00' } }).canSubmit).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @bitetime/frontend test -- orderDate submitGate`
Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/frontend/src/types.ts`, after `fulfil_date`:

```ts
  /** `HH:MM:SS` from PostgREST. Both null on an order placed with no slot (#282). */
  fulfil_time_from?: string | null
  fulfil_time_to?: string | null
```

`apps/frontend/src/orderDate.ts`, append:

```ts
/**
 * The slot an order is for, `14:00 – 15:00`, or `''` when it has none (#282).
 *
 * Language-neutral on purpose: a 24-hour clock reads the same in both. Slices to `HH:MM`
 * because PostgREST hands `time` back as `HH:MM:SS` while the wire and the rule use `HH:MM`.
 */
export function formatSlotRange(from: string | null | undefined, to: string | null | undefined): string {
  if (!from || !to) return ''
  return `${from.slice(0, 5)} – ${to.slice(0, 5)}`
}
```

`apps/frontend/src/store.ts`. Import `type Slot` from `@bitetime/shared`. In `placeOrder`, add to the destructured params and the type:

```ts
  /** The slot the customer picked, or null at a shop with slots off. Re-checked against the shop's hours. */
  fulfilSlot: Slot | null
```

and in the body: `fulfilTimeFrom: fulfilSlot?.from ?? null, fulfilTimeTo: fulfilSlot?.to ?? null,`.

Replace `setOrderFulfilDate` with:

```ts
/**
 * Move the day — and, at a slot shop, the slot — an order is for. `fulfilDate` is `YYYY-MM-DD`
 * and never empty. `fulfilSlot` is sent only when given: `null` clears (a shop with slots off
 * only), a `Slot` moves. The backend judges both by the shop's own Fulfilment settings and
 * answers `fulfil_date_unavailable`, `fulfil_time_unavailable` or `order_completed`.
 */
export async function setOrderFulfilment(
  orderId: string,
  patch: { fulfilDate: string; fulfilSlot?: Slot | null },
  merchantId: string,
): Promise<Result<any>> {
  const body: Record<string, unknown> = { fulfil_date: patch.fulfilDate }
  if (patch.fulfilSlot !== undefined) {
    body.fulfil_time_from = patch.fulfilSlot?.from ?? null
    body.fulfil_time_to = patch.fulfilSlot?.to ?? null
  }
  return apiSend<any>(`/api/merchants/${merchantId}/orders/${orderId}`, 'PATCH', body, { auth: true })
}
```

`apps/frontend/src/store/submitGate.ts`. Import `type Slot`. Add to `SubmitGateInput`:

```ts
  /** The shop asks for a time slot. */
  readonly slotRequired: boolean
  /** The chosen slot, still one the shop offers on the chosen date. `null` once it stops being offered. */
  readonly chosenSlot: Slot | null
```

and to `canSubmit`: `(!input.slotRequired || input.chosenSlot !== null) &&` after the `chosenDate` line.

- [ ] **Step 4: Run to verify they pass; typecheck will fail on call sites**

Run: `pnpm --filter @bitetime/frontend test -- orderDate submitGate`
Expected: PASS. `pnpm typecheck` FAILS in `Storefront.tsx` and `OrderDetailSheet.tsx` — Tasks 10 and 12 fix those. Do not commit a red typecheck: fold Step 5 of this task into Task 10's commit if you cannot make it green here. The minimal fix to get green now: in `Storefront.tsx` pass `fulfilSlot: null` to `placeOrder` and `slotRequired: false, chosenSlot: null` to `submitGate`; in `OrderDetailSheet.tsx` replace `setOrderFulfilDate(order.id, dateDraft, merchant!.id)` with `setOrderFulfilment(order.id, { fulfilDate: dateDraft }, merchant!.id)` and fix the import.

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/types.ts apps/frontend/src/orderDate.ts apps/frontend/src/orderDate.test.ts apps/frontend/src/store.ts apps/frontend/src/store/submitGate.ts apps/frontend/src/store/submitGate.test.ts apps/frontend/src/store/Storefront.tsx apps/frontend/src/merchant/orderDetail/OrderDetailSheet.tsx
git commit -m "feat(frontend): carry the fulfilment slot through the data layer

Claude-Session: https://claude.ai/code/session_01MsAqEnXM2x5a1QkTJQxTAN"
```

---

### Task 10: The storefront slot picker

**Files:**
- Create: `apps/frontend/src/store/FulfilSlotPicker.tsx`
- Modify: `apps/frontend/src/store/Storefront.tsx` (state near `:146`, list near `:427-432`, gate `:520-526`, refusal loop `:720`, submit `:835`, success `:878`, `:954-959`, picker `:1495-1506`)
- Modify: `apps/frontend/src/store/OrderHistory.tsx:201-205`

**Interfaces:**
- Consumes: `selectableSlots`, `Slot`, `fulfilmentConfig` (shared); `formatSlotRange`; `submitGate` slot fields; `placeOrder.fulfilSlot`; `'clear_slot'` action.

- [ ] **Step 1: Write `FulfilSlotPicker`**

```tsx
import { cn } from '@/lib/utils'
import type { Slot } from '@bitetime/shared'
import { formatSlotRange } from '../orderDate'

interface Props {
  /** Every slot the shop offers on the chosen date, in order. */
  slots: Slot[]
  value: Slot | null
  onChange: (slot: Slot) => void
  t: (en: string, zh: string) => string
}

const same = (a: Slot | null, b: Slot) => a !== null && a.from === b.from && a.to === b.to

/**
 * The time slots of one date, as toggle buttons (#282).
 *
 * Closed slots are HIDDEN, not greyed — the opposite of the date grid, on purpose. A greyed
 * Monday teaches the customer the shop is shut that day; a grey run of 08:00, 08:30, 09:00
 * before opening time teaches nothing and pushes the open slots off a phone screen. Everything
 * shown is derived from `slots`, so this component holds no rule of its own and cannot
 * disagree with the one the backend enforces.
 */
export default function FulfilSlotPicker({ slots, value, onChange, t }: Props) {
  if (slots.length === 0) {
    return (
      <div className="text-[14px] text-muted-foreground leading-[1.5]">
        {t('No time slots are left for this date. Please pick another date.',
           '该日期已无可选时段，请选择其他日期。')}
      </div>
    )
  }
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={t('Choose a time slot', '选择时段')}>
      {slots.map(s => {
        const selected = same(value, s)
        return (
          <button
            key={s.from}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(s)}
            className={cn(
              'h-10 pointer-coarse:min-h-11 px-3 rounded-md text-[14px] font-sans tabular-nums transition-all border',
              'focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2',
              selected
                ? 'border-[0.5px] border-primary bg-brand-wash text-primary font-medium'
                : 'border-border bg-card text-foreground hover:border-primary cursor-pointer',
            )}
          >
            {formatSlotRange(s.from, s.to)}
          </button>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Wire the storefront**

`apps/frontend/src/store/Storefront.tsx`:

Imports: add `selectableSlots, type Slot` to the `@bitetime/shared` import; `import FulfilSlotPicker from './FulfilSlotPicker'`; add `formatSlotRange` to the `../orderDate` import.

State, next to `fulfilDate`:

```ts
  const [fulfilSlot, setFulfilSlot] = useState<Slot | null>(null)
```

Success state type (`:102`): add `fulfilSlot: Slot | null`.

Replace the `fulfilDates` / `chosenDate` block with:

```ts
  const fulfilCfg = useMemo(() => fulfilmentConfig(merchant.config), [merchant.config])
  const shopTz = merchant.timezone ?? DEFAULT_TIMEZONE
  const fulfilDates = useMemo(() => selectableDates(fulfilCfg, shopTz, now), [fulfilCfg, shopTz, now])
  // A date the shop stopped offering while the page sat open is not a selection any more.
  const chosenDate = fulfilDate && fulfilDates.includes(fulfilDate) ? fulfilDate : null
  // The slots of the chosen date, and the same guard for the slot: one that passed `now + notice`
  // while the customer typed leaves the summary before the backend refuses it.
  const fulfilSlots = useMemo(
    () => (chosenDate ? selectableSlots(chosenDate, fulfilCfg, shopTz, now) : []),
    [chosenDate, fulfilCfg, shopTz, now],
  )
  const chosenSlot = fulfilSlot && fulfilSlots.some(s => s.from === fulfilSlot.from && s.to === fulfilSlot.to) ? fulfilSlot : null

  // Nothing else re-renders this page as time passes, and today's 15:00 slot must not sit on
  // screen at 15:10. One tick a minute while slots are on; `now` is read fresh on every render,
  // so the tick's only job is to cause one. The backend still decides.
  const [, setMinuteTick] = useState(0)
  useEffect(() => {
    if (!fulfilCfg.slots_enabled) return
    const id = setInterval(() => setMinuteTick(n => n + 1), 60_000)
    return () => clearInterval(id)
  }, [fulfilCfg.slots_enabled])
```

`submitGate({...})`: add `slotRequired: fulfilCfg.slots_enabled, chosenSlot,`.

Refusal loop: after the `clear_date` branch add:

```ts
      } else if (action === 'clear_slot') {
        setFulfilSlot(null)
```

`placeOrder({...})`: `fulfilSlot: chosenSlot,`. `setSuccess({...})`: `fulfilSlot: chosenSlot,`.

Success screen, inside the `success.fulfilDate` block, after the date `<strong>`:

```tsx
                {success.fulfilSlot && (
                  <>
                    <br />
                    <strong className="text-[16px] tabular-nums">{formatSlotRange(success.fulfilSlot.from, success.fulfilSlot.to)}</strong>
                  </>
                )}
```

The "When" block:

```tsx
          <div className="mb-7">
            <div className="text-[11px] font-medium text-primary uppercase tracking-[0.09em] mb-3">
              {fulfilCfg.slots_enabled ? t('Date and time', '日期与时段') : t('Date', '日期')} *
            </div>
            <FulfilDatePicker
              available={fulfilDates}
              value={chosenDate}
              // A new day has new slots: the old slot is not a choice on it.
              onChange={d => { setFulfilDate(d); setFulfilSlot(null) }}
              t={t}
              lang={lang}
            />
            {fulfilCfg.slots_enabled && chosenDate && (
              <div className="mt-4">
                <div className="text-[12px] text-muted-foreground mb-2">{t('Time slot', '时段')}</div>
                <FulfilSlotPicker slots={fulfilSlots} value={chosenSlot} onChange={setFulfilSlot} t={t} />
              </div>
            )}
          </div>
```

Check every other place `fulfilmentConfig(merchant.config)` or `merchant.timezone ?? DEFAULT_TIMEZONE` was used in this file and reuse `fulfilCfg` / `shopTz`.

`apps/frontend/src/store/OrderHistory.tsx`, the "For" line:

```tsx
                          {o.fulfil_date
                            ? `${t('For', '取货日期')} ${formatCalendarDate(o.fulfil_date, lang)}${o.fulfil_time_from ? ` · ${formatSlotRange(o.fulfil_time_from, o.fulfil_time_to)}` : ''}`
                            : '—'}
```

Import `formatSlotRange` there.

- [ ] **Step 3: Typecheck, lint, unit tests**

Run: `pnpm typecheck && pnpm lint && pnpm --filter @bitetime/frontend test`
Expected: PASS. `brandScope.test.ts` sweeps class pairs — the new button uses the same classes as the date grid, so it passes.

- [ ] **Step 4: Run and look**

Start `pnpm dev`. With a slot shop configured through SQL for now (the tab arrives in Task 11):

```bash
cd apps/backend && psql "$(supabase status -o env | grep DB_URL | cut -d'"' -f2)" -c "
update merchants set config = jsonb_set(coalesce(config,'{}'), '{fulfilment}',
  coalesce(config->'fulfilment','{}') || '{\"slots_enabled\":true,\"slot_minutes\":60,\"slot_notice_minutes\":0}'::jsonb)
where slug = 'demo-pro';"
```

Open `http://localhost:5173/s/demo-pro`. Pick a date; the slot row appears; pick a slot; Place Order is enabled only after both; the success screen shows the slot. Pick today late in the day and check the past slots are gone.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/store/FulfilSlotPicker.tsx apps/frontend/src/store/Storefront.tsx apps/frontend/src/store/OrderHistory.tsx
git commit -m "feat(storefront): let the customer pick a time slot after the date

Claude-Session: https://claude.ai/code/session_01MsAqEnXM2x5a1QkTJQxTAN"
```

---

### Task 11: The Fulfilment tab's "Time slots" card

**Files:**
- Modify: `apps/frontend/src/merchant/FulfilmentTab.tsx`

**Interfaces:**
- Consumes: `SLOT_MINUTES`, `SLOT_NOTICE_MAX`, `slotsBetween`, `validateSlotHours`, `type DayHours`, `type SlotHoursError` from shared; `Switch` from `../components/ui/switch`; `Checkbox` from `../components/ui/checkbox`.

- [ ] **Step 1: Extend the form state**

Add to the imports: `SLOT_MINUTES, slotsBetween, validateSlotHours, type SlotHoursError, type SlotMinutes` from `@bitetime/shared`; `Switch` and `Checkbox` from the UI kit.

The form keeps `open`/`close` for a closed day too, so toggling it back restores what was typed:

```ts
interface HoursRow { open: string; close: string; closed: boolean }

const NOTICE_OPTIONS: { value: number; en: string; zh: string }[] = [
  { value: 0, en: 'No notice', zh: '无需提前' },
  { value: 30, en: '30 minutes', zh: '30 分钟' },
  { value: 60, en: '1 hour', zh: '1 小时' },
  { value: 90, en: '1.5 hours', zh: '1.5 小时' },
  { value: 120, en: '2 hours', zh: '2 小时' },
  { value: 180, en: '3 hours', zh: '3 小时' },
  { value: 240, en: '4 hours', zh: '4 小时' },
  { value: 1440, en: '1 day', zh: '1 天' },
]
```

In `initial()`:

```ts
      slotsEnabled: cfg.slots_enabled,
      hours: cfg.hours.map(h => (h ? { open: h.open, close: h.close, closed: false } : { open: '09:00', close: '18:00', closed: true })),
      slotMinutes: String(cfg.slot_minutes),
      notice: String(cfg.slot_notice_minutes),
```

Extend the `useSaved` `eq` with:

```ts
      a.slotsEnabled === b.slotsEnabled &&
      a.slotMinutes === b.slotMinutes &&
      a.notice === b.notice &&
      a.hours.map(h => `${h.closed}${h.open}${h.close}`).join(',') === b.hours.map(h => `${h.closed}${h.open}${h.close}`).join(',')
```

- [ ] **Step 2: Save through the shared rule**

Before `setBusy(true)` in `save`:

```ts
    const rawHours = fields.hours.map(h => (h.closed ? null : { open: h.open, close: h.close }))
    const slotBag = {
      slots_enabled: fields.slotsEnabled,
      hours: rawHours,
      slot_minutes: Number(fields.slotMinutes),
      slot_notice_minutes: Number(fields.notice),
    }
    const badHours = validateSlotHours(rawHours, fulfilmentConfig({ fulfilment: slotBag }))
    if (badHours) { toast.error(hoursErrorMessage(badHours)); return }
```

with, near `dateErrorMessage`:

```ts
  const hoursErrorMessage = (code: SlotHoursError): string => ({
    close_before_open: t('A closing time must be after its opening time.', '关门时间必须晚于开门时间。'),
    no_open_day: t('Open at least one day for long enough to fit one slot, or customers cannot order at all.',
                   '请至少有一天的营业时间能容纳一个时段，否则顾客无法下单。'),
  })[code]
```

Spread `...slotBag` into the `fulfilmentConfig({ fulfilment: { … } })` call that builds `fulfilment`. In `applied`, add:

```ts
        slotsEnabled: fulfilment.slots_enabled,
        hours: fulfilment.hours.map(h => (h ? { open: h.open, close: h.close, closed: false } : { open: '09:00', close: '18:00', closed: true })),
        slotMinutes: String(fulfilment.slot_minutes),
        notice: String(fulfilment.slot_notice_minutes),
```

- [ ] **Step 3: Render the card**

Insert a new `<div className={CARD}>` between the "Closed days" card and the "Time zone" card:

```tsx
      <div className={CARD}>
        <div className="flex items-center justify-between gap-3 mb-4">
          <h3 className={HEADING + ' mb-0'}>{t('Time slots', '时段')}</h3>
          <label className="flex items-center gap-2 text-[13px] text-foreground cursor-pointer">
            <Switch
              checked={fields.slotsEnabled}
              onCheckedChange={v => setFields(f => ({ ...f, slotsEnabled: v === true }))}
              aria-label={t('Let customers pick a time slot', '让顾客选择时段')}
            />
            {t('Let customers pick a time slot', '让顾客选择时段')}
          </label>
        </div>

        {/* Visible but disabled while off — the merchant sees what turning it on gives them, the
            way the express fee fields stay legible while express is off. */}
        <fieldset disabled={!fields.slotsEnabled} className="flex flex-col gap-5 disabled:opacity-60">
          <div>
            <Label className="mb-2 block">{t('Opening hours', '营业时间')}</Label>
            <div className="flex flex-col gap-2">
              {WEEKDAYS.map(d => {
                const row = fields.hours[d.value]
                const dateClosed = !custom && fields.closed.includes(d.value)
                const setRow = (patch: Partial<HoursRow>) =>
                  setFields(f => ({ ...f, hours: f.hours.map((h, i) => (i === d.value ? { ...h, ...patch } : h)) }))
                return (
                  <div key={d.value} className={'grid grid-cols-[72px_1fr_auto_1fr] items-center gap-2 ' + (dateClosed ? 'opacity-50' : '')}>
                    <label className="flex items-center gap-2 text-[14px]">
                      <Checkbox
                        checked={!row.closed && !dateClosed}
                        disabled={dateClosed}
                        onCheckedChange={v => setRow({ closed: v !== true })}
                        aria-label={t(`Open on ${d.en}`, `${d.zh}营业`)}
                      />
                      {t(d.en, d.zh)}
                    </label>
                    {dateClosed ? (
                      <span className="col-span-3 text-[12px] text-muted-foreground">
                        {t('Closed in the date rule above', '已在上方休息日中关闭')}
                      </span>
                    ) : (
                      <>
                        <Input type="time" step={1800} value={row.open} disabled={row.closed} variant="compact"
                          aria-label={t(`${d.en} opens`, `${d.zh}开门`)}
                          onChange={e => setRow({ open: e.target.value })} />
                        <span className="text-muted-foreground">–</span>
                        <Input type="time" step={1800} value={row.close} disabled={row.closed} variant="compact"
                          aria-label={t(`${d.en} closes`, `${d.zh}关门`)}
                          onChange={e => setRow({ close: e.target.value })} />
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="ff-slot-minutes">{t('Slot length', '时段长度')}</Label>
              <Select value={fields.slotMinutes} onValueChange={v => setFields(f => ({ ...f, slotMinutes: v ?? f.slotMinutes }))}>
                <SelectTrigger id="ff-slot-minutes" className="w-full" aria-label={t('Slot length', '时段长度')}>
                  <span>{t(`${fields.slotMinutes} minutes`, `${fields.slotMinutes} 分钟`)}</span>
                </SelectTrigger>
                <SelectContent>
                  {SLOT_MINUTES.map(m => <SelectItem key={m} value={String(m)}>{t(`${m} minutes`, `${m} 分钟`)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="ff-notice">{t('Customers must order at least', '顾客最少需提前')}</Label>
              <Select value={fields.notice} onValueChange={v => setFields(f => ({ ...f, notice: v ?? f.notice }))}>
                <SelectTrigger id="ff-notice" className="w-full" aria-label={t('Notice', '提前时间')}>
                  <span>{(() => { const o = NOTICE_OPTIONS.find(o => String(o.value) === fields.notice); return o ? t(o.en, o.zh) : fields.notice })()}</span>
                </SelectTrigger>
                <SelectContent>
                  {NOTICE_OPTIONS.map(o => <SelectItem key={o.value} value={String(o.value)}>{t(o.en, o.zh)}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-[12px] text-muted-foreground mt-1 leading-[1.5]">
                {t('before the slot starts. Counted on your shop’s clock.', '于时段开始前下单。以店铺时区计算。')}
              </p>
            </div>
          </div>

          {/* What the storefront will offer, from the form's own values, before the save. */}
          <div className="text-[12px] text-muted-foreground leading-[1.6]">
            {WEEKDAYS.map(d => {
              const row = fields.hours[d.value]
              if (row.closed || (!custom && fields.closed.includes(d.value))) return null
              const slots = slotsBetween({ open: row.open, close: row.close }, Number(fields.slotMinutes) as SlotMinutes)
              return (
                <div key={d.value} className={slots.length === 0 ? 'text-warning-fg' : ''}>
                  <span className="font-medium text-foreground">{t(d.en, d.zh)}:</span>{' '}
                  {slots.length === 0
                    ? t('0 slots — the hours are shorter than one slot', '0 个时段：营业时间短于一个时段')
                    : `${slots.slice(0, 4).map(s => `${s.from} – ${s.to}`).join(', ')}${slots.length > 4 ? ', …' : ''} (${t(`${slots.length} slots`, `${slots.length} 个时段`)})`}
                </div>
              )
            })}
          </div>
        </fieldset>
      </div>
```

Note the row's `disabled` Inputs: a closed day keeps its typed times but greys them.

- [ ] **Step 4: Typecheck, lint, run and look**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

Undo the SQL from Task 10 Step 4 first (`slots_enabled` false), then in the dashboard's Fulfilment tab: turn the switch on, close Sunday, set Monday 10:00–14:00, save, reload, check the values come back. Set Tuesday close before open and check the save is refused with the message. Uncheck every day and check `no_open_day`. Open the storefront and check the slots match the preview.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/merchant/FulfilmentTab.tsx
git commit -m "feat(dashboard): let a merchant set opening hours and turn time slots on

Claude-Session: https://claude.ai/code/session_01MsAqEnXM2x5a1QkTJQxTAN"
```

---

### Task 12: Dashboard surfaces — banner, drawer, header, list

**Files:**
- Modify: `apps/frontend/src/merchant/FulfilmentDatesBanner.tsx:28-46`
- Modify: `apps/frontend/src/merchant/orderDetail/CustomerCard.tsx`
- Modify: `apps/frontend/src/merchant/orderDetail/OrderDetailSheet.tsx:40-56, 116-141, 172-179`
- Modify: `apps/frontend/src/merchant/orderDetail/OrderHeader.tsx:57-61`
- Modify: `apps/frontend/src/merchant/OrdersView.tsx:48-58`

- [ ] **Step 1: Banner**

In `FulfilmentDatesBanner.tsx`, make `no_slots` urgent and give it words:

```ts
  const urgent = state.kind === 'empty' || state.kind === 'review' || state.kind === 'no_slots'
```

```ts
      : state.kind === 'no_slots'
        ? t('Your shop is not taking orders — time slots are on, but no open day holds a slot. Check your opening hours.',
             '店铺目前无法接单：已开启时段，但没有任何营业日能容纳一个时段。请检查营业时间。')
```

Insert it before the `empty` branch in the ternary chain.

- [ ] **Step 2: Drawer — the sheet owns a slot draft**

`OrderDetailSheet.tsx`:

```ts
  const [slotDraft, setSlotDraft] = useState<Slot | null>(null)
```

Import `type Slot, fulfilmentConfig` from `@bitetime/shared` and `setOrderFulfilment` from `../../store` (already replaced in Task 9). In the re-seed block:

```ts
    setSlotDraft(order.fulfil_time_from && order.fulfil_time_to
      ? { from: order.fulfil_time_from.slice(0, 5), to: order.fulfil_time_to.slice(0, 5) }
      : null)
```

Replace `handleDateSave`:

```ts
  // The date and slot edit. `fulfil_date_unavailable` / `fulfil_time_unavailable` are the backend
  // refusing a day or window the shop's own Fulfilment settings do not offer. The pickers already
  // hide those, so a refusal reaches a merchant only when the settings moved under an open
  // drawer, or the time went by while it was open — and it says where the settings are.
  function handleDateSave() {
    if (!order || !dateDraft) return
    setSavingDate(true)
    const slotsOn = fulfilmentConfig(merchant?.config).slots_enabled
    setOrderFulfilment(order.id, {
      fulfilDate: dateDraft,
      // Sent only when the shop asks for one, or when the merchant is clearing a leftover slot
      // on a shop that has since turned slots off.
      ...(slotsOn || (slotDraft === null && order.fulfil_time_from) ? { fulfilSlot: slotDraft } : {}),
    }, merchant!.id).then(r => {
      if (r.ok) {
        applyWrite(r.data)
        toast.success(slotsOn ? t('Date and time saved', '日期与时段已保存') : t('Date saved', '日期已保存'))
      } else if (r.error.code === 'fulfil_date_unavailable') {
        toast.error(t('Your shop is not taking orders for that day. Check Settings → Fulfilment.', '你的店铺在该日期不接单。请查看设置 → 配送日期。'))
      } else if (r.error.code === 'fulfil_time_unavailable') {
        toast.error(t('Your shop does not offer that time slot on that day. Check Settings → Fulfilment.', '你的店铺在该日期不提供该时段。请查看设置 → 配送日期。'))
      } else if (r.error.code === 'order_completed') {
        toast.error(t('This order is done. Its date cannot change.', '此订单已结束，日期无法更改。'))
      } else {
        toast.error(t('Could not save date.', '无法保存日期。'))
      }
    }).finally(() => setSavingDate(false))
  }
```

Dirty:

```ts
  const orderSlotKey = order?.fulfil_time_from && order?.fulfil_time_to ? `${order.fulfil_time_from.slice(0, 5)}-${order.fulfil_time_to.slice(0, 5)}` : ''
  const slotKey = slotDraft ? `${slotDraft.from}-${slotDraft.to}` : ''
  const dateDirty = order != null && dateDraft !== '' && (dateDraft !== (order.fulfil_date ?? '') || slotKey !== orderSlotKey)
```

Pass to `CustomerCard`: `fulfilSlot={slotDraft}` and `onFulfilSlot={setSlotDraft}`. When the merchant changes the DATE, clear the slot draft: `onFulfilDate={iso => { setDateDraft(iso); setSlotDraft(null) }}` — but only at a slot shop; at a slots-off shop keep the slot (it may be a leftover the merchant does not want to lose). Simplest: `onFulfilDate={iso => { setDateDraft(iso); if (fulfilmentConfig(merchant?.config).slots_enabled) setSlotDraft(null) }}`.

- [ ] **Step 3: Drawer — `CustomerCard` renders the slot**

Props: add `fulfilSlot: Slot | null` and `onFulfilSlot: (s: Slot | null) => void`. Imports: `selectableSlots, type Slot` from shared; `formatSlotRange` from `../../orderDate`; `Select, SelectContent, SelectItem, SelectTrigger` from `@/components/ui/select`.

```ts
  const cfg = fulfilmentConfig(merchant?.config)
  const slotsOn = cfg.slots_enabled
  const slots = dateEditable && slotsOn && fulfilDate ? selectableSlots(fulfilDate, cfg, tz, new Date()) : []
  const slotKey = (s: Slot) => `${s.from}-${s.to}`
```

Read view (the `!dateEditable` branch): after the date, append `{order.fulfil_time_from ? ` · ${formatSlotRange(order.fulfil_time_from, order.fulfil_time_to)}` : ''}`.

Edit view: after the `DateField` block, add:

```tsx
        {dateEditable && slotsOn && (
          <div className="flex flex-col gap-1 min-w-0">
            <label className={LBL} htmlFor={`fulfil-slot-${order.id}`}>{t('Time slot', '时段')}</label>
            <Select
              value={fulfilSlot ? slotKey(fulfilSlot) : ''}
              onValueChange={v => onFulfilSlot(slots.find(s => slotKey(s) === v) ?? null)}
              disabled={!fulfilDate || slots.length === 0}
            >
              <SelectTrigger id={`fulfil-slot-${order.id}`} className="w-full" aria-label={t('Time slot', '时段')}>
                <span className="tabular-nums">
                  {fulfilSlot ? formatSlotRange(fulfilSlot.from, fulfilSlot.to)
                    : slots.length === 0 ? t('No slots on this day', '该日无可选时段') : t('Pick a time slot', '选择时段')}
                </span>
              </SelectTrigger>
              <SelectContent>
                {slots.map(s => <SelectItem key={slotKey(s)} value={slotKey(s)}>{formatSlotRange(s.from, s.to)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        )}
        {dateEditable && !slotsOn && order.fulfil_time_from && (
          <Field label={t('Time slot', '时段')}>
            <span className="tabular-nums">{formatSlotRange(order.fulfil_time_from, order.fulfil_time_to)}</span>
            <Button type="button" variant="ghost" size="sm" className="ml-2" onClick={() => onFulfilSlot(null)} disabled={fulfilSlot === null}>
              {t('Clear', '清除')}
            </Button>
          </Field>
        )}
```

Footer label: `label={slotsOn ? t('Save date & time', '保存日期与时段') : t('Save date', '保存日期')}`.

- [ ] **Step 4: Header and list**

`OrderHeader.tsx`, the "For" span:

```tsx
          {order.fulfil_date ? formatCalendarDate(order.fulfil_date, lang) : '—'}
          {order.fulfil_time_from ? ` · ${formatSlotRange(order.fulfil_time_from, order.fulfil_time_to)}` : ''}
```

`OrdersView.tsx`, the `fulfil_date` cell body becomes:

```tsx
        <div>
          {row.original.fulfil_date ? formatCalendarDate(row.original.fulfil_date, meta.lang) : '—'}
          {row.original.fulfil_time_from && (
            <div className="text-[12px] text-muted-foreground tabular-nums">
              {formatSlotRange(row.original.fulfil_time_from, row.original.fulfil_time_to)}
            </div>
          )}
        </div>
```

Import `formatSlotRange` in both files.

- [ ] **Step 5: Typecheck, lint, run and look**

Run: `pnpm typecheck && pnpm lint && pnpm --filter @bitetime/frontend test`
Expected: PASS.

In the dashboard: open a slot order; the header shows `· 14:00 – 15:00`; the card shows a slot select; move the slot; the log gains "You moved the time slot…". Move the date to a day with different hours and check the refusal toast, then pick a slot and save. Turn slots off in the tab, reopen the order, clear the slot.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/merchant/FulfilmentDatesBanner.tsx apps/frontend/src/merchant/orderDetail/CustomerCard.tsx apps/frontend/src/merchant/orderDetail/OrderDetailSheet.tsx apps/frontend/src/merchant/orderDetail/OrderHeader.tsx apps/frontend/src/merchant/OrdersView.tsx
git commit -m "feat(dashboard): show and move an order's time slot in the drawer

Claude-Session: https://claude.ai/code/session_01MsAqEnXM2x5a1QkTJQxTAN"
```

---

### Task 13: Docs and the issue

**Files:**
- Modify: `CONTEXT.md` (after the "Fulfilment date" section)
- Create: `docs/adr/0027-a-fulfilment-slot-is-a-window-the-shop-names.md`
- Modify: `packages/shared/src/orderEvents.ts` comment (if Task 3 did not)

- [ ] **Step 1: CONTEXT.md**

Add a `### Fulfilment slot` subsection under `## Fulfilment date`:

```markdown
### Fulfilment slot

**A window inside the date** (#282): `14:00 – 15:00`, never a clock time the customer types. Off for every shop until its owner turns `slots_enabled` on in the Fulfilment tab; while off, `hours`, `slot_minutes` and `slot_notice_minutes` sit dormant in the bag like an unused mode's settings, and a slot in a request body is **ignored**, not refused.

The rule is `selectableSlots` / `isSlotSelectable` in `packages/shared/src/fulfilment.ts`, beside the date pair and for the same reason. `hours` is one `open`/`close` per weekday, shared by pickup and delivery; a weekday with `null` hours is closed. Slots step from `open` in `slot_minutes` (30 / 60 / 120), and a slot that runs past `close` is dropped. A slot must **start** at or after `now + slot_notice_minutes` on the shop's clock, counted in minutes from the shop's midnight today so a day of notice crosses midnight. **With slots on, a date with no slot is not offered** — `selectableDates` drops it and `isDateSelectable` refuses it — so the storefront never shows a day the customer cannot complete.

Intake judges the slot after the date and before the counter moves: `fulfil_time_required` (slots on, no slot), `fulfil_time_unavailable` (outside hours, off the grid, wrong length, too close, or one end without the other). The row stores **both ends** (`fulfil_time_from`, `fulfil_time_to`, `time`), not a start plus a length: a later change to `slot_minutes` must not rewrite what a customer was promised. Both null means "placed with no slot", the same rule `fulfil_date` uses.

The merchant may move a slot under the customer's rule (`judgeSlotPatch`, `apps/backend/src/orderSlotPatch.ts`), judged against the date the row will hold — a moved date carries its slot along and the slot must be open on the new day. A slot shop's order can move its slot but never clear it; a shop with slots off can only clear one. Each move is a `fulfil_time_changed` event with both ends as `'HH:MM-HH:MM'` labels. The customer is not told, as with the date.

`validateSlotHours` refuses a save with `close_before_open` (on the RAW hours, which the reader would have hidden) or `no_open_day`. `fulfilmentWarning` reports `no_slots` — slots on, dates offered, none with a slot — in red on the dashboard.

Out of scope, on purpose: two ranges per day, hours per method, slot capacity, per-date overrides, and telling the customer of a move.
```

- [ ] **Step 2: ADR 0027**

`docs/adr/0027-a-fulfilment-slot-is-a-window-the-shop-names.md`, in the shape of `0024`:

```markdown
# 0027 — A fulfilment slot is a window the shop names, not a time the customer types

Date: 2026-09-17. Status: accepted. Issue #282.

## Context

A merchant asked for a time on the delivery date. A free time field gives the shop `10:37` and nothing to batch by, and it lets a customer ask for 03:00. The shop needs to say when it is open.

## Decision

1. **Fixed slots.** The merchant sets opening hours per weekday, a slot length (30 / 60 / 120 minutes) and a notice. The customer picks one window. The rule lives in `@bitetime/shared` beside the date rule, and both sides of the wire read it.
2. **Off by default.** `slots_enabled` is false until the merchant turns it on. Existing shops saw no change on the day this shipped.
3. **One set of hours** for pickup and delivery. Two editors and a slot that knows its method were not asked for.
4. **The order stores both ends** of the slot. A later change to the slot length must not rewrite history.
5. **A date with no slot is not offered.** The date rule and the slot rule agree by construction, so the storefront never shows a day the customer cannot complete.

## Consequences

- The merchant drawer moves a slot under the customer's rule, the same way it moves a date.
- A lunch break, hours per method, slot capacity and per-date overrides are separate issues if a merchant asks.
- The notice is counted in minutes from the shop's midnight. A DST shift inside the shop's zone would move it by an hour; no shop on the platform has one.
```

- [ ] **Step 3: Run everything, commit**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @bitetime/backend test:db`
Expected: PASS.

```bash
git add CONTEXT.md docs/adr/0027-a-fulfilment-slot-is-a-window-the-shop-names.md packages/shared/src/orderEvents.ts
git commit -m "docs: record the fulfilment slot rule and ADR 0027

Claude-Session: https://claude.ai/code/session_01MsAqEnXM2x5a1QkTJQxTAN"
```

- [ ] **Step 4: Update issue #282**

```bash
gh issue edit 282 --repo leongcheefai/Bitetime-Order-Platform --remove-label needs-triage --add-label ready-for-agent
gh issue comment 282 --repo leongcheefai/Bitetime-Order-Platform --body "$(cat <<'EOF'
感谢反馈。我们正在加入时段选择：商家在「配送日期」设置中开启后，可设定每周营业时间、时段长度（30/60/120 分钟）和提前下单时间。顾客选好日期后再选一个时段，例如 14:00 – 15:00。

Thank you for the feedback. We are adding time slots. A merchant turns them on in the Fulfilment tab, sets opening hours per weekday, a slot length (30 / 60 / 120 minutes) and a notice. The customer picks a slot after the date, for example 14:00 – 15:00.

Design: docs/superpowers/specs/2026-09-17-fulfilment-time-slots-design.md
EOF
)"
```

---

### Task 14: End-to-end run-and-verify

**Files:** none changed unless a defect is found.

- [ ] **Step 1: Run the `verify` skill**

Invoke `Skill: verify` with the flow: sign in as the demo merchant → Fulfilment tab → turn slots on, Mon–Sat 10:00–18:00, 60 min, 90 min notice → save → storefront `/s/demo-pro` → pick tomorrow and a slot → place an order → success screen shows the slot → dashboard order list shows the slot → open the drawer, move the slot, read the log line → Telegram text (or the `notifyOrder` API test output) carries `*Date:* … 10:00 – 11:00`.

- [ ] **Step 2: Check the off state**

Turn slots off in the tab. Reload the storefront: the "Date" label returns, no slot row, an order places with nulls.

- [ ] **Step 3: Report**

State each checked step plainly with what you saw. If a step failed, say so with the output, fix it in the task that owns the code, and re-run.

- [ ] **Step 4: Finish the branch**

Invoke `superpowers:finishing-a-development-branch`. The PR targets `dev`. The PR body states: "Production needs `db:push` for two migrations" and lists them.
