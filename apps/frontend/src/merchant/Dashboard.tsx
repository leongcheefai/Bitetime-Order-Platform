import { motion, AnimatePresence } from 'motion/react'
import { useSession } from '../SessionContext'
import { usePageVariants } from '../motion'
import { LayoutDashboard, ReceiptText, Cake, Ticket, Users, Settings } from 'lucide-react'
import DashboardShell, { type NavItem } from '../components/DashboardShell'
import Overview from './Overview'
import ProductsManager from './ProductsManager'
import VouchersManager from './VouchersManager'
import ShopSettings from './ShopSettings'
import OrdersView from './OrdersView'
import CustomersView from './CustomersView'
import { NavGuardProvider, useNavGuard } from './NavGuard'
import { useDashboardSection } from '../useDashboardSection'

const ICON = { size: 18, strokeWidth: 1.75 }
const SECTIONS = [
  { key: 'overview',  en: 'Overview',  zh: '概览',  icon: <LayoutDashboard {...ICON} /> },
  { key: 'orders',    en: 'Orders',    zh: '订单',  icon: <ReceiptText {...ICON} /> },
  { key: 'products',  en: 'Products',  zh: '产品',  icon: <Cake {...ICON} /> },
  { key: 'vouchers',  en: 'Vouchers',  zh: '优惠券', icon: <Ticket {...ICON} /> },
  { key: 'customers', en: 'Customers', zh: '顾客',  icon: <Users {...ICON} /> },
  { key: 'settings',  en: 'Settings',  zh: '设置',  icon: <Settings {...ICON} /> },
]

export default function Dashboard() {
  return (
    <NavGuardProvider>
      <DashboardInner />
    </NavGuardProvider>
  )
}

function DashboardInner() {
  const { t, merchant, role } = useSession()
  const { guard } = useNavGuard()
  const [section, setSection] = useDashboardSection(SECTIONS.map(s => s.key), 'overview')
  const variants = usePageVariants()

  const nav: NavItem[] = SECTIONS.map(s => ({ key: s.key, label: t(s.en, s.zh), icon: s.icon }))

  // Route sidebar section switches through the unsaved-changes guard so a dirty
  // Settings tab cannot be silently discarded by navigating away.
  const selectSection = (key: string) => guard(() => setSection(key))

  return (
    <DashboardShell
      logo="BiteTime"
      title={merchant!.name}
      role={role === 'superadmin' ? t('Viewing as shop', '以店铺身份查看') : t('Merchant', '商家')}
      nav={nav}
      active={section}
      onSelect={selectSection}
      userName={`/s/${merchant!.slug}`}
      backTo={role === 'superadmin' ? { href: '/admin/merchants', label: t('Back to admin', '返回管理') } : undefined}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={section} variants={variants} initial="initial" animate="animate" exit="exit">
          {section === 'overview'  && <Overview />}
          {section === 'orders'    && <OrdersView />}
          {section === 'products'  && <ProductsManager />}
          {section === 'vouchers'  && <VouchersManager />}
          {section === 'customers' && <CustomersView />}
          {section === 'settings'  && <ShopSettings />}
        </motion.div>
      </AnimatePresence>
    </DashboardShell>
  )
}
