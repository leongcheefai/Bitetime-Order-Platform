import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  PieChart, Pie, Cell,
} from 'recharts'
import type { ReactNode } from 'react'

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
    <div className="dash-stat-card">
      <div className="dash-stat-label">{icon && <span className="dash-stat-icon" aria-hidden="true">{icon}</span>}{label}</div>
      <div className="dash-stat-value-row">
        <span className="dash-stat-value">{value}</span>
        {delta && delta.dir !== 'flat' && (
          <span className={`dash-stat-delta dash-stat-delta--${delta.dir}`}>
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
    <div className="dash-section">
      <div className="dash-section-head">
        <h3 className="dash-section-title">{title}</h3>
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
  if (total <= 0) return <p className="empty-msg">—</p>
  return (
    <div className="dash-donut">
      {/* A single 100% slice renders as a degenerate zero-arc in recharts, so draw it as a plain CSS ring. */}
      {data.length === 1 ? (
        <div className="dash-donut-single" style={{ borderColor: CHART_COLORS[0] }} />
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
      <ul className="dash-donut-legend">
        {data.map((d, i) => (
          <li key={d.name}>
            <span className="dash-donut-dot" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
            <span className="dash-donut-name">{d.name}</span>
            <span className="dash-donut-pct">{Math.round((d.value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── Breakdown list (label + bar + value) ─────────────────────────────────────
export function BreakdownList({ rows }: { rows: { label: string; value: string; pct: number }[] }) {
  if (rows.length === 0) return <p className="empty-msg">—</p>
  return (
    <ul className="dash-breakdown">
      {rows.map((r, i) => (
        <li key={r.label}>
          <span className="dash-breakdown-label">{r.label}</span>
          <span className="dash-breakdown-track">
            <span className="dash-breakdown-fill" style={{ width: `${r.pct}%`, background: CHART_COLORS[i % CHART_COLORS.length] }} />
          </span>
          <span className="dash-breakdown-value">{r.value}</span>
        </li>
      ))}
    </ul>
  )
}
