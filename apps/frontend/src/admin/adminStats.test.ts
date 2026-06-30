import { describe, it, expect } from 'vitest'
import { computeAdminStats } from './adminStats'
import type { Merchant } from '../types'

const NOW = new Date('2026-06-15T12:00:00')

function merchant(o: Partial<Merchant>): Merchant {
  return { id: o.id ?? 'm', name: 'Shop', slug: 's', status: 'active', created_at: NOW.toISOString(), ...o }
}

describe('computeAdminStats', () => {
  it('counts merchants by status', () => {
    const s = computeAdminStats([
      merchant({ id: '1', status: 'active' }),
      merchant({ id: '2', status: 'active' }),
      merchant({ id: '3', status: 'pending' }),
      merchant({ id: '4', status: 'suspended' }),
    ], NOW)
    expect(s.total).toBe(4)
    expect(s.active).toBe(2)
    expect(s.pending).toBe(1)
    expect(s.suspended).toBe(1)
  })

  it('status breakdown carries percentages and drops empty statuses', () => {
    const s = computeAdminStats([
      merchant({ id: '1', status: 'active' }),
      merchant({ id: '2', status: 'active' }),
      merchant({ id: '3', status: 'pending' }),
    ], NOW)
    expect(s.statusBreakdown.find(x => x.status === 'active')).toEqual({ status: 'active', count: 2, pct: 67 })
    expect(s.statusBreakdown.some(x => x.status === 'suspended')).toBe(false)
  })

  it('empty list yields zeroes without dividing by zero', () => {
    const s = computeAdminStats([], NOW)
    expect(s.total).toBe(0)
    expect(s.statusBreakdown).toEqual([])
    expect(s.signups).toHaveLength(6)
  })

  it('buckets signups into the last 6 months by created_at', () => {
    const s = computeAdminStats([
      merchant({ id: '1', created_at: new Date('2026-06-01T00:00:00').toISOString() }),
      merchant({ id: '2', created_at: new Date('2026-06-09T00:00:00').toISOString() }),
      merchant({ id: '3', created_at: new Date('2026-05-20T00:00:00').toISOString() }),
      merchant({ id: '4', created_at: new Date('2025-01-01T00:00:00').toISOString() }), // outside window
    ], NOW, 6)
    expect(s.signups).toHaveLength(6)
    const jun = s.signups[s.signups.length - 1]
    const may = s.signups[s.signups.length - 2]
    expect(jun.label).toBe('Jun')
    expect(jun.count).toBe(2)
    expect(may.count).toBe(1)
    expect(s.signups.reduce((sum, p) => sum + p.count, 0)).toBe(3) // old one excluded
  })

  it('recent returns the 5 newest by created_at desc', () => {
    const ms = Array.from({ length: 7 }, (_, i) =>
      merchant({ id: String(i), created_at: new Date(2026, 0, i + 1).toISOString() }))
    const s = computeAdminStats(ms, NOW)
    expect(s.recent).toHaveLength(5)
    expect(s.recent[0].id).toBe('6') // newest
  })
})
