import { Suspense, lazy, type ComponentProps } from 'react'
import { SkeletonText } from '../Loaders'

/**
 * The two Recharts charts, behind a lazy boundary each. Recharts is the largest chunk in the
 * build (389KB), and the Overview imported it statically — so a merchant's KPI cards, which
 * need no chart, waited on the whole library before painting. Wrapped here rather than at the
 * call sites so every dashboard that draws a chart splits the same way. Both boundaries point
 * at the same module, so the chunk downloads once.
 */
const LazyRevenueBarChart = lazy(() => import('./DashCharts').then(m => ({ default: m.RevenueBarChart })))
const LazyDonutCard = lazy(() => import('./DashCharts').then(m => ({ default: m.DonutCard })))

export function RevenueBarChart(props: ComponentProps<typeof LazyRevenueBarChart>) {
  return (
    <Suspense fallback={<div className="h-[240px]"><SkeletonText lines={5} /></div>}>
      <LazyRevenueBarChart {...props} />
    </Suspense>
  )
}

export function DonutCard(props: ComponentProps<typeof LazyDonutCard>) {
  return (
    <Suspense fallback={<div className="h-[200px]"><SkeletonText lines={4} /></div>}>
      <LazyDonutCard {...props} />
    </Suspense>
  )
}
