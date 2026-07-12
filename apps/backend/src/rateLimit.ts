// An in-memory sliding-window counter. Pure but for the clock, which is injected so
// the window can be rolled in a test instead of waited out.
//
// Each key carries its own hit timestamps; hits older than the window are dropped on
// access, so the window slides rather than resetting on a fixed boundary. Keys whose
// hits have all aged out are forgotten, which is what keeps the map from growing for
// the life of the process.

export interface SlidingWindow {
  /** Records a hit and reports whether it was within the limit. */
  allow(key: string): boolean
  /** Keys currently held. Exposed for the memory-growth test. */
  size(): number
}

export function createSlidingWindow({
  limit,
  windowMs,
  now,
}: {
  limit: number
  windowMs: number
  now: () => number
}): SlidingWindow {
  const hits = new Map<string, number[]>()

  // Drop every key with no live hits left. Runs at most once per window, driven by the
  // injected clock — a timer would keep the process alive and be untestable.
  let sweptAt = now()
  const sweep = (cutoff: number) => {
    if (now() - sweptAt < windowMs) return
    sweptAt = now()
    for (const [key, times] of hits) {
      const live = times.filter((t) => t > cutoff)
      if (live.length === 0) hits.delete(key)
      else hits.set(key, live)
    }
  }

  return {
    allow(key) {
      const cutoff = now() - windowMs
      sweep(cutoff)

      const live = (hits.get(key) ?? []).filter((t) => t > cutoff)
      if (live.length >= limit) {
        hits.set(key, live)
        return false
      }
      live.push(now())
      hits.set(key, live)
      return true
    },
    size() {
      return hits.size
    },
  }
}
