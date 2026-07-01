import { useEffect, useState } from 'react'
import { ReceiptText, Wallet, Users, TrendingUp } from 'lucide-react'
import { useSession } from '../SessionContext'
import { fetchMerchantOrders, fetchProducts, fetchMerchantCustomers, fetchMerchantVouchers } from '../store'
import { SkeletonText } from '../components/Loaders'
import { StatCard, ChartPanel, RevenueBarChart, DonutCard, BreakdownList } from '../components/charts/DashCharts'
import { computeMerchantStats, type MerchantStats } from './overviewStats'
import { formatMoney } from '../currency'

const STAT_ICON = { size: 15, strokeWidth: 1.75 }

export default function Overview() {
  const { t, merchant } = useSession()
  const [stats, setStats] = useState<MerchantStats | null>(null)
  // Aggregates render in the merchant's current currency — safe because currency
  // is locked once ≥1 order exists, so totals never mix units.
  const money = (n: number) => formatMoney(n, merchant?.currency)

  useEffect(() => {
    const id = merchant?.id
    if (!id) return
    let active = true
    Promise.all([
      fetchMerchantOrders(id),
      fetchProducts(id),
      fetchMerchantCustomers(id),
      fetchMerchantVouchers(id),
    ]).then(([orders, products, customers, vouchers]) => {
      if (active) setStats(computeMerchantStats(orders, products, customers, vouchers))
    })
    return () => { active = false }
  }, [merchant?.id])

  const statusLabel = (s: string) => ({
    new: t('New', '新订单'), preparing: t('Preparing', '准备中'), ready: t('Ready', '待取'),
    completed: t('Completed', '已完成'), cancelled: t('Cancelled', '已取消'),
  } as Record<string, string>)[s] ?? s

  if (!stats) return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-4 gap-[10px] max-[900px]:grid-cols-2 max-[520px]:grid-cols-1">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl border-[1.5px] border-rose-border bg-surface-raised px-5 py-4"><SkeletonText lines={2} /></div>
        ))}
      </div>
      <div className="rounded-xl border-[1.5px] border-rose-border bg-surface-raised px-5 py-4"><SkeletonText lines={6} /></div>
    </div>
  )

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-4 gap-[10px] max-[900px]:grid-cols-2 max-[520px]:grid-cols-1">
        <StatCard label={t('Total orders', '总订单')} value={String(stats.totalOrders)} delta={stats.ordersDelta} icon={<ReceiptText {...STAT_ICON} />} />
        <StatCard label={t('Revenue', '营收')} value={money(stats.revenue)} delta={stats.revenueDelta} icon={<Wallet {...STAT_ICON} />} />
        <StatCard label={t('Customers', '顾客')} value={String(stats.customerCount)} icon={<Users {...STAT_ICON} />} />
        <StatCard label={t('Avg order', '平均订单')} value={money(stats.avgOrder)} icon={<TrendingUp {...STAT_ICON} />} />
      </div>

      <ChartPanel title={t('Revenue — last 12 days', '营收 — 近12天')}>
        <RevenueBarChart data={stats.daily} revenueLabel={t('Revenue', '营收')} ordersLabel={t('Orders', '订单')} />
      </ChartPanel>

      <div className="grid grid-cols-2 gap-5 max-[900px]:grid-cols-1">
        <ChartPanel title={t('Revenue by product', '产品营收')}>
          <DonutCard data={stats.productRevenue} />
        </ChartPanel>
        <ChartPanel title={t('Orders by status', '订单状态')}>
          <BreakdownList rows={stats.statusBreakdown.map(s => ({ label: statusLabel(s.status), value: String(s.count), pct: s.pct }))} />
        </ChartPanel>
      </div>
    </div>
  )
}
