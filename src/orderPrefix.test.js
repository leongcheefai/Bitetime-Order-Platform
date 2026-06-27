import { describe, it, expect } from 'vitest'
import { orderPrefix } from './orderPrefix'

describe('orderPrefix', () => {
  it('takes first two alphanumerics uppercased', () => {
    expect(orderPrefix('cookie-corner')).toBe('CO')
    expect(orderPrefix('dian-xin-pu')).toBe('DI')
  })
  it('skips non-alphanumerics', () => {
    expect(orderPrefix('a-b-c')).toBe('AB')
  })
  it('falls back to SH when too short', () => {
    expect(orderPrefix('x')).toBe('SH')
    expect(orderPrefix('')).toBe('SH')
  })
})
