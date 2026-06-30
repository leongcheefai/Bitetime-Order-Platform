import { useEffect, useState } from 'react'
import { ReceiptText, Wallet, Users, TrendingUp } from 'lucide-react'
import { useSession } from '../SessionContext'
import { fetchMerchantOrders, fetchProducts, fetchMerchantCustomers, fetchMerchantVouchers } from '../store'
import { SkeletonText } from '../components/Loaders'
import { StatCard, ChartPanel, RevenueBarChart, DonutCard, BreakdownList } from '../components/charts/DashCharts'
import { computeMerchantStats, type MerchantStats } from './overviewStats'

const money = (n: number) => 'RM ' + n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const STAT_ICON = { size: 15, strokeWidth: 1.75 }

export default function Overview() {
  const { t, merchant } = useSession()
  const [stats, setStats] = useState<MerchantStats | null>(null)

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
    <div className="dashboard-panel">
      <div className="dash-stat-grid dash-stat-grid--4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="dash-stat-card"><SkeletonText lines={2} /></div>
        ))}
      </div>
      <div className="dash-section"><SkeletonText lines={6} /></div>
    </div>
  )

  return (
    <div className="dashboard-panel">
      <div className="dash-stat-grid dash-stat-grid--4">
        <StatCard label={t('Total orders', '总订单')} value={String(stats.totalOrders)} delta={stats.ordersDelta} icon={<ReceiptText {...STAT_ICON} />} />
        <StatCard label={t('Revenue', '营收')} value={money(stats.revenue)} delta={stats.revenueDelta} icon={<Wallet {...STAT_ICON} />} />
        <StatCard label={t('Customers', '顾客')} value={String(stats.customerCount)} icon={<Users {...STAT_ICON} />} />
        <StatCard label={t('Avg order', '平均订单')} value={money(stats.avgOrder)} icon={<TrendingUp {...STAT_ICON} />} />
      </div>

      <ChartPanel title={t('Revenue — last 12 days', '营收 — 近12天')}>
        <RevenueBarChart data={stats.daily} revenueLabel={t('Revenue', '营收')} ordersLabel={t('Orders', '订单')} />
      </ChartPanel>

      <div className="dash-two-col">
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
