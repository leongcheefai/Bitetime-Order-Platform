import { describe, it, expect } from 'vitest'
import { computeMerchantStats } from './overviewStats'
import type { Order } from '../types'

const NOW = new Date('2026-06-15T12:00:00')

function order(o: Partial<Order>): Order {
  return { status: 'completed', total: 0, items: [], created_at: NOW.toISOString(), ...o }
}

describe('computeMerchantStats', () => {
  it('totals revenue over non-cancelled orders and counts every order', () => {
    const orders = [
      order({ total: 30 }),
      order({ total: 20 }),
      order({ total: 99, status: 'cancelled' }),
    ]
    const s = computeMerchantStats(orders, [], [], [], NOW)
    expect(s.totalOrders).toBe(3)
    expect(s.revenue).toBe(50) // cancelled excluded
    expect(s.avgOrder).toBe(25) // 50 / 2 booked
  })

  it('avgOrder is 0 with no booked orders', () => {
    const s = computeMerchantStats([], [], [], [], NOW)
    expect(s.avgOrder).toBe(0)
    expect(s.revenue).toBe(0)
  })

  it('counts customers and redeemed voucher uses', () => {
    const s = computeMerchantStats([], [], [{ orderCount: 2 }, { orderCount: 1 }], [
      { code: 'A', usedBy: ['x', 'y'] },
      { code: 'B', usedBy: [] },
    ], NOW)
    expect(s.customerCount).toBe(2)
    expect(s.vouchersRedeemed).toBe(2)
  })

  it('computes month-over-month order delta', () => {
    const may = new Date('2026-05-10T10:00:00').toISOString()
    const orders = [
      order({ total: 10 }), order({ total: 10 }), order({ total: 10 }), // 3 this month (Jun)
      order({ total: 10, created_at: may }),                            // 1 last month (May)
    ]
    const s = computeMerchantStats(orders, [], [], [], NOW)
    expect(s.ordersDelta).toEqual({ pct: 200, dir: 'up' }) // 3 vs 1
    expect(s.revenueDelta.dir).toBe('up')
  })

  it('delta is up=100 when previous month had zero', () => {
    const s = computeMerchantStats([order({ total: 5 })], [], [], [], NOW)
    expect(s.ordersDelta).toEqual({ pct: 100, dir: 'up' })
  })

  it('builds a daily series of the requested length, bucketing revenue', () => {
    const orders = [order({ total: 40, created_at: new Date('2026-06-15T08:00:00').toISOString() })]
    const s = computeMerchantStats(orders, [], [], [], NOW, 12)
    expect(s.daily).toHaveLength(12)
    const today = s.daily[s.daily.length - 1]
    expect(today.label).toBe('6/15')
    expect(today.revenue).toBe(40)
    expect(today.orders).toBe(1)
  })

  it('aggregates product revenue from line items, descending', () => {
    const orders = [
      order({ items: [{ id: 'p1', name: 'Cake', qty: 2, price: 10 }, { id: 'p2', name: 'Tea', qty: 1, price: 5 }] }),
      order({ items: [{ id: 'p1', name: 'Cake', qty: 1, price: 10 }] }),
    ]
    const s = computeMerchantStats(orders, [], [], [], NOW)
    expect(s.productRevenue[0]).toEqual({ name: 'Cake', value: 30 })
    expect(s.productRevenue[1]).toEqual({ name: 'Tea', value: 5 })
  })

  it('folds products beyond the top 6 into "Other"', () => {
    const items = Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, qty: 1, price: 9 - i }))
    const s = computeMerchantStats([order({ items })], [], [], [], NOW)
    expect(s.productRevenue).toHaveLength(7) // 6 + Other
    expect(s.productRevenue[6].name).toBe('Other')
    expect(s.productRevenue[6].value).toBe(3 + 2 + 1) // p6,p7,p8 prices = 3,2,1
  })

  it('breaks down orders by status with percentages', () => {
    const orders = [order({ status: 'new' }), order({ status: 'new' }), order({ status: 'completed' }), order({ status: 'cancelled' })]
    const s = computeMerchantStats(orders, [], [], [], NOW)
    expect(s.statusBreakdown[0]).toEqual({ status: 'new', count: 2, pct: 50 })
    expect(s.statusBreakdown.reduce((sum, x) => sum + x.count, 0)).toBe(4)
  })
})
