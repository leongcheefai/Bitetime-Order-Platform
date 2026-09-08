// The order log's two statements (#268, ADR 0025): record events, list them.
//
// `recordOrderEvents` takes the CALLER'S transaction and never opens its own — an event commits
// with the write it records or not at all, and a failed insert here rolls that write back. There
// is no best-effort path. `db.ts` is RLS-exempt, so the order id handed in must already have
// been proved to belong to the shop (`requireOwnsChild`, or the intake transaction that just
// inserted it); this module does not check tenancy and must not be called with an id from a body.
import type postgres from 'postgres'
import { sql } from './db.js'
import type { OrderActorKind, OrderEvent } from '@bitetime/shared'
import type { OrderEventDraft } from './orderEvents.js'

export interface OrderActor {
  kind: OrderActorKind
  /** null for a guest and for the system. */
  id: string | null
}

export const SYSTEM_ACTOR: OrderActor = { kind: 'system', id: null }

type Tx = postgres.TransactionSql | typeof sql

/**
 * Inserts one row per draft, in the order given. Returns the rows as the drawer reads them, so a
 * write route can hand them back in its response and the sheet can append without a refetch.
 * An empty draft list inserts nothing and returns `[]`.
 */
export async function recordOrderEvents(
  tx: Tx,
  order: { id: string; merchantId: string },
  actor: OrderActor,
  drafts: OrderEventDraft[],
): Promise<OrderEvent[]> {
  const out: OrderEvent[] = []
  for (const d of drafts) {
    const [row] = await tx<EventRow[]>`
      insert into order_events (order_id, merchant_id, kind, actor_kind, actor_id, detail)
      values (${order.id}, ${order.merchantId}, ${d.kind}, ${actor.kind}, ${actor.id}, ${tx.json(d.detail as never)})
      returning id, kind, actor_kind, actor_id, detail, created_at
    `
    out.push(toEvent(row))
  }
  return out
}

/** The log of one order, oldest first. Tenancy is the caller's — see the module comment. */
export async function listOrderEvents(orderId: string): Promise<OrderEvent[]> {
  const rows = await sql<EventRow[]>`
    select id, kind, actor_kind, actor_id, detail, created_at from order_events
    where order_id = ${orderId} order by id
  `
  return rows.map(toEvent)
}

type EventRow = {
  id: string | number
  kind: OrderEvent['kind']
  actor_kind: OrderActorKind
  actor_id: string | null
  detail: Record<string, unknown>
  created_at: Date
}

// `timestamptz` arrives as a Date on this connection (db.ts); the wire carries ISO 8601.
function toEvent(r: EventRow): OrderEvent {
  return { id: String(r.id), kind: r.kind, actor_kind: r.actor_kind, actor_id: r.actor_id, detail: r.detail, created_at: r.created_at.toISOString() }
}
