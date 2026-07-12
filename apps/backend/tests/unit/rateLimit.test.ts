import { describe, it, expect } from 'vitest'
import { createSlidingWindow } from '../../src/rateLimit.js'

// The clock is injected, so the window can be rolled without waiting on real time.
function fakeClock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

describe('createSlidingWindow', () => {
  it('allows up to the limit and blocks the next hit', () => {
    const clock = fakeClock()
    const limiter = createSlidingWindow({ limit: 3, windowMs: 60_000, now: clock.now })

    expect(limiter.allow('ip:1.1.1.1')).toBe(true)
    expect(limiter.allow('ip:1.1.1.1')).toBe(true)
    expect(limiter.allow('ip:1.1.1.1')).toBe(true)
    expect(limiter.allow('ip:1.1.1.1')).toBe(false)
  })

  it('allows again once the window has rolled past the earlier hits', () => {
    const clock = fakeClock()
    const limiter = createSlidingWindow({ limit: 2, windowMs: 60_000, now: clock.now })

    expect(limiter.allow('ip:1.1.1.1')).toBe(true)
    expect(limiter.allow('ip:1.1.1.1')).toBe(true)
    expect(limiter.allow('ip:1.1.1.1')).toBe(false)

    clock.advance(60_001)
    expect(limiter.allow('ip:1.1.1.1')).toBe(true)
  })

  it('slides rather than resetting: only the hits that aged out are freed', () => {
    const clock = fakeClock()
    const limiter = createSlidingWindow({ limit: 2, windowMs: 60_000, now: clock.now })

    limiter.allow('ip:1.1.1.1')          // t = 0
    clock.advance(30_000)
    limiter.allow('ip:1.1.1.1')          // t = 30s
    clock.advance(30_001)                // t = 60.001s — the first hit has aged out, the second has not
    expect(limiter.allow('ip:1.1.1.1')).toBe(true)
    expect(limiter.allow('ip:1.1.1.1')).toBe(false)
  })

  it('counts each key independently', () => {
    const clock = fakeClock()
    const limiter = createSlidingWindow({ limit: 1, windowMs: 60_000, now: clock.now })

    expect(limiter.allow('email:a@example.com')).toBe(true)
    expect(limiter.allow('email:a@example.com')).toBe(false)
    // Exhausting one email must not block a different one.
    expect(limiter.allow('email:b@example.com')).toBe(true)
  })

  it('forgets keys whose hits have all aged out, so memory does not grow forever', () => {
    const clock = fakeClock()
    const limiter = createSlidingWindow({ limit: 1, windowMs: 60_000, now: clock.now })

    for (let i = 0; i < 50; i++) limiter.allow(`email:user${i}@example.com`)
    expect(limiter.size()).toBe(50)

    clock.advance(60_001)
    limiter.allow('email:someone-else@example.com')
    expect(limiter.size()).toBe(1)
  })
})
