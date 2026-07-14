// The order-number format, alone in a pure module so `pnpm test` can pin it without a
// database. Ported from next_order_number's PL/pgSQL, character for character.

/**
 * A new day's counter starts here, not at 1 — so a shop's first order of the day does not
 * announce to the customer that it is their first. Inherited from the SQL; changing it
 * changes customer-visible order numbers.
 */
export const COUNTER_START = 50

/**
 * The day stamp: `YYMMDD`, in UTC.
 *
 * Two things here are inherited rather than chosen, and both matter.
 *
 * Six digits, not eight. The SQL was `to_char(now(), 'YYMMDD')`, and order numbers are
 * printed on receipts and quoted over WhatsApp — this is not the ticket to relabel them.
 * (CLAUDE.md documented `YYYYMMDD`; the doc was wrong and is corrected, not the behaviour.)
 *
 * UTC, because `to_char(now(), …)` used the database's timezone and Supabase's is UTC. Shops
 * are in UTC+8, so the day already rolls over at 08:00 local — an order placed at 07:00 in
 * Kuala Lumpur carries yesterday's stamp. That is the existing behaviour, bug or not, and
 * "byte-identical order numbers" means keeping it. Fixing it is a separate, deliberate change
 * to what customers see.
 *
 * Note what moved, though: the day used to be decided by POSTGRES's clock and timezone, and is
 * now decided by this NODE PROCESS's. They agree only while both are UTC. Set a `timezone` GUC
 * on the database, or run the backend somewhere with a local TZ, and the two would have
 * disagreed — this uses UTC explicitly (`getUTC*`, not `getMonth`) so the host's TZ cannot
 * drag it, which leaves the database GUC as the only thing that could ever have moved it.
 */
export function orderDay(now: Date): string {
  const yy = String(now.getUTCFullYear() % 100).padStart(2, '0')
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(now.getUTCDate()).padStart(2, '0')
  return `${yy}${mm}${dd}`
}

/** `<PREFIX>-<YYMMDD>-<NNNN>`, the counter padded to four digits (and never truncated). */
export function formatOrderNumber(prefix: string, day: string, value: number): string {
  return `${prefix}-${day}-${String(value).padStart(4, '0')}`
}
