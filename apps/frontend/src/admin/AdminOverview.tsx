import { useEffect, useState } from 'react'
import { Store, CircleCheck, Clock, Ban } from 'lucide-react'
import { useSession } from '../SessionContext'
import { fetchAllMerchants } from '../store'
import { SkeletonText } from '../components/Loaders'
import { StatCard, ChartPanel, RevenueBarChart, DonutCard, BreakdownList } from '../components/charts/DashCharts'
import { computeAdminStats, type AdminStats } from './adminStats'

const STAT_ICON = { size: 15, strokeWidth: 1.75 }

export default function AdminOverview() {
  const { t } = useSession()
  const [stats, setStats] = useState<AdminStats | null>(null)

  useEffect(() => {
    let active = true
    fetchAllMerchants().then(ms => { if (active) setStats(computeAdminStats(ms)) })
    return () => { active = false }
  }, [])

  const statusLabel = (s: string) => ({
    active: t('Active', '已激活'), pending: t('Pending', '待审核'), suspended: t('Suspended', '已暂停'),
  } as Record<string, string>)[s] ?? s

  if (!stats) return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 min-[520px]:grid-cols-2 min-[900px]:grid-cols-4 gap-[10px]">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-surface-raised border-[1.5px] border-rose-border rounded-xl py-4 px-5">
            <SkeletonText lines={2} />
          </div>
        ))}
      </div>
      <div className="bg-surface-raised border-[1.5px] border-rose-border rounded-xl py-4 px-5">
        <SkeletonText lines={6} />
      </div>
    </div>
  )

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 min-[520px]:grid-cols-2 min-[900px]:grid-cols-4 gap-[10px]">
        <StatCard label={t('Total merchants', '商家总数')} value={String(stats.total)} icon={<Store {...STAT_ICON} />} />
        <StatCard label={t('Active', '已激活')} value={String(stats.active)} icon={<CircleCheck {...STAT_ICON} />} />
        <StatCard label={t('Pending', '待审核')} value={String(stats.pending)} icon={<Clock {...STAT_ICON} />} />
        <StatCard label={t('Suspended', '已暂停')} value={String(stats.suspended)} icon={<Ban {...STAT_ICON} />} />
      </div>

      <ChartPanel title={t('Sign-ups — last 6 months', '注册 — 近6个月')}>
        <RevenueBarChart
          data={stats.signups.map(p => ({ label: p.label, revenue: p.count, orders: 0 }))}
          revenueLabel={t('Sign-ups', '注册')}
          ordersLabel=""
        />
      </ChartPanel>

      <div className="grid grid-cols-1 min-[900px]:grid-cols-2 gap-5">
        <ChartPanel title={t('Merchants by status', '商家状态')}>
          <DonutCard data={stats.statusBreakdown.map(s => ({ name: statusLabel(s.status), value: s.count }))} />
        </ChartPanel>
        <ChartPanel title={t('Recent sign-ups', '最近注册')}>
          {stats.recent.length === 0
            ? <p className="text-[13px] text-text-tertiary italic">{t('No merchants yet.', '暂无商家。')}</p>
            : <BreakdownList rows={stats.recent.map(m => ({
                label: m.name,
                value: statusLabel(m.status),
                pct: 100,
              }))} />}
        </ChartPanel>
      </div>
    </div>
  )
}
