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
