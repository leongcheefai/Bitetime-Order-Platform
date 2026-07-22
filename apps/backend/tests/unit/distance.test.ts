// The distance-resolution policy, tested with a fake adapter and a fake cache — exactly the
// shape tests/unit/notify.test.ts uses for the Telegram send. NO NETWORK IN ANY TEST HERE.
//
// These assert externally observable behaviour: which distance comes back, and whether the
// provider was reached at all (which is money, not an internal detail).
import { describe, it, expect } from 'vitest'
import { resolveDistance, CACHE_TTL_MS, type DistanceDeps } from '../../src/distance.js'
import type { RouteOutcome } from '../../src/maps.js'

const NOW = new Date('2026-07-22T10:00:00Z')
const PAIR = { originPlaceId: 'ChIJorigin', destinationPlaceId: 'ChIJdest' }

/** A fake cache + a fake router, with the two things worth asserting: was the provider reached,
 *  and what got written back. Reaching the provider is MONEY, not an internal detail. */
function tracked(over: { cached?: number | null; cachedAt?: Date; route?: RouteOutcome }) {
  let calls = 0
  const written: number[] = []
  const d: DistanceDeps = {
    readCache: async (_o, _d2, notBefore) => {
      if (over.cached == null) return null
      return (over.cachedAt ?? NOW) >= notBefore ? over.cached : null
    },
    writeCache: async (_o, _d2, metres) => { written.push(metres) },
    lookup: async () => { calls++; return over.route ?? { status: 'failed' } },
  }
  return { deps: d, calls: () => calls, written }
}

describe('resolveDistance', () => {
  it('returns the cached distance and never reaches the provider', async () => {
    const t = tracked({ cached: 25216 })
    expect(await resolveDistance(t.deps, PAIR, NOW)).toEqual({ status: 'ok', metres: 25216 })
    expect(t.calls()).toBe(0)
  })

  it('calls the provider exactly once on a miss and writes the answer back', async () => {
    const t = tracked({ cached: null, route: { status: 'ok', metres: 25216 } })
    expect(await resolveDistance(t.deps, PAIR, NOW)).toEqual({ status: 'ok', metres: 25216 })
    expect(t.calls()).toBe(1)
    expect(t.written).toEqual([25216])
  })

  it('treats a row older than the 30-day TTL as a miss', async () => {
    const stale = new Date(NOW.getTime() - CACHE_TTL_MS - 1)
    const t = tracked({ cached: 111, cachedAt: stale, route: { status: 'ok', metres: 222 } })
    expect(await resolveDistance(t.deps, PAIR, NOW)).toEqual({ status: 'ok', metres: 222 })
    expect(t.calls()).toBe(1)
  })

  it('keeps a row that is one millisecond inside the TTL', async () => {
    const fresh = new Date(NOW.getTime() - CACHE_TTL_MS + 1)
    const t = tracked({ cached: 111, cachedAt: fresh })
    expect(await resolveDistance(t.deps, PAIR, NOW)).toEqual({ status: 'ok', metres: 111 })
    expect(t.calls()).toBe(0)
  })

  it('reports no_route and lookup failure as DISTINCT outcomes, and caches neither', async () => {
    const noRoute = tracked({ cached: null, route: { status: 'no_route' } })
    expect(await resolveDistance(noRoute.deps, PAIR, NOW)).toEqual({ status: 'no_route' })
    expect(noRoute.written).toEqual([])

    const failed = tracked({ cached: null, route: { status: 'failed' } })
    expect(await resolveDistance(failed.deps, PAIR, NOW)).toEqual({ status: 'failed' })
    expect(failed.written).toEqual([])
  })

  it('fails rather than routing when either place id is missing', async () => {
    const t = tracked({ cached: null, route: { status: 'ok', metres: 1 } })
    expect(await resolveDistance(t.deps, { originPlaceId: '', destinationPlaceId: 'x' }, NOW)).toEqual({ status: 'failed' })
    expect(await resolveDistance(t.deps, { originPlaceId: 'x', destinationPlaceId: '' }, NOW)).toEqual({ status: 'failed' })
    expect(t.calls()).toBe(0)
  })

  it('still returns the distance when writing the cache throws', async () => {
    // A cache that cannot be written is a cost problem, not a customer problem.
    let calls = 0
    const d: DistanceDeps = {
      readCache: async () => null,
      writeCache: async () => { throw new Error('disk on fire') },
      lookup: async () => { calls++; return { status: 'ok', metres: 500 } },
    }
    expect(await resolveDistance(d, PAIR, NOW)).toEqual({ status: 'ok', metres: 500 })
    expect(calls).toBe(1)
  })
})
