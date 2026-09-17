# Fulfilment time slots — design

Date: 2026-09-17
Issue: #282 (merchant feedback: "配送只有日期，没有时段选择？")

## Purpose

A customer picks a time slot for the order, after the date. The merchant sets the shop's
opening hours, so the customer cannot pick a time when the shop is shut. A slot is a window
the shop names, for example `14:00 – 15:00`. The customer never types a clock time.

The feature is off for every shop until its merchant turns it on. Every existing shop keeps
its date-only checkout on day one.

## Decisions

| Decision | Choice |
|---|---|
| Time shape | Fixed slots. The merchant sets hours per weekday and a slot length. |
| Default | Off. A switch in the Fulfilment tab turns it on. |
| Hours scope | One set of opening hours for both pickup and delivery. |
| Same-day | A slot is open when it starts at or after `now + slot_notice_minutes`, on the shop's clock. |
| Storage of a slot | Both ends on the order row. A later change to `slot_minutes` must not rewrite history. |
| Where the rule lives | `packages/shared/src/fulfilment.ts`, next to the date rule. Both sides of the wire read it. |

## Config

New fields under `merchants.config -> 'fulfilment'`. `fulfilmentConfig` reads them with per-field
fallbacks, like every other field in the bag. No migration for the config.

```ts
export type SlotMinutes = 30 | 60 | 120

export interface DayHours { open: 'HH:MM'; close: 'HH:MM' }

// FulfilmentConfig gains:
slots_enabled: boolean                       // default false
hours: Record<Weekday, DayHours | null>      // 0 = Sunday … 6 = Saturday; null = closed that day
slot_minutes: SlotMinutes                    // default 60
slot_notice_minutes: number                  // default 0, clamped 0..1440
```

Defaults in `DEFAULT_FULFILMENT`: `slots_enabled: false`, every weekday
`{ open: '09:00', close: '18:00' }`, `slot_minutes: 60`, `slot_notice_minutes: 0`. The hours are
dormant while the switch is off, so the default hours change nothing for a shop that never
opens the card. They give the merchant a filled form when they do.

One `open`/`close` range per weekday. A lunch break is out of scope.

**Read-side clamps** in `fulfilmentConfig`, so a bad row can never take checkout down:

- `hours[d]` with `close <= open`, or with a value that is not `HH:MM`, reads as `null`.
- `slot_minutes` outside `{30, 60, 120}` reads as `60`.
- `slot_notice_minutes` is clamped to `0..1440`.
- `slots_enabled` reads as `true` only for the literal `true`.

## How hours meet the date rule

`closed_weekdays` stays the date rule, rolling mode only. `hours` is the time rule.

When `slots_enabled` is true, `selectableDates` drops a date with zero slots. So a weekday
with `hours[d] = null` behaves as closed, in both modes. The storefront never shows a date the
customer cannot complete. For today, "zero slots" includes the case where every slot has passed
`now + notice`, so a customer at 21:00 sees tomorrow as the first open day.

When `slots_enabled` is false, `hours` does not change `selectableDates` at all.

`isDateSelectable` applies the same rule. A test pins that the two agree.

## New pure functions

```ts
export interface Slot { from: 'HH:MM'; to: 'HH:MM' }

/** The slots this shop offers on this date, in order. What the picker renders. */
export function selectableSlots(date: string, cfg: FulfilmentConfig, tz: string, now: Date): Slot[]

/** May this shop take an order for this slot on this date, right now? The intake predicate. */
export function isSlotSelectable(date: string, slot: Slot, cfg: FulfilmentConfig, tz: string, now: Date): boolean

/** Why these hours cannot be saved, or null. */
export type SlotHoursError = 'close_before_open' | 'no_open_day'
export function validateSlotHours(cfg: FulfilmentConfig): SlotHoursError | null
```

`selectableSlots` rules:

- Returns `[]` when `slots_enabled` is false, when `hours[weekday(date)]` is `null`, or when
  `isDateSelectable(date)` is false.
- Steps from `open` in `slot_minutes`. A slot whose `to` passes `close` is dropped.
- When `date` is today on the shop's clock, a slot with `from < now + slot_notice_minutes` is
  dropped. The comparison is in minutes since the shop's midnight, computed from
  `todayInZone` and the shop's wall clock. A slot that starts exactly at `now + notice` is kept.

