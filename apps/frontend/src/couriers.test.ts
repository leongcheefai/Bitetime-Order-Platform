import { describe, it, expect } from 'vitest'
import { COURIERS, courierName, trackingUrl } from './couriers'

describe('couriers', () => {
  it('has an "other" fallback with no tracking URL', () => {
    const other = COURIERS.find(c => c.code === 'other')
    expect(other).toBeTruthy()
    expect(other!.track).toBeNull()
  })

  it('trackingUrl builds an https link containing the AWB for a known courier', () => {
    const url = trackingUrl('ninja', 'ABC123456')
    expect(url).not.toBeNull()
    expect(url!.startsWith('https://')).toBe(true)
    expect(url!).toContain('ABC123456')
  })

  it('trackingUrl url-encodes the AWB', () => {
    const url = trackingUrl('ninja', 'A B/C')
    expect(url!).toContain(encodeURIComponent('A B/C'))
  })

  it('trackingUrl returns null for other/unknown courier or blank awb', () => {
    expect(trackingUrl('other', 'ABC')).toBeNull()
    expect(trackingUrl('nope', 'ABC')).toBeNull()
    expect(trackingUrl(null, 'ABC')).toBeNull()
    expect(trackingUrl('ninja', '')).toBeNull()
    expect(trackingUrl('ninja', '   ')).toBeNull()
    expect(trackingUrl('ninja', null)).toBeNull()
  })

  it('courierName round-trips known codes and is empty for unknown/null', () => {
    expect(courierName('ninja')).toBe('Ninja Van')
    expect(courierName('other')).toBeTruthy()
    expect(courierName('nope')).toBe('')
    expect(courierName(null)).toBe('')
  })
})
