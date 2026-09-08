// Redemption counts, over the direct `db.ts` connection.
//
// Split from `voucherView.ts` the same way `aiUsageDb.ts` is split from `aiUsage.ts`: the shaping
// rule stays pure and reachable from `pnpm test`, and the two statements that need a database live
// here. The counts the CHECKOUT path needs are not here at all — those run inside the order
// transaction, under the voucher's row lock, in `orders.ts`. A count taken outside that lock is a
// display figure, and these two are exactly that.
//
// `db.ts` is RLS-exempt. Neither function is a tenancy boundary: both take voucher ids the caller
// has already been proved to own (`requireMerchantOwns`) or a single id already filtered by
// `merchant_id` in the query that produced it.
import type postgres from 'postgres'
import { sql } from './db.js'

/**
 * voucher id → how many redemptions it has taken. Ids absent from the result took none.
 *
 * Voided redemptions do not count — a cancelled order returns its use (ADR 0023). This figure is
 * what the merchant's dashboard shows as "used", so it has to agree with the count `claimVoucher`
 * takes under the row lock; a filter here and not there is a shop told a code is spent that
 * checkout will happily take.
 */
export async function redemptionCounts(voucherIds: string[]): Promise<Record<string, number>> {
  if (voucherIds.length === 0) return {}
  const rows = await sql<{ voucher_id: string; n: number }[]>`
    select voucher_id, count(*)::int as n
    from voucher_redemptions
    where voucher_id = any(${voucherIds}::uuid[]) and voided_at is null
    group by voucher_id
  `
  const out: Record<string, number> = {}
  for (const r of rows) out[r.voucher_id] = r.n
  return out
}

/**
 * How many redemptions ONE customer holds on ONE voucher. Voided ones do not count (ADR 0023).
 *
 * `customerKey` must be the lowercased email off a VERIFIED JWT and never a request-body value —
 * the rule `claimVoucher`'s key already follows (#72). Passed anything a client can name, this
 * becomes a way to ask whether a stranger has redeemed a code.
 */
export async function myRedemptionCount(voucherId: string, customerKey: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from voucher_redemptions
    where voucher_id = ${voucherId} and customer_key = ${customerKey} and voided_at is null
  `
  return row?.n ?? 0
}

/**
 * Voids or restores the redemption(s) an order spent, driven off what the order's status now IS,
 * never what it changed from — so the statement is idempotent and a void that failed is repaired
 * by the next patch of the same order rather than lost.
 *
 * Runs on the ORDER PATCH'S OWN TRANSACTION (ADR 0025). It used to trail the patch as a
 * best-effort second write, accepted because the failure direction was the old behaviour (the
 * use stays spent); the order log needed the patch to be a transaction anyway, so this joined it.
 *
 * Returns how many redemptions actually MOVED — only a row that was live is voided, only a
 * voided row is restored — which is what lets the caller log "voucher released" exactly once,
 * and never for an order that spent no voucher or a Cancel pressed twice. The `where` on
 * `voided_at` is also what keeps the FIRST void's timestamp across repeats: the record of when
 * a slot was released must not move because a merchant pressed Cancel twice.
 *
 * The un-void is unconditional: no cap is re-checked. A merchant correcting their own mis-click
 * must not be blocked because another customer took the freed slot meanwhile, so a restore can
 * put a voucher one over `max_uses`. That is the accepted cost of a symmetric cancel — see
 * ADR 0023.
 *
 * `db.ts` is RLS-exempt, and this takes no merchant id: the order id has already been proved to
 * belong to the caller's shop by `requireOwnsChild`. Do not call it with an id from a body.
 */
export async function syncOrderRedemptionVoid(
  tx: postgres.TransactionSql,
  orderId: string,
  cancelled: boolean,
): Promise<number> {
  const rows = await tx<{ id: string }[]>`
    update voucher_redemptions
    set voided_at = ${cancelled ? tx`now()` : tx`null`}
    where order_id = ${orderId}
      and ${cancelled ? tx`voided_at is null` : tx`voided_at is not null`}
    returning id
  `
  return rows.length
}

/** One line of a voucher's history, as the merchant may see it. */
export interface VoucherRedemptionRow {
  id: string
  /** null on a backfilled row — no timestamp exists for a historical entry (ADR 0019). */
  redeemed_at: string | null
  /** Set while the order is cancelled (ADR 0023). */
  voided_at: string | null
  /** null on a backfilled row, and on a row whose order was hard-deleted (`on delete set null`). */
  order_id: string | null
  order_number: string | null
  customer_name: string | null
  discount: string | null
  order_status: string | null
}

/**
 * A voucher's redemptions, newest first, each joined to the order it was spent on.
 *
 * `customer_key` is NOT selected, and must never be: it is the redeemer's platform account email,
 * and CONTEXT.md → Shop customer draws that line — a shop sees shop-scoped facts and no account
 * email. What it sees here is what the ORDER already shows it: the customer name they typed at
 * checkout, the order number, the discount taken. `tests/api/reads-voucher-redemptions.test.ts`
 * asserts the absence.
 *
 * Not a tenancy boundary: the caller has already proved it owns `voucherId` (`requireOwnsChild`).
 * Capped because an unlimited-total voucher has no natural bound; the count the merchant sees
 * elsewhere is `redemptionCounts`, so a cap here hides nothing about the total.
 */
export async function voucherRedemptions(voucherId: string, limit = 200): Promise<VoucherRedemptionRow[]> {
  return await sql<VoucherRedemptionRow[]>`
    select
      r.id, r.redeemed_at, r.voided_at,
      o.id as order_id, o.order_number, o.customer_name, o.discount, o.status as order_status
    from voucher_redemptions r
    left join orders o on o.id = r.order_id
    where r.voucher_id = ${voucherId}
    order by r.redeemed_at desc nulls last, r.id
    limit ${limit}
  `
}
