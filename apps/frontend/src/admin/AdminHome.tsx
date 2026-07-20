import { motion, AnimatePresence } from 'motion/react'
import { useSession } from '../SessionContext'
import { usePageVariants } from '../motion'
import { useDashboardSection } from '../useDashboardSection'
import { LayoutDashboard, Store, MessageSquare } from 'lucide-react'
import DashboardShell, { type NavItem } from '../components/DashboardShell'
import AdminOverview from './AdminOverview'
import AdminMerchants from './AdminMerchants'
import AdminFeedback from './AdminFeedback'

const ICON = { size: 18, strokeWidth: 1.75 }
const SECTIONS = [
  { key: 'overview',  en: 'Overview',  zh: '概览', icon: <LayoutDashboard {...ICON} /> },
  { key: 'merchants', en: 'Merchants', zh: '商家', icon: <Store {...ICON} /> },
  { key: 'feedback',  en: 'Feedback',  zh: '反馈', icon: <MessageSquare {...ICON} /> },
]

export default function AdminHome() {
  const { t } = useSession()
  const [section, setSection] = useDashboardSection(SECTIONS.map(s => s.key), 'overview')
  const variants = usePageVariants()

  const nav: NavItem[] = SECTIONS.map(s => ({ key: s.key, label: t(s.en, s.zh), icon: s.icon }))

  return (
    <DashboardShell
      logo="TinyOrder"
      title={t('Platform admin', '平台管理')}
      role={t('Superadmin', '超级管理员')}
      nav={nav}
      active={section}
      onSelect={setSection}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={section} variants={variants} initial="initial" animate="animate" exit="exit">
          {section === 'overview'  && <AdminOverview />}
          {section === 'merchants' && <AdminMerchants />}
          {section === 'feedback'  && <AdminFeedback />}
        </motion.div>
      </AnimatePresence>
    </DashboardShell>
  )
}
