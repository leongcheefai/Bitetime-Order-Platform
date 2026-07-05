import { describe, it, expect } from 'vitest'
import raw from './postcodes-my.json'
import { lookupPostcode } from './postcodes'

const map = raw as Record<string, string>
// Pick real keys straight from the generated data so the test never depends on
// a hardcoded postcode being present.
const anyKey = Object.keys(map)[0]
const sabahKey = Object.keys(map).find(k => map[k].endsWith('|Sabah'))!

describe('lookupPostcode', () => {
  it('resolves a known postcode to city + state', async () => {
    const hit = await lookupPostcode(anyKey)
    expect(hit).not.toBeNull()
    expect(typeof hit!.city).toBe('string')
    expect(hit!.city.length).toBeGreaterThan(0)
  })

  it('resolves an East-Malaysia postcode to its state', async () => {
    const hit = await lookupPostcode(sabahKey)
    expect(hit!.state).toBe('Sabah')
  })

  it('returns null for a non-5-digit code', async () => {
    expect(await lookupPostcode('1234')).toBeNull()
    expect(await lookupPostcode('ABCDE')).toBeNull()
  })

  it('returns null for an unknown 5-digit code', async () => {
    // 00000 is not a real MY postcode and is absent from the dataset.
    expect(await lookupPostcode('00000')).toBeNull()
  })
})