`isSlotSelectable` is a predicate over one slot, not a lookup in `selectableSlots`. Intake gets a
slot from a request body and must judge it without building a list. The two must agree, and a
test sweeps dates and clock times to pin that they do. A slot is selectable only when `from`
sits on the step grid from `open`, and `to = from + slot_minutes`.

`validateSlotHours` returns `close_before_open` for a weekday with `close <= open`, and
`no_open_day` when `slots_enabled` is true and no weekday holds at least one full slot. It
returns `null` when `slots_enabled` is false, whatever the hours say.

`fulfilmentWarning` gains `{ kind: 'no_slots' }`: slots are on and no offered date has a slot.
The dashboard banner shows it in red, like `empty`.

## Storage on the order

One migration, idempotent:

```sql
-- 20260917120000_fulfilment_time_slots.sql
alter table public.orders
  add column if not exists fulfil_time_from time,
  add column if not exists fulfil_time_to time;

alter table public.orders
  drop constraint if exists orders_fulfil_time_pair,
  add constraint orders_fulfil_time_pair
    check (
      (fulfil_time_from is null and fulfil_time_to is null)
      or (fulfil_time_from is not null and fulfil_time_to is not null and fulfil_time_to > fulfil_time_from)
    );

comment on column public.orders.fulfil_time_from is
  'Start of the slot the customer picked, shop-local wall clock. Null: placed with no slot.';
comment on column public.orders.fulfil_time_to is
  'End of the slot the customer picked. Stored, not derived, so a later slot_minutes change does not rewrite history.';
```

Null means "placed with no slot": before this feature, or on a shop with slots off. The same
rule `fulfil_date` uses for `null`.

A second migration extends the `order_events` kind check with `fulfil_time_changed`, following
`20260904150000_order_events_fulfil_date.sql`.

Both run locally with `db:migrate`. Production needs a human `db:push`.

## Intake

In `apps/backend/src/orders.ts`, inside the transaction, directly after the date check and
before the counter moves. A refused slot costs the shop nothing, like a refused date.

Two new refusal codes in `packages/shared/src/refusal.ts`, both `409`:

| Code | When |
|---|---|
| `fulfil_time_required` | `slots_enabled` is true and the body carries no slot. |
| `fulfil_time_unavailable` | The body carries a slot that `isSlotSelectable` refuses. |

The body carries `fulfil_time_from` and `fulfil_time_to` as `HH:MM` strings, or neither. One
without the other is `fulfil_time_unavailable`.

When `slots_enabled` is false, a slot in the body is ignored, not refused. The row stores nulls.
A shop that turns slots off must not break a customer who loaded the page before the change.

## Merchant PATCH

`PATCH /api/merchants/:id/orders/:orderId` accepts `fulfil_time_from` and `fulfil_time_to`
together. The rule is the customer's rule: `isSlotSelectable` against the shop's own hours, on
the shop's clock. Refusal: `fulfil_time_unavailable`, `409`.

- A completed order's slot is final, like its date. Refusal: `order_completed` (ADR 0024).
- A patch that moves the date and carries no slot keeps the old slot only when that slot is
  open on the new date. Otherwise the PATCH is refused with `fulfil_time_unavailable`, and the
  drawer asks for a new slot.
- A patch that moves the date and the slot together judges the slot against the new date.
- On a shop with slots off, the drawer may clear a slot (`null, null`). On a shop with slots
  on, a slot can be moved but never cleared.

Each move writes one `fulfil_time_changed` event with both ends before and after. A date move
that also moves the slot writes both event kinds.

The customer is not told of a merchant's move. Same gap as the date, on purpose.

## Storefront

`store/FulfilSlotPicker.tsx`, new. It renders under `FulfilDatePicker` inside the "When" block,
only when `slots_enabled` is true and a date is chosen. The block label reads "Date and time"
for a slot shop.

- A wrap of toggle buttons, one per slot, labelled `14:00 – 15:00`. Built from
  `selectableSlots(chosenDate, cfg, tz, now)`. The component holds no rule of its own.
- A closed slot is hidden, not greyed. A grey run before opening time teaches nothing and
  pushes the open slots off a phone screen.
- State: `fulfilSlot: Slot | null` next to `fulfilDate`. A date change clears the slot. The
  chosen slot is kept only when it is still in the current list, the same guard `chosenDate`
  applies now.
- `now` is re-sampled once a minute while the picker is mounted, so today's passed slot leaves
  the screen. The backend still decides.
- On `fulfil_time_unavailable` or `fulfil_time_required` the storefront clears the slot and
  scrolls to the picker, the same recovery `setFulfilDate(null)` does for the date.
