import { describe, it, expect } from 'vitest'
import { fulfilSlotLabel } from '../../src/fulfilSlotLabel.js'

describe('fulfilSlotLabel', () => {
  it('prints the window from the two DB values, HH:MM only', () => {
    expect(fulfilSlotLabel('14:00:00', '15:00:00')).toBe('14:00 – 15:00')
    expect(fulfilSlotLabel('14:00', '15:00')).toBe('14:00 – 15:00')
  })
  it('is null for a legacy order or a half pair', () => {
    expect(fulfilSlotLabel(null, null)).toBeNull()
    expect(fulfilSlotLabel('14:00:00', null)).toBeNull()
    expect(fulfilSlotLabel(undefined, undefined)).toBeNull()
  })
})
