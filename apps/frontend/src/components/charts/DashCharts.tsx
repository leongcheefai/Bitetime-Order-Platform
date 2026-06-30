import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  PieChart, Pie, Cell,
} from 'recharts'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

// Brand-derived palette (oxblood family + gold + semantic accents from tokens.css).
const CHART_COLORS = ['#7A1028', '#C9A030', '#B86B6B', '#5A1A7A', '#1A7A3A', '#0C5460', '#A07820']
const OXBLOOD = '#7A1028'
const GOLD = '#C9A030'
const AXIS = '#8A5550'      // --color-text-tertiary
const GRID = '#E8D5C8'      // warm hairline

const tooltipStyle = {
  background: '#FFFDF9',
  border: '1.5px solid #C9A0A8',
  borderRadius: 10,
  fontSize: 12,
  fontFamily: 'DM Sans, sans-serif',
  color: '#2B0A10',
} as const

// ── KPI stat card ──────────────────────────────────────────────────────────
export function StatCard({ label, value, delta, icon }: {
  label: string; value: string; delta?: { pct: number; dir: 'up' | 'down' | 'flat' }; icon?: ReactNode
}) {
  return (
    <div className="rounded-xl border-[1.5px] border-rose-border bg-surface-raised px-5 py-4">
      <div className="mb-1 inline-flex items-center text-[10px] font-medium uppercase tracking-[0.09em] text-text-tertiary">{icon && <span className="mr-1.5 inline-flex text-clay-muted" aria-hidden="true">{icon}</span>}{label}</div>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-heading text-[22px] font-medium leading-[1.2] text-oxblood">{value}</span>
        {delta && delta.dir !== 'flat' && (
          <span className={cn('whitespace-nowrap text-[11px] font-semibold', delta.dir === 'up' ? 'text-success-strong' : 'text-danger')}>
            {delta.dir === 'up' ? '▲' : '▼'} {Math.abs(delta.pct)}%
          </span>
        )}
      </div>
    </div>
  )
}

// ── Panel wrapper ────────────────────────────────────────────────────────────
export function ChartPanel({ title, legend, children }: { title: string; legend?: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-xl border-[1.5px] border-rose-border bg-surface-raised px-5 py-4">
      <div className="mb-[0.85rem] flex items-center justify-between gap-2">
        <h3 className="font-heading text-sm font-medium text-oxblood">{title}</h3>
        {legend}
      </div>
      {children}
    </div>
  )
}

// ── Revenue + orders bar chart (dual axis) ───────────────────────────────────
export function RevenueBarChart({ data, revenueLabel, ordersLabel }: {
  data: { label: string; revenue: number; orders: number }[]; revenueLabel: string; ordersLabel: string
}) {
  const showSecondary = ordersLabel !== ''
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data} margin={{ top: 8, right: 4, left: -16, bottom: 0 }} barGap={2}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: AXIS }} axisLine={{ stroke: GRID }} tickLine={false} />
        <YAxis yAxisId="rev" tick={{ fontSize: 11, fill: AXIS }} axisLine={false} tickLine={false} allowDecimals={false} />
        {showSecondary && <YAxis yAxisId="ord" orientation="right" tick={{ fontSize: 11, fill: AXIS }} axisLine={false} tickLine={false} allowDecimals={false} />}
        <Tooltip contentStyle={tooltipStyle} cursor={{ fill: '#F5E6E8' }} />
        <Legend wrapperStyle={{ fontSize: 12, fontFamily: 'DM Sans, sans-serif' }} />
        <Bar yAxisId="rev" dataKey="revenue" name={revenueLabel} fill={OXBLOOD} radius={[3, 3, 0, 0]} maxBarSize={28} />
        {showSecondary && <Bar yAxisId="ord" dataKey="orders" name={ordersLabel} fill={GOLD} radius={[3, 3, 0, 0]} maxBarSize={28} />}
      </BarChart>
    </ResponsiveContainer>
  )
}

// ── Donut chart ──────────────────────────────────────────────────────────────
export function DonutCard({ data }: { data: { name: string; value: number }[] }) {
  const total = data.reduce((s, d) => s + d.value, 0)
  if (total <= 0) return <p className="text-[13px] text-text-tertiary italic">—</p>
  return (
    <div className="flex flex-col gap-3">
      {/* A single 100% slice renders as a degenerate zero-arc in recharts, so draw it as a plain CSS ring. */}
      {data.length === 1 ? (
        <div className="mx-auto my-2 h-40 w-40 rounded-full border-[28px] border-solid" style={{ borderColor: CHART_COLORS[0] }} />
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" innerRadius={52} outerRadius={80} paddingAngle={2} stroke="none">
              {data.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
            </Pie>
            <Tooltip contentStyle={tooltipStyle} />
          </PieChart>
        </ResponsiveContainer>
      )}
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {data.map((d, i) => (
          <li key={d.name} className="flex items-center gap-2 text-xs">
            <span className="h-[9px] w-[9px] shrink-0 rounded-full" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
            <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-ink">{d.name}</span>
            <span className="shrink-0 font-semibold text-rose-muted">{Math.round((d.value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── Breakdown list (label + bar + value) ─────────────────────────────────────
export function BreakdownList({ rows }: { rows: { label: string; value: string; pct: number }[] }) {
  if (rows.length === 0) return <p className="text-[13px] text-text-tertiary italic">—</p>
  return (
    <ul className="m-0 flex list-none flex-col gap-[10px] p-0">
      {rows.map((r, i) => (
        <li key={r.label} className="flex items-center gap-[10px] text-xs">
          <span className="flex-[0_0_32%] overflow-hidden text-ellipsis whitespace-nowrap text-ink">{r.label}</span>
          <span className="h-2 flex-1 overflow-hidden rounded-xs bg-surface-sunken">
            <span className="block h-full min-w-[3px] rounded-xs" style={{ width: `${r.pct}%`, background: CHART_COLORS[i % CHART_COLORS.length] }} />
          </span>
          <span className="w-18 shrink-0 whitespace-nowrap text-right font-semibold text-rose-muted">{r.value}</span>
        </li>
      ))}
    </ul>
  )
}
