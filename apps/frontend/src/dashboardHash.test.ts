// The dashboard's URL hash carries two levels once Settings' sub-tabs live in it (#112):
// `#settings/subscription`. These are the pure halves of that — the hooks own `window`, this
// owns the grammar.
import { describe, it, expect } from 'vitest'
import { parseDashboardHash, dashboardHash } from './dashboardHash'

describe('parseDashboardHash', () => {
  it('reads a bare section', () => {
    expect(parseDashboardHash('#orders')).toEqual({ section: 'orders', sub: null })
  })

  it('reads a section and its sub-tab', () => {
    expect(parseDashboardHash('#settings/subscription')).toEqual({ section: 'settings', sub: 'subscription' })
  })

  // The hash is whatever someone typed or a stale link carried. None of it may throw, and the
  // caller validates the parts against its own known keys anyway.
  it('survives empty, bare-hash and trailing-slash input', () => {
    expect(parseDashboardHash('')).toEqual({ section: '', sub: null })
    expect(parseDashboardHash('#')).toEqual({ section: '', sub: null })
    expect(parseDashboardHash('#settings/')).toEqual({ section: 'settings', sub: null })
  })

  it('ignores anything past the second segment', () => {
    expect(parseDashboardHash('#settings/subscription/extra')).toEqual({
      section: 'settings', sub: 'subscription',
    })
  })

  it('accepts a hash with no leading #', () => {
    expect(parseDashboardHash('settings/payment')).toEqual({ section: 'settings', sub: 'payment' })
  })
})

describe('dashboardHash', () => {
  it('formats a section alone', () => {
    expect(dashboardHash('orders')).toBe('#orders')
  })

  it('formats a section with a sub-tab', () => {
    expect(dashboardHash('settings', 'subscription')).toBe('#settings/subscription')
  })

  // A null/absent sub-tab must not leave a dangling slash — that would parse back to a sub of
  // '' and defeat the round-trip below.
  it('omits an absent sub-tab', () => {
    expect(dashboardHash('settings', null)).toBe('#settings')
    expect(dashboardHash('settings', undefined)).toBe('#settings')
  })

  it('round-trips through parseDashboardHash', () => {
    for (const [section, sub] of [['settings', 'shipping'], ['orders', null]] as const) {
      expect(parseDashboardHash(dashboardHash(section, sub))).toEqual({ section, sub })
    }
  })
})
