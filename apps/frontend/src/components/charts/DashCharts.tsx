import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  PieChart, Pie, Cell,
} from 'recharts'
import type { ReactNode } from 'react'

/* Recharts takes colours as props, not classes, so these cannot ride the token
   indirection the rest of the app uses — they are literals by necessity and must be
   updated by hand whenever tokens.css moves. The series palette is in ./chartColors. */
import { CHART_COLORS } from './chartColors'
const OXBLOOD = '#7A1028'   // --brand-500
const ACCENT_2 = '#D4708A'  // --brand-400
const AXIS = '#71717A'      // --ink-500
const GRID = '#E4E4E7'      // --ink-200

const tooltipStyle = {
  background: '#FFFFFF',              // --white
  border: '0.5px solid #E4E4E7',      // --ink-200
  borderRadius: 4,                    // --radius-md
  fontSize: 12,
  fontFamily: 'Poppins, system-ui, sans-serif',
  color: '#18181B',                   // --ink-900
} as const

// ── KPI stat card — lives in ./StatCard so it can be imported without Recharts.
export { StatCard } from './StatCard'

// ── ChartPanel and BreakdownList live in ./Panels (no Recharts) and are re-exported here.
export { ChartPanel, BreakdownList } from './Panels'

// ── Revenue + orders bar chart (dual axis) ───────────────────────────────────
export function RevenueBarChart({ data, revenueLabel, ordersLabel }: {
  data: { label: string; range?: string; revenue: number; orders: number }[]; revenueLabel: string; ordersLabel: string
}) {
  const showSecondary = ordersLabel !== ''
  // Weekly bars carry a `range`; the axis can only fit the week's first day, so the
  // tooltip is where the merchant finds out the bar is seven days wide.
  const tooltipLabel = (label: unknown, payload: readonly { payload?: { range?: string } }[]) =>
    payload?.[0]?.payload?.range ?? String(label ?? '')
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data} margin={{ top: 8, right: 4, left: -16, bottom: 0 }} barGap={2}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: AXIS }} axisLine={{ stroke: GRID }} tickLine={false} />
        <YAxis yAxisId="rev" tick={{ fontSize: 11, fill: AXIS }} axisLine={false} tickLine={false} allowDecimals={false} />
        {showSecondary && <YAxis yAxisId="ord" orientation="right" tick={{ fontSize: 11, fill: AXIS }} axisLine={false} tickLine={false} allowDecimals={false} />}
        <Tooltip contentStyle={tooltipStyle} cursor={{ fill: '#F4F4F5' }} labelFormatter={tooltipLabel} />
        <Legend wrapperStyle={{ fontSize: 12, fontFamily: 'Poppins, system-ui, sans-serif' }} />
        <Bar yAxisId="rev" dataKey="revenue" name={revenueLabel} fill={OXBLOOD} radius={[3, 3, 0, 0]} maxBarSize={28} />
        {showSecondary && <Bar yAxisId="ord" dataKey="orders" name={ordersLabel} fill={ACCENT_2} radius={[3, 3, 0, 0]} maxBarSize={28} />}
      </BarChart>
    </ResponsiveContainer>
  )
}

// ── Donut chart ──────────────────────────────────────────────────────────────
export function DonutCard({ data }: { data: { name: string; value: number }[] }) {
  const total = data.reduce((s, d) => s + d.value, 0)
  if (total <= 0) return <p className="text-[13px] text-muted-foreground italic">—</p>
  return (
    <div className="flex flex-col gap-3">
      {/* A single 100% slice renders as a degenerate zero-arc in recharts, so draw it as a plain CSS ring. */}
      {data.length === 1 ? (
        <div className="mx-auto my-2 h-40 w-40 rounded-pill border-[28px] border-solid" style={{ borderColor: CHART_COLORS[0] }} />
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
            <span className="h-[9px] w-[9px] shrink-0 rounded-pill" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
            <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-foreground">{d.name}</span>
            <span className="shrink-0 font-semibold text-muted-foreground">{Math.round((d.value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

