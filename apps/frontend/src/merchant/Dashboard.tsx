import { useCallback, useEffect, useState } from 'react'
import { useSession } from '../SessionContext'
import { fetchMerchantOrders } from '../store'
import { useEnterTransition } from '../motion'
import { LayoutDashboard, ReceiptText, Cake, Ticket, Users, Settings } from 'lucide-react'
import DashboardShell, { type NavItem } from '../components/DashboardShell'
import BillingBanner from './BillingBanner'
import DeactivatedVouchers from './DeactivatedVouchers'
import Overview from './Overview'
import OnboardingChecklist from './OnboardingChecklist'
import ProductsManager from './ProductsManager'
import VouchersManager from './VouchersManager'
import ShopSettings from './ShopSettings'
import OrdersView from './OrdersView'
import CustomersView from './CustomersView'
import FeedbackFab from './FeedbackFab'
import { NavGuardProvider, useNavGuard } from './NavGuard'
import { UpgradeNavProvider } from './UpgradeNav'
import { useDashboardSection } from '../useDashboardSection'
import { useProAccess } from '../plan'
import { ProLock } from './ProLock'

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
  const pro = useProAccess()
  const [section, setSection] = useDashboardSection(SECTIONS.map(s => s.key), 'overview')
  const enter = useEnterTransition()

  // Count of pending "new" orders — surfaced as a badge on the Orders nav item.
  // Refetched whenever an order's status changes so the badge stays live.
  const [newOrders, setNewOrders] = useState(0)
  const refreshNewOrders = useCallback(() => {
    const id = merchant?.id
    if (!id) return
    fetchMerchantOrders(id).then(orders => {
      setNewOrders(orders.filter(o => (o.status ?? 'new') === 'new').length)
    })
  }, [merchant?.id])
  useEffect(() => { refreshNewOrders() }, [refreshNewOrders])

  const nav: NavItem[] = SECTIONS.map(s => ({
    key: s.key,
    label: t(s.en, s.zh),
    icon: s.icon,
    badge: s.key === 'orders' ? newOrders : undefined,
    // The lock must be legible from the sidebar, not only after clicking (#110).
    tag: s.key === 'vouchers' && !pro ? 'Pro' : undefined,
  }))

  // Route sidebar section switches through the unsaved-changes guard so a dirty
  // Settings tab cannot be silently discarded by navigating away.
  const selectSection = useCallback((key: string) => guard(() => setSection(key)), [guard, setSection])

  // Same guard, but aimed at a sub-tab and reporting back once the merchant has actually let
  // the navigation happen (#112).
  // Bumping this remounts the Settings subtree, which is the ONLY way a sub-tab request lands:
  // ShopSettings reads its tab from the hash in a `useState` initialiser, so it must be
  // re-mounted to see a new one. A three-file contract (here, useDashboardSubsection,
  // ShopSettings) — change one and check the others.
  //
  // Inside `guard`, so a cancelled confirm neither navigates nor discards the merchant's edits.
  const [settingsRemounts, setSettingsRemounts] = useState(0)
  const goToSettingsTab = useCallback(
    (sub: string) => guard(() => {
      setSection('settings', sub)
      setSettingsRemounts(n => n + 1)
    }),
    [guard, setSection],
  )

  return (
    // Pro locks anywhere below can ask for Settings → Subscription (#112); handing them the
    // GUARDED switch is what stops an upgrade CTA discarding a half-typed Shipping form.
    <UpgradeNavProvider navigate={goToSettingsTab}>
    <DashboardShell
      title={merchant!.name}
      role={role === 'superadmin' ? t('Viewing as shop', '以店铺身份查看') : t('Merchant', '商家')}
      nav={nav}
      active={section}
      onSelect={selectSection}
      backTo={role === 'superadmin' ? { href: '/admin/merchants', label: t('Back to admin', '返回管理') } : undefined}
    >
      <BillingBanner />
      <OnboardingChecklist section={section} onNavigate={selectSection} />
      <div key={section === 'settings' ? `settings:${settingsRemounts}` : section} {...enter}>
        {section === 'overview'  && <Overview />}
        {section === 'orders'    && <OrdersView onOrdersChanged={refreshNewOrders} />}
        {section === 'products'  && <ProductsManager />}
        {/* Vouchers are Pro-only (#110). The nav entry stays — a basic shop must see the
            feature it is not paying for, not wonder where it went — but the section itself
            is the upgrade prompt. The backend refuses the writes either way. */}
        {section === 'vouchers'  && (pro
          ? <VouchersManager />
          : <>
              <ProLock
                what={t('Vouchers', '优惠券')}
                why={t('Run promotions with discount codes your customers enter at checkout. Available on the Pro plan.',
                  '使用折扣码开展促销，顾客可在结账时输入。Pro 方案专享。')}
              />
              {/* A shop that USED to be Pro has codes in customers' hands that no longer redeem.
                  The lock alone would hide exactly the thing it needs to explain, and the
                  merchant would hear about it from a complaint instead. Renders nothing for a
                  shop that was never Pro. */}
              <DeactivatedVouchers />
            </>)}
        {section === 'customers' && <CustomersView />}
        {section === 'settings'  && <ShopSettings />}
      </div>
      <FeedbackFab />
    </DashboardShell>
    </UpgradeNavProvider>
  )
}
