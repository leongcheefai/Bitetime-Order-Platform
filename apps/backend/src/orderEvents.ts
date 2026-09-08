// The pure half of the order log (#268, ADR 0025): which events a write produces. No I/O —
// `orderEventsDb.ts` is what inserts them, inside the caller's transaction.
import type { OrderEventKind } from '@bitetime/shared'

/** An event to record, before it has an actor or a row. */
export interface OrderEventDraft {
  kind: OrderEventKind
  detail: Record<string, unknown>
}

/** The columns a merchant PATCH can move, as they were before the write. */
export interface OrderPatchBefore {
  status: string | null
  note: string | null
  courier: string | null
  awb: string | null
  /** `YYYY-MM-DD`, null for an order placed before #91. */
  fulfil_date: string | null
}

/** A merchant PATCH after `pickOrderFields` — only the keys present are being written. */
export interface OrderPatch {
  status?: string
  note?: string | null
  courier?: string | null
  awb?: string | null
  fulfil_date?: string
}

/**
 * The events a merchant PATCH turns into: one per field that actually changed, in a fixed
 * order, and none for a field written back to the value it already had — a retried patch must
 * stay a no-op on the log as it is on the row.
 *
 * A null status MEANS `new` (the storefront wrote the column late), the same coalesce the PATCH
 * handler applies. A note's text is never recorded — the event says that it changed, and the
 * order row says what it is now.
 */
export function orderPatchEvents(before: OrderPatchBefore, patch: OrderPatch): OrderEventDraft[] {
  const out: OrderEventDraft[] = []
  if (patch.status !== undefined) {
    const from = before.status ?? 'new'
    if (patch.status !== from) out.push({ kind: 'status_changed', detail: { from, to: patch.status } })
  }
  if (patch.note !== undefined && (patch.note ?? null) !== (before.note ?? null)) {
    out.push({ kind: 'note_changed', detail: {} })
  }
  if (patch.courier !== undefined && (patch.courier ?? null) !== (before.courier ?? null)) {
    out.push({ kind: 'courier_changed', detail: { from: before.courier ?? null, to: patch.courier ?? null } })
  }
  if (patch.awb !== undefined && (patch.awb ?? null) !== (before.awb ?? null)) {
    out.push({ kind: 'awb_changed', detail: { from: before.awb ?? null, to: patch.awb ?? null } })
  }
  if (patch.fulfil_date !== undefined && patch.fulfil_date !== (before.fulfil_date ?? null)) {
    out.push({ kind: 'fulfil_date_changed', detail: { from: before.fulfil_date ?? null, to: patch.fulfil_date } })
  }
  return out
}
