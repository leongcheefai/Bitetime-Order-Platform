import type { ReactNode } from 'react'
import { CHART_COLORS } from './chartColors'

/**
 * The chart chrome that needs no Recharts: the titled panel and the label + bar + value list.
 * Split from DashCharts.tsx so the Overview can paint its KPI cards, panel titles and breakdowns
 * the moment its data lands, and only the two Recharts charts (see ./lazy.tsx) wait on the
 * 389KB chart chunk. DashCharts re-exports both, so nothing that imported them there moved.
 */
export function ChartPanel({ title, legend, children }: { title: string; legend?: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-xl border-[0.5px] border-border bg-card px-5 py-4">
      <div className="mb-[0.85rem] flex items-center justify-between gap-2">
        <h3 className="font-heading text-sm font-medium text-primary">{title}</h3>
        {legend}
      </div>
      {children}
    </div>
  )
}

// ── Breakdown list (label + bar + value) ─────────────────────────────────────
export function BreakdownList({ rows }: { rows: { label: string; value: string; pct: number }[] }) {
  if (rows.length === 0) return <p className="text-[13px] text-muted-foreground italic">—</p>
  return (
    <ul className="m-0 flex list-none flex-col gap-[10px] p-0">
      {rows.map((r, i) => (
        <li key={r.label} className="flex items-center gap-[10px] text-xs">
          <span className="flex-[0_0_32%] overflow-hidden text-ellipsis whitespace-nowrap text-foreground" title={r.label}>{r.label}</span>
          <span className="h-2 flex-1 overflow-hidden rounded-xs bg-muted">
            <span className="block h-full min-w-[3px] rounded-xs" style={{ width: `${r.pct}%`, background: CHART_COLORS[i % CHART_COLORS.length] }} />
          </span>
          <span className="w-18 shrink-0 whitespace-nowrap text-right font-semibold text-muted-foreground">{r.value}</span>
        </li>
      ))}
    </ul>
  )
}
