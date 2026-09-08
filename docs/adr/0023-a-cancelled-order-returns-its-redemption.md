# 23. A cancelled order returns its voucher redemption

Date: 2026-09-02
Status: Accepted. Reverses the *A cancellation returns nothing* consequence of
[ADR 0019](0019-voucher-redemptions-are-rows-not-a-list.md). Its *not in a transaction* decision
below is reversed by [ADR 0025](0025-an-order-event-commits-with-its-action.md): the void now runs
inside the order patch's transaction, and a `where voided_at is null` predicate replaced the
`coalesce` — same first-timestamp guarantee, and it also reports whether a row actually moved.

## Context

A redemption was spent when the order was placed, full stop. Nothing released it. The merchant
cancels the order, the customer loses the code, and neither of them is told.

Two cases made that wrong rather than merely strict:

- **The order the shop itself cancels.** A shop that is out of an item cancels, and the customer
  who came holding a promotion code is charged for it. There is nothing they did.
- **The order that was never paid for.** An order is born `pending_payment` when the shop takes
  manual payment. If it is never paid and the merchant cancels it, a use has been spent on nothing
  at all.

ADR 0019 left this open deliberately: it recorded the answer as no, and made the question
answerable from data by putting `order_id` on the redemption row. This is that question, answered.

## Decision

**A redemption is void if and only if its order is `cancelled`.** The state, not the transition.

The column is `voucher_redemptions.voided_at`, and both caps — the total against `max_uses` and the
per-customer count against `per_customer_limit` — count only rows where it is null.

**Not a delete.** The row survives, so "has this customer ever used the code?" still has a true
answer, and the release carries the time it happened. A delete would also make un-cancelling an
insert that has to race the caps again.

**Un-cancelling restores the redemption, unconditionally.** No cap is re-checked. This can put a
voucher one over `max_uses` when someone else took the freed slot in between. Accepted: refusing a
merchant's correction of their own mis-click, because of an unrelated customer's order, is the
worse failure — and the merchant already sets the cap.

**State-driven is what makes the write idempotent.** The handler passes the status the order now
has and never reads the previous one, so a repeat is a no-op, `coalesce(voided_at, now())` keeps
the first release's timestamp, and a void that failed is repaired by the next patch of that order.

**The void is not in a transaction with the order update.** *(Reversed by ADR 0025 — see Status.)*
The order patch goes through the REST client and also carries `note`, `courier` and `awb`;
rewriting all of it as raw SQL to gain atomicity would buy nothing here, because the failure
already errs the safe way — the order is cancelled and the use stays spent, which is exactly the
behaviour this ADR replaces. The failure is logged, never swallowed silently.

## Rejected

- **One-way release.** Cancel frees the use; un-cancelling does not take it back. Simpler, and
  permanently hands out a free use of the voucher every time a merchant mis-clicks.
- **Restore only if a slot is free.** Never over-issues. Rejected because it lets an unrelated
  customer's order block a merchant from correcting their own shop's record.
- **Hard delete the row.** Smallest change to the counts. Rejected on the audit trail: the merchant
  loses the fact that the code was ever redeemed, which is the thing ADR 0019 built the table for.
- **Release on the customer's non-payment as well.** A `pending_payment` order nobody cancels still
  holds its use for ever. Left alone: that needs an expiry rule for unpaid orders, which is its own
  decision about when a shop stops waiting.

## Consequences

- A merchant can free a slot on their own voucher by cancelling orders. Not a threat: the cap is
  theirs, and they can already raise it.
- `vouchers.used_by` is untouched and stays dead. It is written by nothing, so it now understates
  and overstates nothing — it is simply frozen at the backfill, and the merchant stats figure
  reading it (`app.ts`) was already stale before this change.
- Every count of `voucher_redemptions` must now say `voided_at is null`. There are three, and the
  one under the row lock in `claimVoucher` is the only one that frees a slot for a customer; the
  other two are display figures that would disagree with checkout if they were missed.