- The summary line and the success screen show `Sat 20 Sep · 14:00 – 15:00`. A sibling of
  `formatCalendarDate` formats the slot in `en` and `zh`.
- `placeOrder` sends `fulfil_time_from` and `fulfil_time_to` when a slot is chosen. `Order` in
  `types.ts` gains the two nullable fields.

The picker does not show how many slots are left and does not block a full slot. Availability
is a flag, never a count (CONTEXT.md).

## Fulfilment tab

A new card, "Time slots", under the date cards in `merchant/FulfilmentTab.tsx`. It saves through
the same `updateMerchantConfig` body and the same `useSaved` cycle. The tab's `eq` gains the
new fields.

Controls, top to bottom:

1. **Switch** — "Let customers pick a time slot". Off by default. When off, the controls below
   stay visible but disabled.
2. **Opening hours** — one row per weekday: a checkbox "Open", an `open` time and a `close`
   time. Native `<input type="time">` with `step="1800"`. "Open" off saves `null`. A weekday in
   `closed_weekdays` renders greyed with the text "Closed in the date rule above".
3. **Slot length** — a `Select`: 30, 60, 120 minutes.
4. **Notice** — "Customers must order at least ___ before the slot". A `Select`: 0, 30, 60, 90,
   120, 180, 240 minutes, 1 day. This is `slot_notice_minutes`.

**Preview.** One line under the controls per open weekday: "Saturday: 10:00 – 11:00, 11:00 –
12:00, … (8 slots)". Built with `selectableSlots` from form state, with a date in the future so
the notice does not hide slots. A day with zero slots shows "0 slots" in amber.

**Validation.** The form runs `validateSlotHours` and refuses to save on an error, naming the
weekday. The backend runs the same function in `PATCH /api/merchants/:id` and answers `400`
with the code.

## Order drawer and notify

`orderDetail/CustomerCard.tsx`: the date field gains a slot `Select` beside it, built from
`selectableSlots` for the chosen date. Visible for a slot shop, or for an order that carries a
slot. The read view shows `14:00 – 15:00` under the date, or a dash.

`notify.ts`: `*Date:* 2026-09-20 14:00 – 15:00` when a slot exists. Unchanged when not.

## Tests

| Layer | Proves |
|---|---|
| `packages/shared/src/fulfilment.test.ts` | Slot steps for 30/60/120. The last partial slot is dropped. Today's slots respect `now + notice` on the shop's clock, across the shop's midnight. `isSlotSelectable` agrees with `selectableSlots` over a sweep. `selectableDates` drops a date with zero slots when slots are on, and ignores hours when off. `fulfilmentConfig` reads junk hours as `null` per day. `validateSlotHours` codes. `fulfilmentWarning` returns `no_slots`. |
| `apps/backend/tests/unit/notify.test.ts` | The slot line prints when present and not when absent. |
| `apps/backend/tests/api/orders.test.ts` | Slot shop, no slot → `fulfil_time_required`, counter unchanged. Slot outside hours → `fulfil_time_unavailable`. Valid slot → row carries both times. Slots off, slot in body → nulls. PATCH to a closed hour → 409. PATCH on a completed order → `order_completed`. A date move whose slot is closed on the new day → `fulfil_time_unavailable`. |
| `apps/backend/tests/api/merchants.test.ts` | `close <= open` → 400 `close_before_open`. A body with no fulfilment bag keeps the stored hours. |
| UI | Run-and-verify against local Supabase: turn slots on, place an order, move the slot in the drawer, read the Telegram text. |

## Docs

- `CONTEXT.md → Fulfilment date` gains a subsection **Fulfilment slot**.
- ADR 0027: *A fulfilment slot is a window the shop names, not a time the customer types.*
  Records: fixed slots, off by default, one set of hours for both methods, both ends stored.
- Issue #282: label `ready-for-agent`, one comment in Chinese and English linking this spec.

## Order of work

1. Shared rule and tests.
2. Migrations, applied locally.
3. Intake and PATCH, with API tests.
4. Storefront picker.
5. Fulfilment tab card.
6. Order drawer and notify.
7. CONTEXT.md and ADR.

Each step is green on its own.

## Out of scope

- Two ranges per day (lunch break).
- Separate hours per fulfilment method.
- Slot capacity.
- Per-date hour overrides (a public holiday with short hours).
- Telling the customer when the merchant moves a slot.
