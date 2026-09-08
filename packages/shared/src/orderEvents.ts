/**
 * The ORDER LOG VOCABULARY (#268, ADR 0025): every kind of event the backend can record against
 * an order, and every kind of actor that can cause one. See CONTEXT.md → Order event.
 *
 * Shared for the reason `refusal.ts` is: the backend writes a kind, the drawer renders a
 * sentence for it, and the two must agree. Adding a kind means three places — this list, the
 * CHECK constraint on `order_events.kind` (last moved in `20260904150000_order_events_fulfil_date.sql`), and the drawer's sentence table, whose
 * exhaustiveness test fails until the new kind has words.
 *
 * WHAT IS NOT HERE: the sentence. `t(en, zh)` is the browser's, and the merchant's own actions
 * read as "you", so the words live in `apps/frontend/src/merchant/orderDetail/orderEventLine.ts`.
 */
export const ORDER_EVENT_KINDS = [
  /** The order was placed. `detail.status` is the status it was born with. */
  'created',
  /** The customer attached a payment proof (the `payment_proof` column). */
  'payment_proof_uploaded',
  /** The shop filed its own copy of the receipt (`payment_proof_merchant`). */
  'merchant_payment_proof_uploaded',
  /** `detail.from` → `detail.to`. Actor `system` when a payment proof moved it, `merchant` otherwise. */
  'status_changed',
  /** The merchant's note changed. The text is deliberately NOT recorded — the row holds it. */
  'note_changed',
  /** `detail.from` → `detail.to`, courier codes. */
  'courier_changed',
  /** `detail.from` → `detail.to`, tracking numbers. */
  'awb_changed',
  /** `detail.from` → `detail.to`, `YYYY-MM-DD`. `from` is null for an order placed before #91. */
  'fulfil_date_changed',
  /** A cancellation returned the voucher use this order spent (ADR 0023). `detail.code`. */
  'voucher_released',
  /** Un-cancelling took the voucher use back (ADR 0023). `detail.code`. */
  'voucher_restored',
] as const

export type OrderEventKind = (typeof ORDER_EVENT_KINDS)[number]

export type OrderActorKind = 'merchant' | 'customer' | 'system'

/** One row of the order log, as the merchant reads it. */
export interface OrderEvent {
  id: string
  kind: OrderEventKind
  actor_kind: OrderActorKind
  /** null for a guest customer and for the system. */
  actor_id: string | null
  detail: Record<string, unknown>
  /** ISO 8601. */
  created_at: string
}
