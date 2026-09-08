# 25. An order event commits with the action that caused it

Date: 2026-09-04
Status: Accepted. Reverses the *not in a transaction* decision of
[ADR 0023](0023-a-cancelled-order-returns-its-redemption.md) for the voucher void.

## Context

#268 asked for a log of everything that happens to an order: created, payment proof filed, status
moved, note or tracking changed. The merchant reads it in the order drawer, and the case that
makes it worth reading is a dispute — "did the slip land before or after you marked it paid?"

Every order write already runs on the backend, but not the same way. Order intake and the two
payment-proof writes go through `db.ts`, where a transaction is possible. The merchant PATCH goes
through `supabase-js`, where it is not — which is why the voucher void that rides on a
cancellation trails the update as a best-effort second write, and why the comment above it refused
to rewrite the patch as raw SQL "to close a failure that already errs the safe way".

An order event has no safe way to err. A log with a missing line is read as "that did not happen",
and in a dispute that reading is the whole point of the log. A best-effort event write is
therefore not a cheaper log; it is a log the merchant cannot rely on, which is none.

## Decision

**Every order event is inserted in the same transaction as the write it records.** If the event
cannot be written, the action does not commit. There is no trailing write and no `console.error`
path for a lost event.

**The merchant PATCH moves to `db.ts`.** That is the one write site that had no transaction, and
the rewrite is the cost of this decision. The voucher void of ADR 0023 moves into the same
transaction, so the failure that comment accepted — an order cancelled with its use still spent —
is closed as a consequence rather than as a second piece of work.

**Events are append-only and are never deleted.** The browser roles hold no grant on the table at
all; `service_role` inserts and reads. Volume is about six rows an order and does not justify a
retention rule.

**Orders from before the log get no invented events.** The drawer reads "placed" off the order's
own `created_at`, which is a fact the row already holds, and shows the log as starting from the
first recorded event. A backfilled status history would be a guess written as a record — the same
line the fulfilment-date migration drew when it refused to invent a date.

## Considered

- **Best-effort after the write.** Cheapest. Rejected for the reason above: the log exists for the
  case where a hole is the worst outcome.
- **Atomic where a transaction already exists, best-effort on the PATCH only.** Leaves the one
  site the merchant uses most as the one site the log can miss.
- **One diff row per PATCH instead of one event per change.** Fewer rows, but the drawer renders
  one line per change either way, so the diff would be exploded on read. Event per change also
  makes a future date change one more kind and no schema change.
