// Resolving an (origin, destination) pair to a road distance: read the cache, and on a miss ask
// the routing provider and write the cache.
//
// This is POLICY, not I/O. The provider call and the two cache statements are injected
// adapters — the same shape as `telegramSend` in notify.ts — so every rule here (the 30-day
// expiry, what is cached, which outcomes are distinct) is unit-testable without a network or a
// database.
//
// The three outcomes must stay distinct all the way to the customer: `no_route` is an answer
// about the world and is refused permanently; `failed` is our problem and is the ONLY one worth
// retrying. See CONTEXT.md -> "Shipping policy".
import { sql } from './db.js'
import { googleRouteLookup, type RouteLookup } from './maps.js'

export type DistanceOutcome =
  | { status: 'ok'; metres: number }
  | { status: 'no_route' }
  | { status: 'failed' }

export interface DistanceDeps {
  lookup: RouteLookup
  /** A cached distance for this pair written at or after `notBefore`, or null. */
  readCache: (originPlaceId: string, destinationPlaceId: string, notBefore: Date) => Promise<number | null>
  writeCache: (originPlaceId: string, destinationPlaceId: string, metres: number) => Promise<void>
}

/**
 * 30 days. This is GOOGLE'S TERMS — the maximum they allow this data to be retained — not a
 * performance knob. Do not raise it.
 */
export const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000

export async function resolveDistance(
  deps: DistanceDeps,
  input: { originPlaceId: string; destinationPlaceId: string },
  now = new Date(),
): Promise<DistanceOutcome> {
  const { originPlaceId, destinationPlaceId } = input
  // A missing id cannot name a place, and asking Google about `''` is a billable nothing.
  if (!originPlaceId || !destinationPlaceId) return { status: 'failed' }

  const notBefore = new Date(now.getTime() - CACHE_TTL_MS)
  const cached = await deps.readCache(originPlaceId, destinationPlaceId, notBefore)
  if (cached !== null) return { status: 'ok', metres: cached }

  const outcome = await deps.lookup(originPlaceId, destinationPlaceId)
  if (outcome.status !== 'ok') return outcome

  // Only a real distance is cached. Caching `no_route` would be tempting and wrong: roads are
  // built, and a permanent negative is not ours to store. Caching `failed` would freeze OUR
  // outage into the customer's address for a month.
  try {
    await deps.writeCache(originPlaceId, destinationPlaceId, outcome.metres)
  } catch (err) {
    // A cache we could not write is a cost problem, not a customer problem. The distance we
    // already paid for still gets used.
    console.error('Distance cache write failed:', err instanceof Error ? err.message : String(err))
  }
  return outcome
}

/**
 * The real cache, on the RLS-exempt `db.ts` connection.
 *
 * `distance_quotes` is keyed by the two place ids and by nothing else — no `merchant_id`. That
 * is deliberate: two shops with the same origin are the same route, and a merchant who moves
 * changes their `origin_place_id` and so invalidates their own rows with no sweep to run.
 */
export const sqlDistanceCache: Pick<DistanceDeps, 'readCache' | 'writeCache'> = {
  readCache: async (originPlaceId, destinationPlaceId, notBefore) => {
    const rows = await sql<{ metres: number }[]>`
      select metres from distance_quotes
      where origin_place_id = ${originPlaceId}
        and destination_place_id = ${destinationPlaceId}
        and created_at >= ${notBefore}
    `
    return rows[0]?.metres ?? null
  },
  writeCache: async (originPlaceId, destinationPlaceId, metres) => {
    // Upsert, so re-resolving an EXPIRED row refreshes its timestamp rather than colliding on
    // the primary key.
    await sql`
      insert into distance_quotes (origin_place_id, destination_place_id, metres, created_at)
      values (${originPlaceId}, ${destinationPlaceId}, ${metres}, now())
      on conflict (origin_place_id, destination_place_id)
        do update set metres = excluded.metres, created_at = excluded.created_at
    `
  },
}

/** The wiring the app uses: the real cache plus the real provider. */
export const liveDistanceDeps: DistanceDeps = { ...sqlDistanceCache, lookup: googleRouteLookup }
