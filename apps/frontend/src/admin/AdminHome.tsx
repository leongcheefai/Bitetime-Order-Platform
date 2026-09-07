import { useSession } from '../SessionContext'
import { useEnterTransition } from '../motion'
import { useDynamicDocumentTitle } from '../documentMeta'
import { useDashboardSection } from '../useDashboardSection'
import { LayoutDashboard, Store, MessageSquare, Star, Megaphone } from 'lucide-react'
import DashboardShell, { type NavItem } from '../components/DashboardShell'
import AdminOverview from './AdminOverview'
import AdminMerchants from './AdminMerchants'
import AdminFeedback from './AdminFeedback'
import AdminTrialFeedback from './AdminTrialFeedback'
import AdminReleases from './AdminReleases'

const ICON = { size: 18, strokeWidth: 1.75 }
const SECTIONS = [
  { key: 'overview',  en: 'Overview',  zh: '概览', icon: <LayoutDashboard {...ICON} /> },
  { key: 'merchants', en: 'Merchants', zh: '商家', icon: <Store {...ICON} /> },
  { key: 'feedback',  en: 'Feedback',  zh: '反馈', icon: <MessageSquare {...ICON} /> },
  { key: 'trial-feedback', en: 'Trial feedback', zh: '试用反馈', icon: <Star {...ICON} /> },
  { key: 'releases', en: 'Releases', zh: '更新日志', icon: <Megaphone {...ICON} /> },
]

export default function AdminHome() {
  const { t } = useSession()
  const [section, setSection] = useDashboardSection(SECTIONS.map(s => s.key), 'overview')
  const enter = useEnterTransition()

  const nav: NavItem[] = SECTIONS.map(s => ({ key: s.key, label: t(s.en, s.zh), icon: s.icon }))
  const sectionLabel = SECTIONS.find(s => s.key === section)
  useDynamicDocumentTitle(
    `${sectionLabel ? t(sectionLabel.en, sectionLabel.zh) : section} — ${t('Platform admin', '平台管理')} | TinyOrder`,
  )

  return (
    <DashboardShell
      title={t('Platform admin', '平台管理')}
      role={t('Superadmin', '超级管理员')}
      nav={nav}
      active={section}
      onSelect={setSection}
    >
      <div key={section} {...enter}>
        {section === 'overview'  && <AdminOverview />}
        {section === 'merchants' && <AdminMerchants />}
        {section === 'feedback'  && <AdminFeedback />}
        {section === 'trial-feedback' && <AdminTrialFeedback />}
        {section === 'releases' && <AdminReleases />}
      </div>
    </DashboardShell>
  )
}
