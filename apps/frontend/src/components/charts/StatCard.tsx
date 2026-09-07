import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * KPI stat card. Its own module, NOT in DashCharts.tsx, for one reason: DashCharts imports
 * Recharts at the top, and CustomersView wanted this card and nothing else — so the Customers
 * section was dragging the whole charting library into its chunk to draw four numbers.
 * DashCharts re-exports it, so Overview and AdminOverview read it from the same place as before.
 */
export function StatCard({ label, value, delta, icon }: {
  label: string; value: string; delta?: { pct: number; dir: 'up' | 'down' | 'flat' }; icon?: ReactNode
}) {
  return (
    <div className="rounded-xl border-[0.5px] border-border bg-card px-5 py-4">
      <div className="mb-1 inline-flex items-center text-[10px] font-medium uppercase tracking-[0.09em] text-muted-foreground">{icon && <span className="mr-1.5 inline-flex text-ink-400" aria-hidden="true">{icon}</span>}{label}</div>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-heading text-[22px] font-medium leading-[1.2] text-primary">{value}</span>
        {delta && delta.dir !== 'flat' && (
          <span className={cn('whitespace-nowrap text-[11px] font-semibold', delta.dir === 'up' ? 'text-success-fg' : 'text-danger-fg')}>
            {delta.dir === 'up' ? '▲' : '▼'} {Math.abs(delta.pct)}%
          </span>
        )}
      </div>
    </div>
  )
}
