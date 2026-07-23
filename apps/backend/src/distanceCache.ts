// The live wiring for distance resolution: the real Postgres cache and the real router,
// assembled into the deps `resolveDistance` takes.
//
// SEPARATE FROM distance.ts ON PURPOSE. `db.ts` and `maps.ts` both reach `env.ts`, which
// THROWS at import time on a missing var — so a policy module that imported them could not be
// unit-tested without a full env var set, and the backend unit suite is documented as needing
// none. Same seam as app.ts/index.ts: the rule is importable, the I/O is assembled next door.
import { sql } from './db.js'
import { googleRouteLookup } from './maps.js'
import type { DistanceDeps } from './distance.js'

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
