import { useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { useSession } from '../SessionContext'
import { usePageVariants } from '../motion'
import DashboardShell, { type NavItem } from '../components/DashboardShell'
import AdminOverview from './AdminOverview'
import AdminMerchants from './AdminMerchants'

const SECTIONS = [
  { key: 'overview',  en: 'Overview',  zh: '概览', icon: '📊' },
  { key: 'merchants', en: 'Merchants', zh: '商家', icon: '🏪' },
]

export default function AdminHome() {
  const { t } = useSession()
  const [section, setSection] = useState<string>('overview')
  const variants = usePageVariants()

  const nav: NavItem[] = SECTIONS.map(s => ({ key: s.key, label: t(s.en, s.zh), icon: s.icon }))

  return (
    <DashboardShell
      logo="BiteTime"
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
        </motion.div>
      </AnimatePresence>
    </DashboardShell>
  )
}
