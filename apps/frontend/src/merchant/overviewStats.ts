// Pure aggregation for the merchant Overview dashboard. No Supabase / React here —
// the dashboard fetches rows via store.ts, this turns them into KPI numbers and
// chart series. Kept pure so it is unit-tested like pricing.ts.

import type { Order, Product, Voucher } from '../types'

export interface Delta { pct: number; dir: 'up' | 'down' | 'flat' }
export interface DailyPoint { key: string; label: string; revenue: number; orders: number }
export interface Slice { name: string; value: number }
export interface StatusSlice { status: string; count: number; pct: number }

export interface MerchantStats {
  totalOrders: number
  revenue: number
  customerCount: number
  avgOrder: number
  vouchersRedeemed: number
  ordersDelta: Delta
  revenueDelta: Delta
  daily: DailyPoint[]
  productRevenue: Slice[]
  statusBreakdown: StatusSlice[]
}

// "Booked" revenue counts every order that wasn't cancelled (pending orders are
// still money in the pipeline) — matches the storefront's own total field.
const counts = (o: Order) => (o.status ?? 'new') !== 'cancelled'
const orderTotal = (o: Order) => (counts(o) ? Number(o.total) || 0 : 0)

function monthKey(iso?: string): number | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.getFullYear() * 12 + d.getMonth()
}

function delta(cur: number, prev: number): Delta {
  if (prev === 0) return { pct: cur > 0 ? 100 : 0, dir: cur > 0 ? 'up' : 'flat' }
  const pct = ((cur - prev) / prev) * 100
  return { pct: Math.round(pct), dir: pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat' }
}

// Per-day buckets for the last `days` days ending on `now` (inclusive).
function dailySeries(orders: Order[], now: Date, days: number): DailyPoint[] {
  const points: DailyPoint[] = []
  const index = new Map<string, DailyPoint>()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
    const p: DailyPoint = { key, label: `${d.getMonth() + 1}/${d.getDate()}`, revenue: 0, orders: 0 }
    points.push(p); index.set(key, p)
  }
  for (const o of orders) {
    if (!o.created_at) continue
    const d = new Date(o.created_at)
    if (Number.isNaN(d.getTime())) continue
    const p = index.get(`${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`)
    if (!p) continue
    p.orders += 1
    p.revenue += orderTotal(o)
  }
  return points
}

// Revenue per product from line items; top `top` by value, remainder folded into "Other".
function productRevenue(orders: Order[], top: number): Slice[] {
  const by = new Map<string, number>()
  for (const o of orders) {
    if (!counts(o)) continue
    for (const it of o.items ?? []) {
      const name = it.name || it.id || '—'
      const value = (Number(it.price) || 0) * (Number(it.qty) || 0)
      by.set(name, (by.get(name) ?? 0) + value)
    }
  }
  const sorted = [...by.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value)
  if (sorted.length <= top) return sorted
  const head = sorted.slice(0, top)
  const other = sorted.slice(top).reduce((s, x) => s + x.value, 0)
  return other > 0 ? [...head, { name: 'Other', value: other }] : head
}

function statusBreakdown(orders: Order[]): StatusSlice[] {
  const by = new Map<string, number>()
  for (const o of orders) {
    const s = String(o.status ?? 'new')
    by.set(s, (by.get(s) ?? 0) + 1)
  }
  const total = orders.length || 1
  return [...by.entries()]
    .map(([status, count]) => ({ status, count, pct: Math.round((count / total) * 100) }))
    .sort((a, b) => b.count - a.count)
}

export function computeMerchantStats(
  orders: Order[],
  _products: Product[],
  customers: { orderCount?: number }[],
  vouchers: Voucher[],
  now: Date = new Date(),
  days = 12,
): MerchantStats {
  const booked = orders.filter(counts)
  const revenue = orders.reduce((s, o) => s + orderTotal(o), 0)
  const thisKey = now.getFullYear() * 12 + now.getMonth()

  let ordersThis = 0, ordersLast = 0, revThis = 0, revLast = 0
  for (const o of orders) {
    const k = monthKey(o.created_at)
    if (k === thisKey) { ordersThis++; revThis += orderTotal(o) }
    else if (k === thisKey - 1) { ordersLast++; revLast += orderTotal(o) }
  }

  return {
    totalOrders: orders.length,
    revenue,
    customerCount: customers.length,
    avgOrder: booked.length ? revenue / booked.length : 0,
    vouchersRedeemed: vouchers.reduce((s, v) => s + (v.usedBy?.length ?? 0), 0),
    ordersDelta: delta(ordersThis, ordersLast),
    revenueDelta: delta(revThis, revLast),
    daily: dailySeries(orders, now, days),
    productRevenue: productRevenue(orders, 6),
    statusBreakdown: statusBreakdown(orders),
  }
}
