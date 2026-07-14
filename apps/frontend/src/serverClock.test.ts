import { describe, it, expect } from 'vitest'
import { clockOffset } from './serverClock'

describe('clockOffset', () => {
  // Half the round trip is OUR latency, not the server's lead. Charging it all to the offset would
  // push the browser's clock ahead of the server's by the network delay.
  it('halves the round trip out of the estimate', () => {
    // sent at 1000, answer read at 1200 → our midpoint is 1100. Server said 1600.
    expect(clockOffset(1600, 1000, 1200)).toBe(500)
  })

  it('is zero when the clocks agree', () => {
    expect(clockOffset(1100, 1000, 1200)).toBe(0)
  })

  it('goes negative when the browser runs fast', () => {
    expect(clockOffset(900, 1000, 1200)).toBe(-200)
  })
})
