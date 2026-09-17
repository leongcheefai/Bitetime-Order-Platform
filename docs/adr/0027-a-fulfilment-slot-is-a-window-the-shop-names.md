# 27. A fulfilment slot is a window the shop names, not a time the customer types

Date: 2026-09-17
Status: Accepted. Extends the fulfilment date rule ([ADR 0015](0015-a-shop-with-no-offerable-dates-pauses.md)). Issue #282.

## Context

A merchant asked for a time on the delivery date: "配送只有日期，没有时段选择？". The date rule
already lives in `@bitetime/shared` and both sides of the wire read it, so the question was what
shape a time takes, not where it lives.

A free time field has two problems. It hands the shop `10:37`, a number it cannot batch by. And it
lets a customer ask for 03:00, because nothing says when the shop is open. The shop has to say.

## Decision

1. **Fixed slots.** The merchant sets opening hours per weekday, a slot length (30 / 60 / 120
   minutes) and a notice. The customer picks one window, `14:00 – 15:00`. The rule
   (`selectableSlots` / `isSlotSelectable`) lives beside the date rule in
   `packages/shared/src/fulfilment.ts`, and a test sweeps the grid to pin that the two agree.
2. **Off by default.** `slots_enabled` is false until the merchant turns it on. Every shop that
   predates the feature reads as slots off and saw no change on the day it shipped. While off, a
   slot in a request body is ignored, not refused.
3. **One set of hours** for pickup and delivery. Two editors, and a slot that knows its method,
   were not asked for.
4. **The order stores both ends** of the slot (`fulfil_time_from`, `fulfil_time_to`). A later
   change to the slot length must not rewrite what a customer was promised.
5. **A date with no slot is not offered.** `selectableDates` and `isDateSelectable` both apply the
   slot rule when slots are on, so the storefront never shows a day the customer cannot complete,
   and a scripted POST is refused on the same days.

## Consequences

- The merchant drawer moves a slot under the customer's rule, the way it moves a date
  (`judgeSlotPatch`). A slot shop's order can move its slot but never clear it.
- The notice is counted in minutes from the shop's midnight. A DST shift inside the shop's own
  zone would move it by an hour; no shop on the platform has one, and an hour of notice is not a
  price.
- `validateSlotHours` reads the **raw** hours, for the reason `too_many` counts the raw allowlist:
  the reader hides a `close <= open` day as closed, and a merchant who typed it must be told.
- A lunch break, hours per method, slot capacity and per-date overrides are separate issues if a
  merchant asks for them.
