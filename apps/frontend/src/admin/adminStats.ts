// Pure aggregation for the superadmin Overview dashboard. Turns the merchant list
// into platform KPIs + chart series. No Supabase / React — unit-tested like pricing.ts.

import type { Merchant, MerchantStatus } from '../types'

export interface StatusSlice { status: MerchantStatus; count: number; pct: number }
export interface SignupPoint { key: string; label: string; count: number }

export interface AdminStats {
  total: number
  active: number
  pending: number
  suspended: number
  statusBreakdown: StatusSlice[]
  signups: SignupPoint[]
  recent: Merchant[]
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function monthKey(iso?: string): number | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.getFullYear() * 12 + d.getMonth()
}

// Signups per calendar month for the last `months` months ending on `now`.
function signupSeries(merchants: Merchant[], now: Date, months: number): SignupPoint[] {
  const points: SignupPoint[] = []
  const index = new Map<number, SignupPoint>()
  const nowKey = now.getFullYear() * 12 + now.getMonth()
  for (let i = months - 1; i >= 0; i--) {
    const k = nowKey - i
    const p: SignupPoint = { key: String(k), label: MONTHS[((k % 12) + 12) % 12], count: 0 }
    points.push(p); index.set(k, p)
  }
  for (const m of merchants) {
    const k = monthKey(m.created_at)
    if (k == null) continue
    const p = index.get(k)
    if (p) p.count += 1
  }
  return points
}

export function computeAdminStats(merchants: Merchant[], now: Date = new Date(), months = 6): AdminStats {
  const by: Record<MerchantStatus, number> = { active: 0, pending: 0, suspended: 0 }
  for (const m of merchants) {
    if (m.status in by) by[m.status] += 1
  }
  const total = merchants.length
  const order: MerchantStatus[] = ['active', 'pending', 'suspended']
  const statusBreakdown = order
    .map(status => ({ status, count: by[status], pct: total ? Math.round((by[status] / total) * 100) : 0 }))
    .filter(s => s.count > 0)

  const recent = [...merchants]
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
    .slice(0, 5)

  return {
    total,
    active: by.active,
    pending: by.pending,
    suspended: by.suspended,
    statusBreakdown,
    signups: signupSeries(merchants, now, months),
    recent,
  }
}
